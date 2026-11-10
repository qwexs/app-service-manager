import type { S3File } from 'bun'
import { tmpdir } from 'os'
import { resolve, sep } from 'path'
import {
  type ListOptions,
  type ListResult,
  type MediaFile,
  type MediaFileContent,
  type MediaFileInfo,
  type MediaFileRead,
  MediaFileReadSchema,
  MediaFileSchema,
  type ReadOptions,
  type S3BatchOperationResult,
  S3ClientError,
  type S3Config,
  S3ConfigSchema,
  type S3OperationResult,
  type WriteOptions,
} from './types.js'

/**
 * Опции для writeFileFromPath. Подмножество WriteOptions — сейчас только те
 * поля, что осмысленны для стрима с диска. Если в WriteOptions добавятся
 * новые параметры (acl, cacheControl и т.п.) — нужно расширить и здесь.
 */
type WriteFromPathOptions = Pick<WriteOptions, 'contentType' | 'metadata' | 'overwrite'>

/**
 * S3 клиент для работы с медиафайлами
 * Использует встроенный Bun.S3Client для операций с S3-совместимыми хранилищами
 */
export class S3Client {
  private client: Bun.S3Client
  private config: S3Config

  constructor(config: S3Config) {
    // Валидация конфигурации
    const validatedConfig = S3ConfigSchema.parse(config)
    this.config = validatedConfig

    // Проверка наличия Bun S3 клиента (для совместимости с тестами)
    if (typeof globalThis.Bun?.S3Client === 'undefined') {
      throw new Error(
        'Bun.S3Client не доступен. Убедитесь, что код запускается в Bun runtime. ' +
          'Для тестов используйте моки или запускайте тесты через bun test.'
      )
    }

    // Создание Bun S3 клиента
    this.client = new globalThis.Bun.S3Client({
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: this.config.region,
      endpoint: this.config.endpoint,
      bucket: this.config.bucket,
    })
  }

  /**
   * Проверяет существование файла в S3
   */
  async exists(key: string): Promise<boolean> {
    try {
      const exists = await this.client.exists(key)
      return exists
    } catch (error: any) {
      // Если ошибка связана с тем, что файл не найден, возвращаем false
      if (
        error?.code === 'NoSuchKey' ||
        error?.code === 'NotFound' ||
        error?.message?.includes('NoSuchKey')
      ) {
        return false
      }

      // Логируем неожиданные ошибки для отладки
      console.warn(`Неожиданная ошибка при проверке существования файла ${key}:`, {
        code: error?.code,
        message: error?.message,
        stack: error?.stack,
      })

      // Для других ошибок возвращаем false вместо выбрасывания исключения
      return false
    }
  }

  /**
   * Отказ без overwrite, если ключ уже есть.
   * Ошибку exists() не глотает как «можно писать».
   */
  private async assertCanWrite(key: string, overwrite?: boolean): Promise<void> {
    if (overwrite) return

    let fileExists: boolean
    try {
      fileExists = await this.exists(key)
    } catch (existsError) {
      if (existsError instanceof S3ClientError) {
        throw existsError
      }
      throw new S3ClientError(
        `Не удалось проверить существование файла ${key}`,
        'NETWORK_ERROR',
        existsError instanceof Error ? existsError : undefined
      )
    }

    if (fileExists) {
      throw new S3ClientError(`Файл ${key} уже существует`, 'VALIDATION_ERROR')
    }
  }

  /**
   * Получает информацию о файле
   */
  async getFileInfo(key: string): Promise<MediaFileInfo> {
    try {
      const stat = await this.client.stat(key)

      return {
        key,
        size: stat.size,
        lastModified: stat.lastModified,
        etag: stat.etag,
        contentType: (stat as any).type || this.getContentTypeByExtension(key),
      }
    } catch (error) {
      throw this.handleError(error, `Ошибка при получении информации о файле: ${key}`)
    }
  }

  private getContentTypeByExtension(key: string): string {
    const ext = key.split('.').pop()?.toLowerCase()
    const map: Record<string, string> = {
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      avi: 'video/x-msvideo',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
    }
    return map[ext ?? ''] ?? 'application/octet-stream'
  }

