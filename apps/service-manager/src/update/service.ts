// UpdateService — бизнес-логика обновления компонентов
// Координирует проверку, скачивание и установку обновлений

import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import { validateArchiveNames } from '../../../../packages/project/src/release'

import type { UpdateConfig } from './config'
import { validateComponent, validateMeta, validateVersion } from './metadata'
import { confinedPath } from '../../../../packages/project/src'
import { UpdateRepository, RepositoryError } from './repository'
import { extractTarGzToDir, readDirectoryArchive, computeSha256 } from './archive'
import {
  getBackupPath,
  getComponentDir,
  getDownloadPath,
  getPrevBackupPath,
  getStagingPath,
  pathExists,
  pruneUpdateArtifacts,
  replacePath,
} from './layout'
import {
  type ComponentName,
  type UpdateInfo,
  type UpdateProgress,
  type InstallResult,
  type VersionMeta,
  type Platform,
  getPlatform,
  compareVersions,
} from './types'

export interface InstallUpdateOptions {
  verbose?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────────────────────

export interface CurrentVersions {
  'service-manager'?: string
  app?: string
}

export interface StagedUpdate {
  component: ComponentName
  version: string
  stagingPath: string
  destPath: string
  backupPath: string
  prevPath: string
  componentDir: string
  platformInfo: {
    binary: string
    archiveSha256: string
    binarySha256?: string
  }
  directory: boolean
  chmodFiles?: string[]
  downloadPath?: string
}

export interface UpdateServiceOptions {
  config: UpdateConfig
  rootDir: string
  currentVersions?: CurrentVersions
}

interface InstallMarker {
  version: string
  archiveSha256: string
  binarySha256?: string
  installedAt: string
  layout?: 'directory-v1'
}

// ─────────────────────────────────────────────────────────────────────────────
// UpdateService
// ─────────────────────────────────────────────────────────────────────────────

async function readCurrentEnv(dir: string): Promise<Uint8Array | null> {
  const file = path.join(dir, '.env')
  let handle
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('.env должен быть обычным файлом')
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    if (!(await handle.stat()).isFile()) throw new Error('.env должен быть обычным файлом')
    return await handle.readFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  } finally { await handle?.close() }
}

async function writePrivateEnv(dir: string, content: Uint8Array): Promise<void> {
  const file = path.join(dir, '.env')
  // A backup may contain an old config or a symlink; never follow it.
  await rm(file, { force: true })
  await writeFile(file, content, { mode: 0o600, flag: 'wx' })
  await chmod(file, 0o600)
}

export class UpdateService {
  private readonly repo: UpdateRepository
  private readonly config: UpdateConfig
  private readonly rootDir: string
  private readonly currentVersions: CurrentVersions

