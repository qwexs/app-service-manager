import type { MediaFile, MediaFileInfo, S3Config } from './types.js'

/**
 * Определяет MIME тип файла по расширению
 */
export function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop()

  const mimeTypes: Record<string, string> = {
    // Изображения
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    tiff: 'image/tiff',

    // Видео
    mp4: 'video/mp4',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
    webm: 'video/webm',
    mkv: 'video/x-matroska',

    // Аудио
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
    flac: 'audio/flac',
    m4a: 'audio/mp4',

    // Документы
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

    // Текстовые файлы
    txt: 'text/plain',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    json: 'application/json',
    xml: 'application/xml',

    // Архивы
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
  }

  return mimeTypes[ext || ''] || 'application/octet-stream'
}

/**
 * Генерирует уникальный ключ для файла
 */
export function generateFileKey(filename: string, prefix?: string, addTimestamp: boolean = true): string {
  const timestamp = addTimestamp ? Date.now() : ''
  const randomString = Math.random().toString(36).substring(2, 8)

  const parts = [prefix, timestamp, randomString, filename].filter(Boolean)
  return parts.join('/')
}

/**
 * Извлекает имя файла из ключа
 */
export function extractFilename(key: string): string {
  return key.split('/').pop() || key
}

/**
 * Извлекает директорию из ключа
 */
export function extractDirectory(key: string): string {
  const parts = key.split('/')
  return parts.slice(0, -1).join('/')
}

/**
 * Проверяет, является ли файл изображением
 */
export function isImageFile(filename: string): boolean {
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff']
  const ext = filename.toLowerCase().split('.').pop()
  return imageExtensions.includes(ext || '')
}

/**
 * Проверяет, является ли файл видео
 */
export function isVideoFile(filename: string): boolean {
  const videoExtensions = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv']
  const ext = filename.toLowerCase().split('.').pop()
  return videoExtensions.includes(ext || '')
}

/**
 * Проверяет, является ли файл аудио
 */
export function isAudioFile(filename: string): boolean {
  const audioExtensions = ['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a']
  const ext = filename.toLowerCase().split('.').pop()
  return audioExtensions.includes(ext || '')
}

/**
 * Форматирует размер файла в человекочитаемый вид
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes'

  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * Валидирует размер файла
 */
export function validateFileSize(
  data: MediaFile['data'],
  maxSizeBytes: number,
): { valid: boolean; size: number; error?: string } {
  let size: number

  if (data instanceof ArrayBuffer) {
    size = data.byteLength
  } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    size = data.length
  } else if (typeof data === 'string') {
    size = Buffer.byteLength(data, 'utf8')
  } else {
    return { valid: false, size: 0, error: 'Неподдерживаемый тип данных' }
  }

  if (size > maxSizeBytes) {
    return {
      valid: false,
      size,
      error: `Размер файла (${formatFileSize(size)}) превышает максимальный размер (${formatFileSize(maxSizeBytes)})`,
    }
  }

  return { valid: true, size }
}

/**
 * Создает MediaFile из различных источников данных
 */
export function createMediaFile(
  key: string,
  data: string | Buffer | Uint8Array | ArrayBuffer,
  options: {
    contentType?: string
    metadata?: Record<string, string>
    autoDetectMimeType?: boolean
  } = {},
): MediaFile {
  const { autoDetectMimeType = true, ...restOptions } = options

  let contentType = restOptions.contentType

  if (autoDetectMimeType && !contentType) {
    const filename = extractFilename(key)
    contentType = getMimeType(filename)
  }

  return {
    key,
    data: data as any,
    contentType,
    metadata: restOptions.metadata,
  }
}

/**
 * Конвертирует Buffer в разные форматы
 */
export function convertBuffer(
  buffer: Buffer,
  format: 'base64' | 'hex' | 'utf8' | 'arraybuffer' | 'uint8array',
): string | ArrayBuffer | Uint8Array {
  switch (format) {
    case 'base64':
      return buffer.toString('base64')
    case 'hex':
      return buffer.toString('hex')
    case 'utf8':
      return buffer.toString('utf8')
    case 'arraybuffer':
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    case 'uint8array':
      return new Uint8Array(buffer)
    default:
      throw new Error(`Неподдерживаемый формат: ${format}`)
  }
}

/**
 * Создает URL для локального предварительного просмотра файла
 */
export function createPreviewUrl(data: Buffer, contentType: string): string {
  if (!isImageFile(contentType) && !isVideoFile(contentType) && !isAudioFile(contentType)) {
    throw new Error('Предварительный просмотр поддерживается только для медиафайлов')
  }

  // Приводим Buffer к Uint8Array для совместимости с Blob
  const blob = new Blob([new Uint8Array(data)], { type: contentType })
  return URL.createObjectURL(blob)
}