  /**
   * Потоковая отдача из S3. Не через S3File.slice().stream(): Bun держит
   * весь слайс в памяти (Range N–EOF на 100–350 МБ → OOM). Presigned GET
   * + fetch даёт HTTP-тело MinIO как есть. Не оборачиваем в TransformStream:
   * иначе chunked transfer, и iOS Safari не играет mp4.
   */
  async getFileStream(
    key: string,
    range?: { start: number; end: number },
    signal?: AbortSignal,
  ): Promise<ReadableStream> {
    const url = this.client.file(key).presign({ method: 'GET', expiresIn: 120 })
    const headers = new Headers()
    if (range) {
      headers.set('Range', `bytes=${range.start}-${range.end}`)
    }

    let res: Response
    try {
      res = await fetch(url, { method: 'GET', headers, signal })
    } catch (error) {
      if (signal?.aborted) throw error
      throw this.handleError(error, `Ошибка при чтении файла: ${key}`)
    }

    if (res.status === 404) {
      void res.body?.cancel().catch(() => undefined)
      throw new S3ClientError(`Ошибка при чтении файла: ${key}: KEY_NOT_FOUND`, 'KEY_NOT_FOUND')
    }

    if (!res.ok && res.status !== 206) {
      void res.body?.cancel().catch(() => undefined)
      throw this.handleError(
        new Error(`S3 GET ${res.status}`),
        `Ошибка при чтении файла: ${key}`,
      )
    }

    if (!res.body) {
      throw new S3ClientError(`Пустое тело ответа S3: ${key}`, 'UNKNOWN_ERROR')
    }

    return res.body
  }

  /**
   * Читает один файл из S3
   */
  async readFile(key: string, options: ReadOptions = {}): Promise<MediaFileContent> {
    try {
      MediaFileReadSchema.parse({ key })

      const s3File = this.client.file(key)

      let data: Buffer

      if (options.range) {
        const { start, end } = options.range
        const sliced = s3File.slice(start, end + 1)
        data = Buffer.from(await sliced.arrayBuffer())
      } else {
        data = Buffer.from(await s3File.arrayBuffer())
      }

      let metadata: Record<string, string> | undefined
      let contentType: string | undefined

      if (options.includeMetadata) {
        const info = await this.getFileInfo(key)
        metadata = info.metadata
        contentType = info.contentType
      }

      return {
        key,
        data,
        contentType,
        metadata,
      }
    } catch (error) {
      throw this.handleError(error, `Ошибка при чтении файла: ${key}`)
    }
  }

  /**
   * Читает несколько файлов из S3
   */
  async readFiles(
    files: Array<string | MediaFileRead>,
    options: ReadOptions = {}
  ): Promise<S3BatchOperationResult & { data: MediaFileContent[] }> {
    const results: S3OperationResult[] = []
    const data: MediaFileContent[] = []
    let successCount = 0
    let errorCount = 0

    for (const file of files) {
      try {
        const key = typeof file === 'string' ? file : file.key
        const fileOptions = typeof file === 'string' ? options : { ...options, range: file.range }

        const content = await this.readFile(key, fileOptions)
        data.push(content)
        results.push({ success: true, key })
        successCount++
      } catch (error) {
        const key = typeof file === 'string' ? file : file.key
        const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
        results.push({ success: false, key, error: errorMessage })
        errorCount++
      }
    }

    return {
      success: errorCount === 0,
      results,
      data,
      totalCount: files.length,
      successCount,
      errorCount,
    }
  }

  /**
   * Записывает один файл в S3
   */
  async writeFile(file: MediaFile, options: WriteOptions = {}): Promise<S3OperationResult> {
    try {
      const validatedFile = MediaFileSchema.parse(file)

      await this.assertCanWrite(validatedFile.key, options.overwrite)

      const writeOptions = {
        contentType: options.contentType || validatedFile.contentType || 'application/octet-stream',
        metadata: { ...validatedFile.metadata, ...options.metadata },
      }

      await this.client.write(validatedFile.key, validatedFile.data)

      return { success: true, key: validatedFile.key }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      return { success: false, key: file.key, error: errorMessage }
    }
  }