  constructor(options: UpdateServiceOptions) {
    this.config = options.config
    this.rootDir = options.rootDir
    this.currentVersions = options.currentVersions || {}
    this.repo = new UpdateRepository(options.config.s3)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Проверка обновлений
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Проверяет наличие обновлений для указанных компонентов
   * @param components - компоненты для проверки (если не указаны — все)
   */
  async checkUpdates(components?: ComponentName[]): Promise<UpdateInfo[]> {
    // Получаем информацию о канале
    const channel = await this.repo.getChannel(this.config.channel)

    // Определяем компоненты для проверки
    const targetComponents = components || (Object.keys(channel.components) as ComponentName[])

    const results: UpdateInfo[] = []

    for (const component of targetComponents) {
      validateComponent(component)
      const latestVersion = channel.components[component]
      if (!latestVersion) continue

      validateVersion(latestVersion)
      const currentVersion = this.currentVersions[component] || '0.0.0'
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0

      let meta: VersionMeta | null = null
      if (hasUpdate) {
        try {
          meta = await this.repo.getVersionMeta(component, latestVersion)
        } catch {
          // Не удалось получить метаданные — продолжаем без них
        }
      }

      results.push({
        component,
        currentVersion,
        latestVersion,
        hasUpdate,
        changelog: meta?.changelog,
        critical: meta?.critical ?? false,
        platforms: meta?.platforms ? (Object.keys(meta.platforms) as Platform[]) : [],
      })
    }

    return results
  }

  /**
   * Получает информацию о конкретной версии
   */
  async getVersionInfo(component: ComponentName, version: string): Promise<VersionMeta> {
    return this.repo.getVersionMeta(component, version)
  }

  /**
   * Получает список всех доступных версий компонента
   */
  async listVersions(component: ComponentName): Promise<string[]> {
    return this.repo.listVersions(component)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Установка обновлений
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Скачивает и распаковывает релиз в staging. Dest не трогает.
   */
  async stageUpdate(
    component: ComponentName,
    version?: string,
    onProgress?: (progress: UpdateProgress) => void,
    options?: InstallUpdateOptions,
  ): Promise<{ success: true; staged: StagedUpdate } | { success: false; result: InstallResult }> {
    validateComponent(component)
    if (version) validateVersion(version)
    if (component === 'service-manager') throw new Error('Используйте controlled self-update, не общий installer')
    const platform = getPlatform()
    const verbose = options?.verbose ?? false
    let stagingPath: string | undefined
    let downloadPath: string | undefined

    try {
      onProgress?.({ component, step: 'checking', progress: 0, message: 'Проверка метаданных...' })

      let targetVersion = version
      if (!targetVersion) {
        const channel = await this.repo.getChannel(this.config.channel)
        targetVersion = channel.components[component]
        if (!targetVersion) {
          return {
            success: false,
            result: {
              success: false,
              component,
              error: `Компонент ${component} не найден в канале ${this.config.channel}`,
            },
          }
        }
      }

      validateVersion(targetVersion)
      const meta = await this.repo.getVersionMeta(component, targetVersion)
      validateMeta(meta, component, targetVersion, platform, this.rootDir)
      const platformInfo = meta.platforms[platform]

      if (!platformInfo) {
        return { success: false, result: { success: false, component, error: `Платформа ${platform} не поддерживается` } }
      }

      if (meta.minServiceManagerVersion) {
        const smVersion = this.currentVersions['service-manager'] || '0.0.0'
        if (compareVersions(smVersion, meta.minServiceManagerVersion) < 0) {
          return {
            success: false,
            result: {
              success: false,
              component,
              error: `Требуется service-manager >= ${meta.minServiceManagerVersion} (текущая: ${smVersion})`,
            },
          }
        }
      }

      onProgress?.({ component, step: 'downloading', progress: 0, message: 'Скачивание...' })

      downloadPath = getDownloadPath(this.rootDir, component, targetVersion)
      const archivePath = path.join(downloadPath, 'archive.tar.gz')
      if (await pathExists(downloadPath)) {
        await rm(downloadPath, { recursive: true, force: true })
      }

      const downloaded = await this.repo.downloadArchive(
        component,
        targetVersion,
        platform,
        archivePath,
        (downloadedBytes, total) => {
          const progress = Math.round((downloadedBytes / total) * 100)
          onProgress?.({ component, step: 'downloading', progress, message: `Скачивание: ${progress}%` })
        },
      )

      onProgress?.({ component, step: 'verifying', progress: 0, message: 'Проверка SHA256...' })

      if (downloaded.sha256.toLowerCase() !== platformInfo.archiveSha256.toLowerCase()) {
        if (downloadPath) {
          await rm(downloadPath, { recursive: true, force: true }).catch(() => undefined)
        }
        return { success: false, result: { success: false, component, error: 'Проверка контрольной суммы не пройдена' } }
      }

      onProgress?.({ component, step: 'verifying', progress: 100, message: 'SHA256 OK' })

      const componentDir = confinedPath(this.rootDir, component)
      const backupPath = getBackupPath(this.rootDir, component)
      const prevPath = getPrevBackupPath(this.rootDir, component)
      stagingPath = getStagingPath(this.rootDir, component, targetVersion)

      if (await pathExists(stagingPath)) {
        await rm(stagingPath, { recursive: true, force: true })
      }

      onProgress?.({ component, step: 'extracting', progress: 0, message: 'Распаковка...' })
      if (meta.layout === 'directory-v1') {
        const compressed = await Bun.file(archivePath).bytes()
        if (compressed.byteLength !== platformInfo.archiveSize) throw new Error('Размер архива не совпадает')
        const entries = await readDirectoryArchive(compressed)
        validateArchiveNames(meta, platform, entries.map((entry) => entry.name))
        const total = entries.reduce((sum, entry) => sum + entry.data!.byteLength, 0)
        if (total !== platformInfo.extractedSize) throw new Error('Размер содержимого не совпадает')
        const binary = entries.find((entry) => entry.name === platformInfo.binary)!.data!
        const versionData = entries.find((entry) => entry.name === '.version')!.data!
        if (![targetVersion, targetVersion + '\n'].includes(new TextDecoder('utf-8', { fatal: true }).decode(versionData))) throw new Error('Версия архива не совпадает')
        if (computeSha256(binary).toLowerCase() !== platformInfo.binarySha256!.toLowerCase()) throw new Error('SHA256 binary не совпадает до замены')
        await mkdir(stagingPath, { recursive: true })
        for (const entry of entries) {
          const filePath = confinedPath(stagingPath, entry.name)
          await mkdir(path.dirname(filePath), { recursive: true })
          await writeFile(filePath, entry.data!)
        }
      } else {
        await mkdir(stagingPath, { recursive: true })
        await extractTarGzToDir(archivePath, stagingPath)
        const stagedBinary = Bun.file(path.join(stagingPath, platformInfo.binary))
        if (!(await stagedBinary.exists()) || computeSha256(await stagedBinary.bytes()).toLowerCase() !== platformInfo.binarySha256!.toLowerCase()) throw new Error('SHA256 binary не совпадает до замены')
      }
      const destPath = componentDir

      if (downloadPath) {
        await rm(downloadPath, { recursive: true, force: true }).catch(() => undefined)
        downloadPath = undefined
      }

      const chmodFiles = meta.postInstall?.chmod

      return {
        success: true,
        staged: {
          component,
          version: targetVersion,
          stagingPath,
          destPath,
          backupPath,
          prevPath,
          componentDir,
          platformInfo: {
            binary: platformInfo.binary,
            archiveSha256: platformInfo.archiveSha256,
            binarySha256: platformInfo.binarySha256,
          },
          directory: meta.layout === 'directory-v1',
          chmodFiles,
        },
      }
    } catch (error) {
      if (downloadPath) {
        await rm(downloadPath, { recursive: true, force: true }).catch(() => undefined)
      }
      if (stagingPath) {
        await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined)
      }
      const message = error instanceof RepositoryError ? error.message : (error as Error).message
      return { success: false, result: { success: false, component, error: message } }
    }
  }

  /**
   * Подменяет dest содержимым staging, пишет маркеры. После успеха staging нет.
   */
  async commitStaged(staged: StagedUpdate, onProgress?: (progress: UpdateProgress) => void): Promise<InstallResult> {
    const { component } = staged
    onProgress?.({ component, step: 'installing', progress: 0, message: 'Создание бэкапа...' })
    onProgress?.({ component, step: 'installing', progress: 50, message: 'Установка...' })

    const preserved = staged.directory ? await readCurrentEnv(staged.componentDir) : null
    if (preserved) await writePrivateEnv(staged.stagingPath, preserved)
    await replacePath(staged.stagingPath, staged.destPath, staged.backupPath, staged.prevPath)
    staged.stagingPath = ''

    if (staged.chmodFiles && process.platform !== 'win32') {
      for (const file of staged.chmodFiles) {
        const filePath = confinedPath(staged.componentDir, file)
        if (await pathExists(filePath)) {
          await chmod(filePath, 0o755)
        }
      }
    }

    const installedBinary = Bun.file(path.join(staged.componentDir, staged.platformInfo.binary))
    if (!(await installedBinary.exists())) {
      throw new Error(`После установки не найден бинарник ${staged.platformInfo.binary}`)
    }
    const installedBinarySha256 = computeSha256(new Uint8Array(await installedBinary.arrayBuffer()))
    if (staged.platformInfo.binarySha256 && installedBinarySha256.toLowerCase() !== staged.platformInfo.binarySha256.toLowerCase()) {
      throw new Error(`Контрольная сумма бинарника ${staged.platformInfo.binary} не совпадает с метаданными релиза`)
    }

    if (component !== 'service-manager') {
      const marker: InstallMarker = {
        version: staged.version,
        archiveSha256: staged.platformInfo.archiveSha256,
        binarySha256: installedBinarySha256,
        installedAt: new Date().toISOString(),
        ...(staged.directory ? { layout: 'directory-v1' as const } : {}),
      }
      const markerPath = path.join(staged.componentDir, '.release.json')
      const markerTempPath = `${markerPath}.tmp-${process.pid}`
      await Bun.write(markerTempPath, JSON.stringify(marker, null, 2) + '\n')
      await rename(markerTempPath, markerPath)
      await Bun.write(path.join(staged.componentDir, '.version'), staged.version + '\n')
    }

    onProgress?.({ component, step: 'installing', progress: 100, message: 'Установка завершена' })

    const oldVersion = this.currentVersions[component]
    return { success: true, component, oldVersion, newVersion: staged.version }
  }

  async discardStaged(staged: StagedUpdate): Promise<void> {
    if (staged.stagingPath) {
      await rm(staged.stagingPath, { recursive: true, force: true }).catch(() => undefined)
      staged.stagingPath = ''
    }
    if (staged.downloadPath) {
      await rm(staged.downloadPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Устанавливает обновление для компонента (stage + commit).
   * DDL не выполняет — только файлы.
   */
  async installUpdate(
    component: ComponentName,
    version?: string,
    onProgress?: (progress: UpdateProgress) => void,
    options?: InstallUpdateOptions,
  ): Promise<InstallResult> {
    const staged = await this.stageUpdate(component, version, onProgress, options)
    if (!staged.success) {
      return staged.result
    }

    try {
      return await this.commitStaged(staged.staged, onProgress)
    } catch (error) {
      await this.discardStaged(staged.staged)
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, component, error: message }
    }
  }

  /**
   * Откатывает компонент к предыдущей версии из бэкапа
   */
  async rollback(component: ComponentName, executable?: string): Promise<InstallResult> {
    validateComponent(component)
    if (component !== 'app') throw new Error('Rollback service-manager только через updater')
    const componentDir = confinedPath(this.rootDir, component)
    const backupPath = getBackupPath(this.rootDir, component)

    if (!(await pathExists(backupPath))) {
      return { success: false, component, error: 'Бэкап не найден' }
    }

    try {
      const backupStat = await lstat(backupPath)
      if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) throw new Error('Неверный бэкап')
      let directory = false
      try {
        const marker = JSON.parse(await Bun.file(path.join(componentDir, '.release.json')).text())
        directory = marker.layout === 'directory-v1'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const preserved = directory ? await readCurrentEnv(componentDir) : null
      if (directory) {
        if (!executable || !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.exe)?$/.test(executable)) throw new Error('Не задан executable для проверки бэкапа')
        for (const relative of [executable, 'web/index.html']) {
          const entry = await lstat(confinedPath(backupPath, relative))
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Неверный бэкап')
        }
        const version = await lstat(path.join(backupPath, '.version'))
        if (!version.isFile() || version.isSymbolicLink()) throw new Error('Неверный бэкап')
        validateVersion((await Bun.file(path.join(backupPath, '.version')).text()).trim())
        if (preserved) await writePrivateEnv(backupPath, preserved)
        else await rm(path.join(backupPath, '.env'), { force: true })
      }
      const temporary = path.join(this.rootDir, `.app-rollback-${process.pid}`)
      try { await lstat(temporary); throw new Error('Rollback временный путь занят') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const hasCurrent = await pathExists(componentDir)
      if (hasCurrent) await rename(componentDir, temporary)
      try { await rename(backupPath, componentDir) } catch (error) {
        if (hasCurrent) await rename(temporary, componentDir)
        throw error
      }
      if (hasCurrent) await rm(temporary, { recursive: true, force: true })
      return { success: true, component }
    } catch (error) {
      return { success: false, component, error: (error as Error).message }
    }
  }

  async prune(): Promise<string[]> {
    return pruneUpdateArtifacts(this.rootDir)
  }

  /**
   * Обновляет текущую версию компонента
   */
  setCurrentVersion(component: ComponentName, version: string): void {
    this.currentVersions[component] = version
  }

  /**
   * Возвращает текущие версии всех компонентов
   */
  getCurrentVersions(): CurrentVersions {
    return { ...this.currentVersions }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Фабричная функция
// ─────────────────────────────────────────────────────────────────────────────

export function createUpdateService(options: UpdateServiceOptions): UpdateService {
  return new UpdateService(options)
}
