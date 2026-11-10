// Daemon Runner
// Запуск daemon-процесса с IPC сервером и Supervisor

import { ServiceManager } from '../manager'
import { createDaemonIPCServer, type DaemonIPCServer } from '../ipc/server'
import { createDispatcher, createRequestHandler } from '../ipc/handlers'
import { prepareDaemonStart, setupShutdownHandlers } from './daemonize'
import { createShutdown } from './shutdown'
import type { DaemonLockManager } from './lock'
import { cleanupOnShutdown } from './cleanup'
import { createFileLogger, type FileLogger } from './file-logger'
import { createSupervisor, type Supervisor, type AutoRestartConfig } from './supervisor'
import { restartAppsAfterSelfUpdate } from './post-self-update'
import { readUpdateTask, writeUpdateTask } from '../update/task-store'
import { logger } from '../utils/logger'
import { tryParseUpdateConfig, hoursToCron } from '../update/config'
import { UpdateService, type CurrentVersions } from '../update/service'
import { APP_VERSION } from '../version'
import path from 'path'

// ─────────────────────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────────────────────

export interface DaemonRunnerOptions {
  // Корневая директория проекта
  rootDir: string
  // Конфигурация автоперезапуска (опционально)
  autoRestartConfig?: Partial<AutoRestartConfig>
}

