// Типы для модуля обновления
// Описывают структуры данных манифестов, метаданных версий и задач обновления

// ─────────────────────────────────────────────────────────────────────────────
// Платформы
// ─────────────────────────────────────────────────────────────────────────────

export type Platform = 'linux-amd64' | 'linux-arm64' | 'windows-amd64' | 'darwin-arm64' | 'darwin-amd64'

export type ComponentName = 'service-manager' | 'app'

export type UpdateChannel = 'stable' | 'beta' | 'nightly'

// ─────────────────────────────────────────────────────────────────────────────
// Глобальный манифест (manifest.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestComponent {
  name: string
  description: string
  latestVersion: string
  latestPath: string
}

export interface Manifest {
  schemaVersion: number
  generatedAt: string
  components: Record<ComponentName, ManifestComponent>
  defaultChannel: UpdateChannel
}

// ─────────────────────────────────────────────────────────────────────────────
// Канал релизов (channels/{channel}.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface ChannelInfo {
  channel: UpdateChannel
  updatedAt: string
  components: Record<ComponentName, string> // component → version
}

// ─────────────────────────────────────────────────────────────────────────────
// Указатель на последнюю версию ({component}/latest.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface LatestInfo {
  version: string
  channel: UpdateChannel
  releasedAt: string
  metaPath: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Метаданные платформы внутри версии
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformInfo {
  archive: string // имя файла архива (например, linux-amd64.tar.gz)
  archiveSize: number // размер архива в байтах
  archiveSha256: string // SHA256 хэш архива
  binarySha256?: string // SHA256 исполняемого файла внутри архива
  extractedSize: number // размер после распаковки
  binary: string // путь к бинарнику внутри архива
}

// ─────────────────────────────────────────────────────────────────────────────
// Метаданные версии ({component}/{version}/meta.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface VersionMeta {
  component: ComponentName
  version: string
  channel: UpdateChannel
  releasedAt: string
  gitCommit?: string
  gitBranch?: string
  buildNumber?: number
  minServiceManagerVersion?: string
  changelog?: string

  // Информация по платформам
  platforms: Partial<Record<Platform, PlatformInfo>>

  // Пути к файлам, которые нужно сохранить при обновлении (конфиги)
  preservePaths?: string[]

  // Пути, исключённые из архива
  excludeFromArchive?: string[]

  // Действия после установки
  postInstall?: {
    chmod?: string[] // файлы, которым нужно дать права на выполнение
  }

  // Зависимости от других компонентов
  dependencies?: Partial<Record<ComponentName, string>>

  // Флаги версии
  breaking?: boolean // есть breaking changes
  critical?: boolean // критическое обновление безопасности
}

// ─────────────────────────────────────────────────────────────────────────────
// Информация об обновлении (результат checkUpdates)
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateInfo {
  component: ComponentName
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  changelog?: string
  critical?: boolean
  platforms: Platform[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Прогресс обновления
// ─────────────────────────────────────────────────────────────────────────────

export type UpdateStep = 'checking' | 'downloading' | 'verifying' | 'extracting' | 'installing'

export interface UpdateProgress {
  component: ComponentName
  step: UpdateStep
  progress: number // 0-100
  message: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Результат установки
// ─────────────────────────────────────────────────────────────────────────────

export interface InstallResult {
  success: boolean
  component: ComponentName
  oldVersion?: string
  newVersion?: string
  error?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// История версий (.config/version-history.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface VersionHistoryEntry {
  version: string
  installedAt: string
  sha256: string
}

export interface ComponentVersionHistory {
  current: string
  history: VersionHistoryEntry[]
}

export type VersionHistory = Partial<Record<ComponentName, ComponentVersionHistory>>

// ─────────────────────────────────────────────────────────────────────────────
// Self-update: Задание на обновление (.update/update-task.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateTaskComponent {
  name: ComponentName
  currentVersion: string
  targetVersion: string
  sourcePath: string // относительный путь к .new файлу
  targetPath: string // относительный путь к целевому бинарнику
  backupPath: string // относительный путь к бэкапу
  sha256: string
}

/**
 * Идентичность конкретного daemon. Одного PID недостаточно: instanceId создаётся
 * при старте и возвращается только через локальный IPC.
 */
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

/** Версия 2 — legacy task с daemonPid CLI намеренно не принимается. */
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

/**
 * Сравнивает две версии в формате semver
 * Возвращает:
 *   > 0 если a > b
 *   < 0 если a < b
 *   = 0 если a = b
 */
export function compareVersions(a: string, b: string): number {
  return Bun.semver.order(a, b)
}

/**
 * Проверяет, удовлетворяет ли версия требованию semver (node-semver ranges).
 */
export function satisfiesVersion(version: string, requirement: string): boolean {
  return Bun.semver.satisfies(version, requirement)
}
