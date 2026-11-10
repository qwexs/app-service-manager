// Типы для asm-updater
// Включает типы для self-update и публикации релизов

// ─────────────────────────────────────────────────────────────────────────────
// Платформы и компоненты
// ─────────────────────────────────────────────────────────────────────────────

export type Platform = 'linux-amd64' | 'linux-arm64' | 'windows-amd64' | 'darwin-arm64' | 'darwin-amd64'
export type ComponentName = 'service-manager' | 'app'
export type UpdateChannel = 'stable' | 'beta' | 'nightly'

// ─────────────────────────────────────────────────────────────────────────────
// Self-update типы
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateTaskComponent {
  name: ComponentName
  currentVersion: string
  targetVersion: string
  sourcePath: string
  targetPath: string
  backupPath: string
  sha256: string
}

export interface DaemonIdentity {
  pid: number
  instanceId: string
  rootDir: string
  version: string
}

export interface ReplacementDaemon {
  pid: number
  gate: string
  identity?: DaemonIdentity
}

export type PostUpdateAppsStatus = 'required' | 'restarting' | 'completed' | 'failed'
export type UpdateTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'rolled_back' | 'manual_recovery'

export interface UpdateTask {
  schemaVersion: 2
  id: string
  createdAt: string
  rootDir: string
  components: UpdateTaskComponent[]
  daemon: DaemonIdentity
  replacement?: ReplacementDaemon
  status: UpdateTaskStatus
  handoff: { requested: boolean; acknowledged: boolean }
  postUpdateApps: { status: PostUpdateAppsStatus; error?: string }
  healthCheck: {
    enabled: true
    timeout: number // мс
    endpoint: 'ipc'
  }
  rollbackOnFailure: boolean
  error?: string
  completedAt?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Метаданные релизов (S3 структура)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformInfo {
  archive: string
  archiveSize: number
  archiveSha256: string
  binarySha256: string
  extractedSize: number
  binary: string
}

export interface VersionMeta {
  component: ComponentName
  version: string
  channel: UpdateChannel
  releasedAt: string
  gitCommit?: string
  gitBranch?: string
  changelog?: string
  platforms: Partial<Record<Platform, PlatformInfo>>
  preservePaths?: string[]
  postInstall?: {
    chmod?: string[]
  }
  dependencies?: Partial<Record<ComponentName, string>>
  breaking?: boolean
  critical?: boolean
}

export interface LatestInfo {
  version: string
  channel: UpdateChannel
  releasedAt: string
  metaPath: string
}

export interface ChannelInfo {
  channel: UpdateChannel
  updatedAt: string
  components: Partial<Record<ComponentName, string>>
}

export interface ManifestComponent {
  name: string
  description: string
  latestVersion: string
  latestPath: string
}

export interface Manifest {
  schemaVersion: number
  generatedAt: string
  components: Partial<Record<ComponentName, ManifestComponent>>
  defaultChannel: UpdateChannel
}

// ─────────────────────────────────────────────────────────────────────────────
// Конфигурация публикации
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishConfig {
  component: ComponentName
  version: string
  channel: UpdateChannel
  changelog?: string
  dryRun: boolean
  platform?: Platform // Если указано, публикуется только эта платформа
  force?: boolean // Перезаписать иммутабельные {component}/{version}/*
  retainCount?: number // Число последних релизов компонента, сохраняемых в S3
}

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Результаты операций
// ─────────────────────────────────────────────────────────────────────────────

export interface OperationResult {
  success: boolean
  error?: string
}

export interface PlatformBuild {
  platform: Platform
  binaryPath: string
  archiveData: Uint8Array
  archiveSha256: string
  binarySha256: string
  archiveSize: number
  extractedSize: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Определяет текущую платформу
 */
export function getPlatform(): Platform {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const value = `${os}-${arch}`
  if (!['linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-arm64', 'darwin-amd64'].includes(value)) throw new Error(`Unsupported platform: ${value}`)
  return value as Platform
}