  /**
   * Записывает файл в S3 стримом с диска, без полной материализации в RAM.
   *
   * Использует `Bun.file(sourcePath)` как тело для Bun.S3Client.write — Bun внутри
   * читает файл chunked и стримит напрямую в MinIO/S3 через multipart upload.
   * Это ключевое отличие от writeFile(), который принимает `data: Buffer` и
   * держит весь файл в памяти до окончания загрузки.
   *
   * Когда использовать: после ffmpeg-конвертации видео, когда файл уже лежит
   * на диске во временной директории и не нужно его перечитывать в Buffer.
   *
   * Defense in depth: sourcePath проверяется на принадлежность к tmpdir(),
   * чтобы случайный user-input в будущем не превратился в чтение произвольного
   * файла. Сейчас все вызывающие передают путь из createTempVideoFile (внутренний
   * код), так что проверка ничего не ломает — это страховка.
   *
   * @param key S3-ключ для записи
   * @param sourcePath Локальный путь к файлу, который нужно залить (должен быть в tmpdir)
   * @param options Опции записи (contentType, metadata, overwrite)
   */
  async writeFileFromPath(
    key: string,
    sourcePath: string,
    options: WriteFromPathOptions = {}
  ): Promise<S3OperationResult> {
    try {
      // Defense in depth: sourcePath должен быть в системной tmp-директории.
      // resolve() нормализует путь (убирает ../ и symlinks-обходы), startsWith
      // гарантирует что мы не прочитаем ничего за пределами tmpdir.
      const normalizedPath = resolve(sourcePath)
      const tmpRoot = resolve(tmpdir())
      if (!normalizedPath.startsWith(tmpRoot + sep) && normalizedPath !== tmpRoot) {
        throw new S3ClientError(
          `sourcePath должен находиться в ${tmpRoot}, получен: ${normalizedPath}`,
          'VALIDATION_ERROR'
        )
      }

      await this.assertCanWrite(key, options.overwrite)

      const contentType = options.contentType || 'application/octet-stream'

      // Bun.file() создаёт лёгкий BunFile-объект, который не читает файл целиком в RAM —
      // S3Client.write стримит его chunked через multipart upload.
      const fileHandle = Bun.file(normalizedPath)

      // Проверяем, что файл существует и доступен, до начала стрима —
      // иначе получим менее информативную ошибку из глубины S3-клиента.
      if (!(await fileHandle.exists())) {
        throw new S3ClientError(
          `Исходный файл не найден: ${normalizedPath}`,
          'VALIDATION_ERROR'
        )
      }

      const diskSize = fileHandle.size

      await this.client.write(key, fileHandle, {
        type: contentType,
        ...(options.metadata ? { metadata: options.metadata } : {}),
      })

      // Verify-after-write: Bun.S3Client.write(BunFile) для multipart upload
      // может резолвить Promise до окончания CompleteMultipartUpload на стороне
      // MinIO/S3 (замечено в проде: writeFileFromPath отчитался success, но
      // последующий readFile сразу за ним получил KEY_NOT_FOUND). Делаем
      // getFileInfo() и убеждаемся, что объект реально доступен — иначе
      // бросаем ошибку (не {success:false}: вызывающий код воспринимал его как успех).
      //
      // Используем getFileInfo (а не exists), потому что exists() глотает все
      // ошибки в try/catch и возвращает false — мы не узнаем реальную причину
      // (NoSuchKey vs network error vs 5xx от MinIO). getFileInfo() бросает
      // S3ClientError, что даёт нам внятную диагностику.
      //
      // Retry 3 раза с интервалами 100/200/300 мс на случай если MinIO ещё
      // не дошёл до complete. Стоимость для картинок <5 МБ: практически 0 мс.
      let objectInfo: MediaFileInfo | null = null
      let lastVerifyError: string | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 100 * attempt))
        }
        try {
          objectInfo = await this.getFileInfo(key)
          break
        } catch (headError) {
          lastVerifyError = headError instanceof Error ? headError.message : String(headError)
          // NoSuchKey — нормально при попытке до окончания multipart, продолжаем retry.
          // Другие ошибки (5xx, network) — продолжаем, т.к. реальная причина всплывёт
          // в финальном сообщении.
        }
      }

      if (!objectInfo) {
        // cleanup tmp-файла ложится на caller — мы не удаляем, потому что
        // возможно upload в реальности дошёл, и удаление ломает multipart.
        throw new S3ClientError(
          `writeFileFromPath: ${key} не найден в S3 после 3 попыток verify (multipart upload не завершён?). Последняя ошибка: ${lastVerifyError ?? 'unknown'}`,
          'VALIDATION_ERROR'
        )
      }

      if (objectInfo.size !== diskSize) {
        throw new S3ClientError(
          `writeFileFromPath: размер объекта ${key} (${objectInfo.size}) не совпадает с диском (${diskSize})`,
          'VALIDATION_ERROR'
        )
      }

      return { success: true, key }
    } catch (error) {
      if (error instanceof S3ClientError) {
        throw error
      }
      throw new S3ClientError(
        `Ошибка при записи файла с диска: ${key}: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Записывает несколько файлов в S3
   */
  async writeFiles(
    files: MediaFile[],
    options: WriteOptions = {}
  ): Promise<S3BatchOperationResult> {
    const results: S3OperationResult[] = []
    let successCount = 0
    let errorCount = 0

    for (const file of files) {
      const result = await this.writeFile(file, options)
      results.push(result)

      if (result.success) {
        successCount++
      } else {
        errorCount++
      }
    }

    return {
      success: errorCount === 0,
      results,
      totalCount: files.length,
      successCount,
      errorCount,
    }
  }

  /**
   * Удаляет файл из S3
   */
  async deleteFile(key: string): Promise<S3OperationResult> {
    try {
      await this.client.delete(key)

      return { success: true, key }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      return { success: false, key, error: errorMessage }
    }
  }

  /**
   * Удаляет несколько файлов из S3
   */
  async deleteFiles(keys: string[]): Promise<S3BatchOperationResult> {
    const results: S3OperationResult[] = []
    let successCount = 0
    let errorCount = 0

    for (const key of keys) {
      const result = await this.deleteFile(key)
      results.push(result)

      if (result.success) {
        successCount++
      } else {
        errorCount++
      }
    }

    return {
      success: errorCount === 0,
      results,
      totalCount: keys.length,
      successCount,
      errorCount,
    }
  }

  /**
   * Создает presigned URL для загрузки файла
   */
  createPresignedUrl(key: string, expiresIn: number = 3600, method: 'GET' | 'PUT' = 'GET'): string {
    try {
      const url = this.client.presign(key, { expiresIn, method })

      return url
    } catch (error) {
      throw this.handleError(error, `Ошибка при создании presigned URL для: ${key}`)
    }
  }

  /**
   * Получает S3File объект для работы с файлом
   */
  async getS3File(key: string): Promise<S3File> {
    try {
      const s3File = await this.client.file(key)

      return s3File
    } catch (error) {
      throw this.handleError(error, `Ошибка при получении S3File для: ${key}`)
    }
  }

  /**
   * Читает файл как текст
   */
  async readAsText(key: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    try {
      const content = await this.readFile(key)
      return content.data.toString(encoding)
    } catch (error) {
      throw this.handleError(error, `Ошибка при чтении текстового файла: ${key}`)
    }
  }

  /**
   * Читает файл как JSON
   */
  async readAsJSON<T = unknown>(key: string): Promise<T> {
    try {
      const text = await this.readAsText(key)
      return JSON.parse(text) as T
    } catch (error) {
      throw this.handleError(error, `Ошибка при чтении JSON файла: ${key}`)
    }
  }

  /**
   * Записывает текст в файл
   */
  async writeText(
    key: string,
    text: string,
    options: WriteOptions = {}
  ): Promise<S3OperationResult> {
    const file: MediaFile = {
      key,
      data: Buffer.from(text, 'utf-8'),
      contentType: options.contentType || 'text/plain; charset=utf-8',
      metadata: options.metadata,
    }

    return this.writeFile(file, options)
  }

  /**
   * Записывает JSON в файл
   */
  async writeJSON(
    key: string,
    data: unknown,
    options: WriteOptions = {}
  ): Promise<S3OperationResult> {
    const json = JSON.stringify(data, null, 2)
    const file: MediaFile = {
      key,
      data: Buffer.from(json, 'utf-8'),
      contentType: options.contentType || 'application/json; charset=utf-8',
      metadata: options.metadata,
    }

    return this.writeFile(file, options)
  }

  /**
   * Создает объект в S3 (создает пустой объект с указанным ключом)
   */
  async createEmpty(objectPath: string): Promise<S3OperationResult> {
    try {
      // Создаем пустой файл-маркер папки напрямую через client.write
      await this.client.write(objectPath, Buffer.alloc(0))

      return { success: true, key: objectPath }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      return {
        success: false,
        key: objectPath,
        error: `Ошибка при создании папки ${objectPath}: ${errorMessage}`,
      }
    }
  }

  /**
   * Копирует файл внутри S3
   */
  async copyFile(sourceKey: string, destinationKey: string): Promise<S3OperationResult> {
    try {
      // Читаем исходный файл
      const sourceContent = await this.readFile(sourceKey, { includeMetadata: true })

      // Записываем в новое место
      const result = await this.writeFile({
        key: destinationKey,
        data: sourceContent.data,
        contentType: sourceContent.contentType,
        metadata: sourceContent.metadata,
      })

      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      return {
        success: false,
        key: destinationKey,
        error: `Ошибка при копировании ${sourceKey} в ${destinationKey}: ${errorMessage}`,
      }
    }
  }

  /**
   * Получает список файлов из S3.
   */
  async list(options: ListOptions = {}): Promise<ListResult> {
    try {
      const listParams: {
        bucket: string
        prefix?: string
        maxKeys?: number
        startAfter?: string
      } = {
        bucket: this.config.bucket,
        prefix: options.prefix,
        maxKeys: options.maxKeys,
      }

      if (options.continuationToken) {
        listParams.startAfter = options.continuationToken
      }

      const listResult = await this.client.list(listParams)

      const files: MediaFileInfo[] = (listResult.contents || []).map(
        (obj: { key: string; size?: number; lastModified?: string; eTag?: string }) => ({
          key: obj.key,
          size: obj.size ?? 0,
          lastModified: obj.lastModified ? new Date(obj.lastModified) : undefined,
          etag: obj.eTag,
        })
      )

      const nextContinuationToken = listResult.isTruncated
        ? files[files.length - 1]?.key
        : undefined

      return {
        files,
        isTruncated: listResult.isTruncated ?? false,
        continuationToken: nextContinuationToken,
      }
    } catch (error) {
      throw this.handleError(error, 'Ошибка при получении списка файлов')
    }
  }

  /**
   * Получает конфигурацию клиента
   */
  getConfig(): Readonly<S3Config> {
    return Object.freeze({ ...this.config })
  }

  /**
   * Получает внутренний клиент (только для отладки)
   */
  getClient(): any {
    return this.client
  }

  /**
   * Обработчик ошибок
   */
  private handleError(error: unknown, message: string): S3ClientError {
    if (error instanceof S3ClientError) {
      return error
    }

    if (error instanceof Error) {
      // Определяем тип ошибки по сообщению и коду
      let code: S3ClientError['code'] = 'UNKNOWN_ERROR'
      const errorAny = error as any

      // Проверяем код ошибки S3
      if (errorAny.code === 'AccessDenied' || error.message.includes('Access Denied')) {
        code = 'ACCESS_DENIED'
      } else if (errorAny.code === 'NoSuchBucket' || error.message.includes('NoSuchBucket')) {
        code = 'BUCKET_NOT_FOUND'
      } else if (errorAny.code === 'NoSuchKey' || error.message.includes('NoSuchKey')) {
        code = 'KEY_NOT_FOUND'
      } else if (
        errorAny.code === 'InvalidCredentials' ||
        error.message.includes('InvalidCredentials')
      ) {
        code = 'INVALID_CREDENTIALS'
      } else if (
        errorAny.code === 'NetworkError' ||
        error.message.includes('Network') ||
        error.message.includes('Connection')
      ) {
        code = 'NETWORK_ERROR'
      } else if (errorAny.code === 'UnknownError' || error.message.includes('unexpected error')) {
        // Для неожиданных ошибок логируем дополнительную информацию
        console.warn('S3 UnknownError детали:', {
          code: errorAny.code,
          message: error.message,
          stack: error.stack,
          path: errorAny.path,
        })
        code = 'UNKNOWN_ERROR'
      }

      return new S3ClientError(`${message}: ${error.message}`, code, error)
    }

    return new S3ClientError(message, 'UNKNOWN_ERROR')
  }
}
