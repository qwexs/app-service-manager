import { confinedPath } from '../../../../packages/project/src'
import { validateMeta, validateVersion } from './metadata'
// Self-update — обновление самого service-manager через asm-updater
// Этот модуль подготавливает задание и запускает внешний updater

import { join } from 'node:path'
import { chmod, mkdir, rm } from 'node:fs/promises'

import type { DaemonIdentity, UpdateTask } from './types'
import { readUpdateTask, withTaskLock, writeUpdateTask } from './task-store'
import { getPlatform } from './types'
import { computeFileSha256 } from './archive'
import { UpdateRepository } from './repository'
import type { UpdateConfig } from './config'
import { APP_VERSION } from '../version'

// ─────────────────────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────────────────────

export interface SelfUpdateOptions {
  // Конфигурация S3
  config: UpdateConfig
  /** Авторитетный корень из CLI/IPC; не вычисляется заново из execPath. */
  rootDir: string
  /** Identity живого daemon, полученная по IPC до любых записей/запуска. */
  daemon: DaemonIdentity
  // Целевая версия (если не указана — последняя)
  targetVersion?: string
  // Откатывать при ошибке health check
  rollbackOnFailure?: boolean
  // Таймаут health check в мс
  healthCheckTimeout?: number
  // Колбэк прогресса
  onProgress?: (step: string, progress: number, message: string) => void
}