export interface DaemonRunnerContext {
  manager: ServiceManager
  ipcServer: DaemonIPCServer
  lockManager: DaemonLockManager
  fileLogger: FileLogger
  supervisor: Supervisor
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon Runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Запускает daemon-процесс.
 * Должен вызываться только из daemon-процесса (после fork/daemonize).
 *
 * Выполняет:
 * 1. Инициализацию lock-файла
 * 2. Создание FileLogger
 * 3. Создание ServiceManager
 * 4. Создание Supervisor
 * 5. Миграция со старого режима (если требуется)
 * 6. Запуск IPC сервера
 * 7. После self-update — restart группы apps
 * 8. Запуск Supervisor (health check)
 * 9. Настройку graceful shutdown
 */
export async function runDaemon(options: DaemonRunnerOptions): Promise<DaemonRunnerContext> {
  const { rootDir, autoRestartConfig } = options

  const instanceId = crypto.randomUUID()
  // Replacement не захватывает PID/lock и не открывает IPC, пока updater не
  // сохранил его PID+gate в durable task.
  await claimReplacementGate(rootDir, instanceId)

  logger.header('Daemon Mode')
  logger.info('daemon', `PID: ${process.pid}`)
  logger.info('daemon', `Root: ${rootDir}`)

  // 1. Инициализация lock-файла (со чисткой stale ресурсов от упавшего daemon)
  logger.info('daemon', 'Захват блокировки...')
  const lockManager = await prepareDaemonStart(rootDir)
  logger.success('daemon', 'Блокировка захвачена')

  // 2. Инициализация FileLogger
  logger.info('daemon', 'Инициализация FileLogger...')
  const fileLogger = createFileLogger(rootDir)
  await fileLogger.initialize()
  logger.success('daemon', 'FileLogger инициализирован')

  // Падение daemon иначе не оставляет следов: stdout/stderr daemon-процесса отцеплены,
  // а в файлы пишутся только явные вызовы fileLogger. Пишем причину и выходим с кодом 1,
  // чтобы supervisor/systemd перезапустили daemon.
  let crashing = false
  const logCrash = (kind: string, error: unknown): void => {
    if (crashing) return
    crashing = true
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    try {
      console.error(`${kind}: ${message}`)
    } catch {
      // stderr может быть закрыт — не мешаем записи в файл
    }
    void fileLogger.log('daemon', 'error', `${kind}: ${message}`)
      .catch(() => {})
      .finally(() => process.exit(1))
  }
  process.on('uncaughtException', (error) => logCrash('uncaughtException', error))
  process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason))

  // 3. Создание ServiceManager
  logger.info('daemon', 'Инициализация ServiceManager...')
  const manager = new ServiceManager(rootDir)
  logger.success('daemon', 'ServiceManager инициализирован')

  // 4. Подписка на вывод сервисов для записи в FileLogger
  logger.info('daemon', 'Подключение логирования сервисов...')
  for (const service of manager.getAllServices()) {
    service.on((event) => {
      if (event.type === 'output' && event.data) {
        const { type, data } = event.data as { type: 'stdout' | 'stderr'; data: string }
        if (type === 'stdout') {
          fileLogger.stdout(service.name, data)
        } else {
          fileLogger.stderr(service.name, data)
        }
      }
    })
  }
  logger.success('daemon', 'Логирование сервисов подключено')

  // 5. Создание Supervisor
  logger.info('daemon', 'Инициализация Supervisor...')
  const supervisor = createSupervisor({
    manager,
    config: autoRestartConfig,
    fileLogger,
  })
  logger.success('daemon', 'Supervisor инициализирован')

  // 6. Legacy PID adoption удалён. Новый daemon владеет только процессами,
  // которые он сам запустил через ServiceManager/Supervisor.

  let ipcServer: DaemonIPCServer | null = null

  // До handoff останавливаем свои Bun children; Compose остаётся в своём namespace.
  const handoffForUpdate = async (taskId: string): Promise<void> => {
    const task = await readUpdateTask(rootDir)
    if (!task || task.id !== taskId) throw new Error('Задача handoff не принадлежит этому daemon')
    const matchesCurrentDaemon = (identity: { pid: number; instanceId: string; rootDir: string; version: string } | undefined): boolean =>
      identity?.pid === process.pid && identity.instanceId === instanceId
      && identity.rootDir === rootDir && identity.version === APP_VERSION
    const isOldDaemon = task.status === 'pending' && matchesCurrentDaemon(task.daemon)
    const isReplacement = task.status === 'in_progress' && matchesCurrentDaemon(task.replacement?.identity)
    if (!isOldDaemon && !isReplacement) throw new Error('Identity handoff не совпадает с задачей')
    const apps = manager.getAllServices().filter((s) => s.config.type === 'bun').map((s) => s.name)
    supervisor.beginPending(apps)
    await manager.stopStrict(apps)
    if (isOldDaemon) {
      task.handoff.acknowledged = true
      task.status = 'in_progress'
      await writeUpdateTask(rootDir, task)
    }
    setTimeout(() => {
      void (async () => {
        supervisor.stop()
        await ipcServer?.stop()
        updateCheckJob?.stop()
        await fileLogger.close()
        await cleanupOnShutdown(rootDir)
        await lockManager.release()
        process.exit(0)
      })().catch((error) => logger.error('daemon', `Handoff shutdown не подтверждён: ${error}`))
    }, 250)
  }

  // 7. Создание dispatcher с интеграцией Supervisor
  // Supervisor стартуем после IPC и post-self-update, чтобы handshake
  // updater'а не ждал рестарт приложений и не гонялся с manager.restart.
  let updateCheckJob: { stop: () => void } | null = null
  const shutdownResources = createShutdown({
    stopMonitoring: () => { updateCheckJob?.stop(); supervisor.stop() },
    stopServices: () => manager.stop(),
    stopIPC: async () => { await ipcServer?.stop() },
    closeLogger: () => fileLogger.close(),
    cleanup: () => cleanupOnShutdown(rootDir),
    releaseLock: () => lockManager.release(),
  })
  const shutdownCallback = async () => {
    await manager.withLifecycle(shutdownResources)
    process.exit(0)
  }

  const dispatcher = createDispatcher({
    manager,
    shutdown: shutdownCallback,
    fileLogger,
    supervisor,
    rootDir,
    instanceId,
    handoffForUpdate,
  })

  // Подменяем restartCounts на данные из Supervisor
  // Это обеспечивает совместимость с существующим dispatcher
  const originalState = (dispatcher as unknown as { state: { restartCounts: Map<string, number> } }).state
  if (originalState) {
    // Переопределяем getter для restartCounts чтобы брать данные из Supervisor
    Object.defineProperty(originalState, 'restartCounts', {
      get: () => supervisor.getRestartCounts(),
    })
  }

  const requestHandler = createRequestHandler(dispatcher)

  // 8. Запуск IPC сервера
  logger.info('daemon', 'Запуск IPC сервера...')
  ipcServer = createDaemonIPCServer({
    rootDir,
    requestHandler,
    dispatcher,
    manager,
    onError: (error) => {
      logger.error('daemon', `Ошибка IPC: ${error.message}`)
      fileLogger.log('daemon', 'error', `Ошибка IPC: ${error.message}`)
    },
  })

  await ipcServer.start()
  logger.success('daemon', `IPC сервер запущен: ${ipcServer.path}`)

  // 10. После self-update поднимаем приложения: updater стартует только daemon
  await manager.withLifecycle(() => restartAppsAfterSelfUpdate({
    rootDir, manager, supervisor, fileLogger,
    daemon: { pid: process.pid, instanceId, version: APP_VERSION },
  }))

  // 11. Supervisor после рестарта приложений — иначе health loop увидит stop
  supervisor.start()
  logger.success('daemon', 'Supervisor запущен')

  // Автопроверка обновлений (in-process Bun.cron). 0 = выкл.
  updateCheckJob = startUpdateCheckCron(rootDir, fileLogger)

  // 12. Настройка graceful shutdown
  setupShutdownHandlers(shutdownCallback)

  // Логируем события Supervisor
  supervisor.on((event) => {
    const message = formatSupervisorEvent(event)
    fileLogger.log('supervisor', getEventLogLevel(event.type), message)
  })

  logger.separator()
  logger.success('daemon', 'Daemon готов к работе')
  logger.info('daemon', 'Ожидание команд через IPC...')
  fileLogger.log('daemon', 'info', 'Daemon готов к работе')

  return {
    manager,
    ipcServer,
    lockManager,
    fileLogger,
    supervisor,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

function formatSupervisorEvent(event: { type: string; service: string; data?: unknown }): string {
  switch (event.type) {
    case 'service:crashed':
      return `Сервис ${event.service} упал`
    case 'service:restarting':
      return `Перезапуск сервиса ${event.service}...`
    case 'service:restarted':
      return `Сервис ${event.service} перезапущен (всего: ${(event.data as { restarts?: number })?.restarts || 0})`
    case 'service:failed':
      return `Сервис ${event.service} помечен как failed (превышен лимит перезапусков)`
    case 'service:healthy':
      return `Сервис ${event.service} здоров`
    case 'service:unhealthy':
      return `Сервис ${event.service} не прошёл health check`
    default:
      return `Событие ${event.type} для ${event.service}`
  }
}

function getEventLogLevel(type: string): 'info' | 'warn' | 'error' {
  switch (type) {
    case 'service:crashed':
    case 'service:failed':
      return 'error'
    case 'service:restarting':
    case 'service:unhealthy':
      return 'warn'
    default:
      return 'info'
  }
}

function startUpdateCheckCron(rootDir: string, fileLogger: FileLogger): { stop: () => void } | null {
  const config = tryParseUpdateConfig()
  if (!config || config.checkInterval <= 0) {
    return null
  }

  const schedule = hoursToCron(config.checkInterval)
  logger.info('daemon', `Автопроверка обновлений: каждые ${config.checkInterval} ч (${schedule})`)
  fileLogger.log('update', 'info', `Автопроверка обновлений включена: ${schedule}`)

  const job = Bun.cron(schedule, async () => {
    try {
      const currentVersions = await readCurrentVersions(rootDir)
      const service = new UpdateService({ config, rootDir, currentVersions })
      const updates = await service.checkUpdates()
      const available = updates.filter((item) => item.hasUpdate)
      if (available.length === 0) {
        fileLogger.log('update', 'info', 'Автопроверка: обновлений нет')
        return
      }
      const summary = available.map((item) => `${item.component} ${item.currentVersion} → ${item.latestVersion}`).join(', ')
      fileLogger.log('update', 'info', `Доступны обновления: ${summary}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fileLogger.log('update', 'warn', `Автопроверка обновлений не удалась: ${message}`)
    }
  })

  return job
}

async function readCurrentVersions(rootDir: string): Promise<CurrentVersions> {
  const readVersion = async (dir: string): Promise<string> => {
    const file = Bun.file(path.join(rootDir, dir, '.version'))
    if (!(await file.exists())) return '0.0.0'
    const version = (await file.text()).trim()
    return version || '0.0.0'
  }

  return {
    'service-manager': APP_VERSION,
    app: await readVersion('app'),
  }
}


/**
 * A direct replacement daemon must not expose IPC before updater persisted the
 * PID/gate pair. Normal daemon starts have no gate and skip this path.
 */
async function claimReplacementGate(rootDir: string, instanceId: string): Promise<void> {
  const taskId = valueAfter('--update-task')
  const gate = valueAfter('--update-gate')
  if (!taskId && !gate) return
  if (!taskId || !gate) throw new Error('Неполный gate self-update')

  for (let attempt = 0; attempt < 50; attempt++) {
    const task = await readUpdateTask(rootDir)
    if (task?.id === taskId && task.status === 'in_progress'
      && task.replacement?.pid === process.pid && task.replacement.gate === gate) {
      task.replacement.identity = { pid: process.pid, instanceId, rootDir, version: APP_VERSION }
      await writeUpdateTask(rootDir, task)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error('Updater не подтвердил ownership replacement daemon')
}

function valueAfter(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
