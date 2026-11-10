import type { S3File } from 'bun'
import { z } from 'zod'

// Схемы валидации для конфигурации S3
export const S3ConfigSchema = z.object({
  accessKeyId: z.string().min(1, 'Access Key ID обязателен'),
  secretAccessKey: z.string().min(1, 'Secret Access Key обязателен'),
  region: z.string().default('us-east-1'),
  endpoint: z.string().url('Некорректный URL endpoint').optional(),
  bucket: z.string().min(1, 'Bucket обязателен'),
})

export const MediaFileSchema = z.object({
  key: z.string().min(1, 'Ключ файла обязателен'),
  data: z.union([
    z.instanceof(Buffer),
    z.instanceof(Uint8Array),
    z.instanceof(ArrayBuffer),
    z.string(),
  ]),
  contentType: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
})

export const MediaFileReadSchema = z.object({
  key: z.string().min(1, 'Ключ файла обязателен'),
  range: z
    .object({
      start: z.number().min(0),
      end: z.number().min(0),
    })
    .optional(),
})

// Основные типы
export type S3Config = z.infer<typeof S3ConfigSchema>

export type MediaFile = z.infer<typeof MediaFileSchema>

export type MediaFileRead = z.infer<typeof MediaFileReadSchema>

export interface MediaFileInfo {
  key: string
  size: number
  lastModified?: Date
  etag?: string
  contentType?: string
  metadata?: Record<string, string>
}

export interface MediaFileContent {
  key: string
  data: Buffer
  contentType?: string
  metadata?: Record<string, string>
}

export interface S3OperationResult {
  success: boolean
  key: string
  error?: string
}

export interface S3BatchOperationResult {
  success: boolean
  results: S3OperationResult[]
  totalCount: number
  successCount: number
  errorCount: number
}

// Опции для операций
export interface ReadOptions {
  /** Диапазон байтов для чтения */
  range?: {
    start: number
    end: number
  }
  /** Возвращать метаданные файла */
  includeMetadata?: boolean
}

export interface WriteOptions {
  /** Тип содержимого файла */
  contentType?: string
  /** Метаданные файла */
  metadata?: Record<string, string>
  /** Перезаписать файл если он существует */
  overwrite?: boolean
}

export interface ListOptions {
  /** Префикс для фильтрации файлов */
  prefix?: string
  /** Максимальное количество файлов */
  maxKeys?: number
  /** Токен для пагинации */
  continuationToken?: string
}

export interface ListResult {
  files: MediaFileInfo[]
  isTruncated: boolean
  continuationToken?: string
}

// Типы для downloadFolder
export interface DownloadFolderOptions extends ListOptions, ProgressOptions {
  /** Локальная директория для сохранения файлов */
  localPath?: string
  /** Создавать директории если они не существуют */
  createDirectories?: boolean
  /** Перезаписывать существующие файлы */
  overwrite?: boolean
}

export interface DownloadFolderResult {
  success: boolean
  totalFiles: number
  downloadedFiles: number
  failedFiles: number
  results: Array<{
    key: string
    localPath: string
    success: boolean
    error?: string
    size: number
  }>
  totalSize: number
}

// Типы ошибок
export type S3ErrorCode =
  | 'ACCESS_DENIED'
  | 'BUCKET_NOT_FOUND'
  | 'KEY_NOT_FOUND'
  | 'INVALID_CREDENTIALS'
  | 'NETWORK_ERROR'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN_ERROR'

export class S3ClientError extends Error {
  constructor(
    message: string,
    public code: S3ErrorCode,
    public originalError?: Error
  ) {
    super(message)
    this.name = 'S3ClientError'

    // Используем параметры для избежания предупреждений линтера
    void code
    void originalError
  }
}

// Расширенные типы для работы с S3File
export interface ExtendedS3File extends S3File {
  getInfo(): Promise<MediaFileInfo>
  readAsBuffer(): Promise<Buffer>
  readAsText(): Promise<string>
  readAsJSON<T = unknown>(): Promise<T>
}

// Типы для прогресса загрузки/скачивания
export interface ProgressInfo {
  loaded: number
  total: number
  percentage: number
}

export type ProgressCallback = (progress: ProgressInfo) => void

export interface ProgressOptions {
  onProgress?: ProgressCallback
}

// Комбинированные опции
export interface ReadWithProgressOptions extends ReadOptions, ProgressOptions {}
export interface WriteWithProgressOptions extends WriteOptions, ProgressOptions {}