export interface SelfUpdateResult {
  success: boolean
  taskId?: string
  targetVersion?: string
  error?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Получает текущую версию service-manager
 */
export function getCurrentVersion(): string {
  return APP_VERSION
}

/**
 * Получает имя бинарника в зависимости от платформы
 */
function getBinaryName(): string {
  return process.platform === 'win32' ? 'asm.exe' : 'asm'
}

/**
 * Получает имя updater в зависимости от платформы
 */
function getUpdaterName(): string {
  return process.platform === 'win32' ? 'asm-updater.exe' : 'asm-updater'
}

// ─────────────────────────────────────────────────────────────────────────────
// Основная функция
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Инициирует self-update service-manager
 *
 * Процесс:
 * 1. Проверяет наличие asm-updater
 * 2. Скачивает новую версию service-manager
 * 3. Проверяет SHA256
 * 4. Создаёт update-task.json
 * 5. Запускает asm-updater
 * 6. Завершает текущий процесс (daemon)
 *
 * @returns результат (success = false если не удалось подготовить обновление)
 */
export async function initiateSelfUpdate(options: SelfUpdateOptions): Promise<SelfUpdateResult> {
  try {
    return await withTaskLock(options.rootDir, async () => {
      const existing = await readUpdateTask(options.rootDir)
      if (existing && !['completed', 'failed', 'rolled_back'].includes(existing.status)) throw new Error('Self-update уже выполняется; требуется ручная проверка')
      return prepareSelfUpdate(options)
    })
  } catch (error) { return { success: false, error: String(error) } }
}

async function prepareSelfUpdate(options: SelfUpdateOptions): Promise<SelfUpdateResult> {
  const { rootDir, daemon } = options
  const updateDir = confinedPath(rootDir, '.update')
  const platform = getPlatform()

  if (daemon.rootDir !== rootDir || daemon.version !== APP_VERSION || daemon.pid <= 0 || daemon.instanceId.length < 16) {
    return { success: false, error: 'Identity daemon не совпадает с текущим service-manager' }
  }

  const progress = options.onProgress || (() => {})
  let archivePath: string | undefined

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 1: Проверка asm-updater
    // ─────────────────────────────────────────────────────────────────────────
    progress('checking', 0, 'Проверка asm-updater...')

    const updaterName = getUpdaterName()
    const updaterPath = join(rootDir, updaterName)

    // Проверяем наличие asm-updater через Bun.file
    const updaterFile = Bun.file(updaterPath)
    if (!(await updaterFile.exists())) {
      return {
        success: false,
        error: `asm-updater не найден: ${updaterPath}. Необходимо скачать asm-updater вручную.`,
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 2: Получение метаданных версии
    // ─────────────────────────────────────────────────────────────────────────
    progress('checking', 10, 'Получение метаданных...')

    const repo = new UpdateRepository(options.config.s3)

    let targetVersion = options.targetVersion
    if (!targetVersion) {
      // Получаем последнюю версию из канала
      const channel = await repo.getChannel(options.config.channel)
      targetVersion = channel.components['service-manager']
      if (!targetVersion) {
        return { success: false, error: 'service-manager не найден в канале обновлений' }
      }
    }

    // Получаем метаданные версии
    validateVersion(targetVersion)
    const meta = await repo.getVersionMeta('service-manager', targetVersion)
    validateMeta(meta, 'service-manager', targetVersion, platform, rootDir)
    const platformInfo = meta.platforms[platform]

    if (!platformInfo) {
      return { success: false, error: `Платформа ${platform} не поддерживается` }
    }

    progress('checking', 20, `Версия ${targetVersion} найдена`)

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 3: Создание директории .update
    // ─────────────────────────────────────────────────────────────────────────
    await mkdir(updateDir, { recursive: true })

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 4: Скачивание бинарника
    // ─────────────────────────────────────────────────────────────────────────
    progress('downloading', 0, 'Скачивание...')

    archivePath = confinedPath(rootDir, '.update/archive.tar.gz')
    const downloaded = await repo.downloadArchive(
      'service-manager',
      targetVersion,
      platform,
      archivePath,
      (downloadedBytes, total) => {
        const pct = Math.round((downloadedBytes / total) * 100)
        progress('downloading', pct, `Скачивание: ${pct}%`)
      },
    )

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 5: Проверка SHA256 архива
    // ─────────────────────────────────────────────────────────────────────────
    progress('verifying', 0, 'Проверка SHA256...')

    if (downloaded.sha256.toLowerCase() !== platformInfo.archiveSha256.toLowerCase()) {
      return { success: false, error: 'Проверка SHA256 архива не пройдена' }
    }

    progress('verifying', 50, 'SHA256 архива OK')

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 6: Распаковка бинарника
    // ─────────────────────────────────────────────────────────────────────────
    progress('extracting', 0, 'Распаковка...')

    // Импортируем функцию извлечения
    const { extractFileFromTarGz } = await import('./archive')

    // Извлекаем только бинарник
    const binaryData = await extractFileFromTarGz(archivePath, platformInfo.binary)
    if (!binaryData) {
      return { success: false, error: `Бинарник ${platformInfo.binary} не найден в архиве` }
    }

    // Сохраняем как .new
    const newBinaryPath = confinedPath(rootDir, `.update/${getBinaryName()}.new`)
    await Bun.write(newBinaryPath, binaryData)

    // Устанавливаем права на выполнение (Unix)
    if (process.platform !== 'win32') {
      await chmod(newBinaryPath, 0o755)
    }

    progress('extracting', 100, 'Бинарник извлечён')

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 7: Вычисление SHA256 бинарника
    // ─────────────────────────────────────────────────────────────────────────
    progress('verifying', 75, 'Вычисление SHA256 бинарника...')

    const binarySha256 = await computeFileSha256(newBinaryPath)
    if (binarySha256 !== platformInfo.binarySha256) throw new Error('SHA256 бинарника не совпадает с метаданными')

    progress('verifying', 100, 'SHA256 бинарника вычислен')

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 8: Создание update-task.json
    // ─────────────────────────────────────────────────────────────────────────
    progress('installing', 0, 'Создание задания...')

    const currentVersion = getCurrentVersion()
    const binaryName = getBinaryName()

    const task: UpdateTask = {
      schemaVersion: 2,
      id: `upd_${Date.now()}_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      rootDir,
      components: [
        {
          name: 'service-manager',
          currentVersion,
          targetVersion,
          sourcePath: `.update/${binaryName}.new`,
          targetPath: binaryName,
          backupPath: `.update/${binaryName}.old`,
          sha256: binarySha256,
        },
      ],
      daemon,
      status: 'pending',
      handoff: { requested: true, acknowledged: false },
      postUpdateApps: { status: 'required' },
      healthCheck: {
        enabled: true,
        timeout: options.healthCheckTimeout ?? 30000,
        endpoint: 'ipc',
      },
      rollbackOnFailure: options.rollbackOnFailure ?? true,
    }

    await writeUpdateTask(rootDir, task)

    progress('installing', 50, 'Задание создано')

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 9: CLI сначала получает IPC-подтверждение controlled handoff.
    // Запуск updater до этого создавал гонку: updater видел pending task и мог
    // завершиться раньше, чем daemon подтвердит ownership.
    // ─────────────────────────────────────────────────────────────────────────
    progress('installing', 100, 'Задача подготовлена; ожидается handoff daemon')

    return {
      success: true,
      taskId: task.id,
      targetVersion,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      error: message,
    }
  } finally {
    if (archivePath) {
      await rm(archivePath, { force: true }).catch(() => undefined)
    }
  }
}

/** Запускается CLI только после успешного IPC handoff. */
export async function launchSelfUpdater(rootDir: string): Promise<void> {
  const updaterPath = confinedPath(rootDir, getUpdaterName())
  if (!(await Bun.file(updaterPath).exists())) throw new Error(`asm-updater не найден: ${updaterPath}`)
  const proc = Bun.spawn([updaterPath, '--root', rootDir], { cwd: rootDir, stdio: ['ignore', 'inherit', 'inherit'], detached: true })
  proc.unref()
}

/**
 * Проверяет, доступен ли self-update
 * @returns true если asm-updater найден
 */
export async function isSelfUpdateAvailable(rootDir: string): Promise<boolean> {
  return Bun.file(join(rootDir, getUpdaterName())).exists()
}

/** Получает путь к логу обновления в уже разрешённом корне. */
export function getUpdateLogPath(rootDir: string): string {
  return join(rootDir, '.update', 'update.log')
}

/** Читает только валидную v2-задачу. */
export async function getLastUpdateStatus(rootDir: string): Promise<UpdateTask | null> {
  return readUpdateTask(rootDir)
}
