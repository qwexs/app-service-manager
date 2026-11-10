import { confinedPath } from '../../../../packages/project/src'
// Модуль для работы с tar.gz архивами
// Использует нативный Bun.Archive API (Bun 1.3.6+)

import { mkdir } from 'node:fs/promises'
import path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────────────────────

export interface TarEntry {
  name: string
  data?: Uint8Array
  mode?: number
  type?: string // '0' = file, '5' = directory
}

export interface ExtractProgress {
  current: number
  total: number
  fileName: string
}

export type ArchiveSource = Uint8Array | string

async function openArchive(source: ArchiveSource): Promise<Bun.Archive> {
  // Конструктор читает bytes/Blob в памяти; ленивый Bun.file даёт
  // "Unrecognized archive format". https://bun.com/docs/runtime/archive.md
  if (typeof source === 'string') {
    return new Bun.Archive(await Bun.file(source).bytes())
  }
  return new Bun.Archive(source)
}

// ─────────────────────────────────────────────────────────────────────────────
// Распаковка
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Распаковывает tar.gz данные в массив записей
 */
export async function extractTarGz(compressedData: Uint8Array): Promise<TarEntry[]> {
  const archive = new Bun.Archive(compressedData)
  const files = await archive.files()
  const entries: TarEntry[] = []

  for (const [name, file] of files) {
    const data = new Uint8Array(await file.arrayBuffer())
    entries.push({ name, data, type: '0' })
  }

  return entries
}

/**
 * Распаковывает tar.gz архив в директорию
 * @param archiveData - сжатые данные или путь к файлу архива
 * @param targetDir - целевая директория
 * @param onProgress - колбэк прогресса
 */
export async function extractTarGzToDir(
  archiveData: ArchiveSource,
  targetDir: string,
  onProgress?: (progress: ExtractProgress) => void,
): Promise<void> {
  const archive = await openArchive(archiveData)

  // Пишем файлы по одному даже без progress callback: так перед каждой
  // записью проверяется path traversal внутри недоверенного архива.
  const files = await archive.files()
  const total = files.size
  let current = 0
  await mkdir(targetDir, { recursive: true })
  const resolvedTargetDir = path.resolve(targetDir)

  for (const [name, file] of files) {
    const filePath = confinedPath(resolvedTargetDir, name)
    if (filePath !== resolvedTargetDir && !filePath.startsWith(resolvedTargetDir + path.sep)) {
      throw new Error(`Архив содержит путь за пределами целевой директории: ${name}`)
    }

    await mkdir(path.dirname(filePath), { recursive: true })
    await Bun.write(filePath, file)

    current++
    onProgress?.({ current, total, fileName: name })
  }
}

/**
 * Распаковывает только указанный файл из архива
 * @param archiveData - сжатые данные или путь к файлу архива
 * @param fileName - имя файла для извлечения
 * @returns содержимое файла или null если не найден
 */
export async function extractFileFromTarGz(archiveData: ArchiveSource, fileName: string): Promise<Uint8Array | null> {
  const archive = await openArchive(archiveData)
  const files = await archive.files()
  const exact = files.get(fileName)
  if (exact) return new Uint8Array(await exact.arrayBuffer())

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Создание архивов (для CI/CD сборки)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт tar.gz архив из массива записей
 */
export async function createTarGz(files: TarEntry[]): Promise<Uint8Array> {
  const filesObj: Record<string, Uint8Array> = {}

  for (const entry of files) {
    if (entry.data) {
      filesObj[entry.name] = entry.data
    }
  }

  const archive = new Bun.Archive(filesObj, { compress: 'gzip' })
  return archive.bytes()
}

/**
 * Создаёт tar.gz архив из директории
 * @param sourceDir - исходная директория
 * @param excludePatterns - паттерны для исключения
 */
export async function createTarGzFromDir(sourceDir: string, excludePatterns: string[] = []): Promise<Uint8Array> {
  const filesObj: Record<string, Uint8Array> = {}

  const items = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: sourceDir, dot: true }))

  for (const item of items) {
    const relativePath = item

    // Проверяем исключения
    const shouldExclude = excludePatterns.some((pattern) => {
      if (pattern.endsWith('/')) {
        return relativePath.startsWith(pattern) || relativePath + '/' === pattern
      }
      return relativePath === pattern || relativePath.includes(pattern)
    })

    if (shouldExclude) continue

    const fullPath = path.join(sourceDir, item)
    const file = Bun.file(fullPath)

    if (await file.exists()) {
      const data = await file.arrayBuffer()
      filesObj[relativePath.replace(/\\/g, '/')] = new Uint8Array(data)
    }
  }

  const archive = new Bun.Archive(filesObj, { compress: 'gzip' })
  return archive.bytes()
}