/**
 * Очищает URL предварительного просмотра
 */
export function revokePreviewUrl(url: string): void {
  URL.revokeObjectURL(url)
}

/**
 * Сортирует файлы по различным критериям
 */
export function sortFiles(
  files: MediaFileInfo[],
  sortBy: 'name' | 'size' | 'date' | 'type',
  order: 'asc' | 'desc' = 'asc',
): MediaFileInfo[] {
  const sorted = [...files].sort((a, b) => {
    let comparison = 0

    switch (sortBy) {
      case 'name':
        comparison = extractFilename(a.key).localeCompare(extractFilename(b.key))
        break
      case 'size':
        comparison = a.size - b.size
        break
      case 'date':
        comparison = (a.lastModified?.getTime() || 0) - (b.lastModified?.getTime() || 0)
        break
      case 'type': {
        const aExt = extractFilename(a.key).split('.').pop() || ''
        const bExt = extractFilename(b.key).split('.').pop() || ''
        comparison = aExt.localeCompare(bExt)
        break
      }
    }

    return order === 'asc' ? comparison : -comparison
  })

  return sorted
}

/**
 * Фильтрует файлы по различным критериям
 */
export function filterFiles(
  files: MediaFileInfo[],
  filters: {
    extension?: string | string[]
    minSize?: number
    maxSize?: number
    dateFrom?: Date
    dateTo?: Date
    namePattern?: RegExp
  },
): MediaFileInfo[] {
  return files.filter((file) => {
    const filename = extractFilename(file.key)
    const ext = filename.toLowerCase().split('.').pop() || ''

    // Фильтр по расширению
    if (filters.extension) {
      const extensions = Array.isArray(filters.extension)
        ? filters.extension.map((e) => e.toLowerCase())
        : [filters.extension.toLowerCase()]

      if (!extensions.includes(ext)) return false
    }

    // Фильтр по размеру
    if (filters.minSize && file.size < filters.minSize) return false
    if (filters.maxSize && file.size > filters.maxSize) return false

    // Фильтр по дате
    if (filters.dateFrom && (!file.lastModified || file.lastModified < filters.dateFrom)) return false
    if (filters.dateTo && (!file.lastModified || file.lastModified > filters.dateTo)) return false

    // Фильтр по имени
    if (filters.namePattern && !filters.namePattern.test(filename)) return false

    return true
  })
}

/**
 * Группирует файлы по директориям
 */
export function groupFilesByDirectory(files: MediaFileInfo[]): Record<string, MediaFileInfo[]> {
  return files.reduce(
    (groups, file) => {
      const directory = extractDirectory(file.key) || 'root'

      if (!groups[directory]) {
        groups[directory] = []
      }

      groups[directory].push(file)
      return groups
    },
    {} as Record<string, MediaFileInfo[]>,
  )
}

/**
 * Создает безопасное имя файла (удаляет недопустимые символы)
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[<>:"/\\|?*]/g, '_') // Заменяем недопустимые символы
    .replace(/\s+/g, '_') // Заменяем пробелы
    .replace(/_{2,}/g, '_') // Убираем множественные подчеркивания
    .toLowerCase()
}

/**
 * Валидирует конфигурацию S3
 */
export function validateS3Config(config: Partial<S3Config>): string[] {
  const errors: string[] = []

  if (!config.accessKeyId) {
    errors.push('Access Key ID обязателен')
  }

  if (!config.secretAccessKey) {
    errors.push('Secret Access Key обязателен')
  }

  if (!config.bucket) {
    errors.push('Bucket обязателен')
  }

  if (config.endpoint && !isValidUrl(config.endpoint)) {
    errors.push('Некорректный URL endpoint')
  }

  return errors
}

/**
 * Проверяет, является ли строка валидным URL
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

/**
 * Создает хэш для данных файла (простая контрольная сумма)
 */
export function createFileHash(data: Buffer): string {
  // Простая контрольная сумма на основе содержимого
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    const char = data[i]
    hash = (hash << 5) - hash + (char || 0)
    hash = hash & hash // Конвертируем в 32-битное целое число
  }
  return Math.abs(hash).toString(16)
}

/**
 * Разбивает большой файл на части для загрузки
 */
export function chunkBuffer(buffer: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = []
  let offset = 0

  while (offset < buffer.length) {
    const end = Math.min(offset + chunkSize, buffer.length)
    chunks.push(buffer.subarray(offset, end))
    offset = end
  }

  return chunks
}

/**
 * Объединяет части файла обратно в один буфер
 */
export function mergeChunks(chunks: Buffer[]): Buffer {
  return Buffer.concat(chunks)
}
