// S3 Client - пакет для работы с S3-совместимыми хранилищами
export { S3Client } from './s3-client.js'

// Экспорт всех типов
export type {
  S3Config,
  MediaFile,
  MediaFileRead,
  MediaFileInfo,
  MediaFileContent,
  S3OperationResult,
  S3BatchOperationResult,
  ReadOptions,
  WriteOptions,
  ListOptions,
  ListResult,
  ReadWithProgressOptions,
  WriteWithProgressOptions,
  S3ErrorCode,
  ExtendedS3File,
  ProgressInfo,
  ProgressCallback,
  ProgressOptions,
} from './types.js'

// Экспорт класса ошибок
export { S3ClientError } from './types.js'

// Экспорт схем валидации
export { S3ConfigSchema, MediaFileSchema, MediaFileReadSchema } from './types.js'

// Экспорт утилит
export {
  getMimeType,
  generateFileKey,
  extractFilename,
  extractDirectory,
  isImageFile,
  isVideoFile,
  isAudioFile,
  formatFileSize,
  validateFileSize,
  createMediaFile,
  convertBuffer,
  createPreviewUrl,
  revokePreviewUrl,
  sortFiles,
  filterFiles,
  groupFilesByDirectory,
  sanitizeFilename,
  validateS3Config,
  createFileHash,
  chunkBuffer,
  mergeChunks,
} from './utils.js'

// Экспорт по умолчанию
import { S3Client as S3ClientClass } from './s3-client.js'
export default S3ClientClass