// ─────────────────────────────────────────────────────────────────────────────
// Сохранение и восстановление файлов (конфиги)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Сохраняет указанные файлы перед обновлением (конфиги и т.д.)
 * @param baseDir - базовая директория
 * @param paths - относительные пути к файлам
 * @returns Map: путь → содержимое
 */
export async function preserveFiles(baseDir: string, paths: string[]): Promise<Map<string, Uint8Array>> {
  const preserved = new Map<string, Uint8Array>()

  for (const relativePath of paths) {
    const fullPath = confinedPath(baseDir, relativePath)

    try {
      const file = Bun.file(fullPath)
      if (await file.exists()) {
        const content = await file.arrayBuffer()
        preserved.set(relativePath, new Uint8Array(content))
      }
    } catch {
      // Файл не существует или недоступен — пропускаем
    }
  }

  return preserved
}

/**
 * Восстанавливает сохранённые файлы после обновления
 * @param baseDir - базовая директория
 * @param preserved - Map с сохранёнными файлами
 */
export async function restoreFiles(baseDir: string, preserved: Map<string, Uint8Array>): Promise<void> {
  for (const [relativePath, content] of preserved) {
    const fullPath = confinedPath(baseDir, relativePath)

    // Создаём директорию если нужно
    await mkdir(path.dirname(fullPath), { recursive: true })

    // Записываем файл
    await Bun.write(fullPath, content)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Вычисляет SHA256 хэш данных
 */
export function computeSha256(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(data)
  return hasher.digest('hex')
}

/**
 * Вычисляет SHA256 хэш файла
 */
export async function computeFileSha256(filePath: string): Promise<string> {
  const file = Bun.file(filePath)
  const data = await file.arrayBuffer()
  return computeSha256(new Uint8Array(data))
}

/** Read a directory release as regular tar files only, before writing anything. */
export async function readDirectoryArchive(source: ArchiveSource): Promise<TarEntry[]> {
  const compressed = typeof source === 'string' ? await Bun.file(source).bytes() : source
  const data = Bun.gunzipSync(new Uint8Array(compressed))
  const entries: TarEntry[] = []
  const names = new Set<string>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const field = (bytes: Uint8Array) => decoder.decode(bytes).replace(/\0.*$/s, '')
  let offset = 0
  let ended = false
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) { ended = true; break }
    const checksumText = field(header.subarray(148, 156)).trim()
    if (!/^[0-7]+$/.test(checksumText)) throw new Error('Неверный tar checksum')
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!
    if (checksum !== parseInt(checksumText, 8)) throw new Error('Неверный tar checksum')
    const type = header[156]
    if (type !== 0 && type !== 48) throw new Error('Архив должен содержать только обычные файлы')
    const name = field(header.subarray(0, 100))
    const prefix = field(header.subarray(345, 500))
    const fullName = prefix ? `${prefix}/${name}` : name
    const sizeText = field(header.subarray(124, 136)).trim()
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Неверный размер tar')
    const size = parseInt(sizeText, 8)
    if (!Number.isSafeInteger(size) || offset + 512 + size > data.length || names.has(fullName)) throw new Error('Неверная запись tar')
    names.add(fullName)
    entries.push({ name: fullName, data: data.slice(offset + 512, offset + 512 + size), type: '0' })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (!ended || data.subarray(offset).some((b) => b !== 0)) throw new Error('Неверный конец tar')
  return entries
}
