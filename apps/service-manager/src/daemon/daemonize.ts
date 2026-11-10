import { readIdentity } from '../../../../packages/project/src'
import { writeFile } from 'node:fs/promises'
// Daemonize Module
// Запуск daemon-процесса в фоновом режиме

import path from 'path'
import { getPlatformAdapter, PIDS_DIR, DAEMON_PID, type DaemonizeOptions } from './platform'
import { cleanupStaleResources, getDaemonStatus } from './cleanup'
import { createLockManager, type DaemonLockManager } from './lock'
import { createDaemonClient } from '../ipc/client'

// ─────────────────────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────────────────────

// Результат запуска daemon
export interface DaemonStartResult {
  // Успешно ли запущен daemon
  success: boolean
  // PID запущенного daemon (если успешно)
  pid?: number
  // Сообщение (ошибка или информация)
  message: string
  // Daemon уже был запущен
  alreadyRunning?: boolean
}

// Результат остановки daemon
export interface DaemonStopResult {
  // Успешно ли остановлен daemon
  success: boolean
  // PID остановленного daemon
  pid?: number
  // Сообщение
  message: string
  // Daemon не был запущен
  wasNotRunning?: boolean
}

// Опции для запуска daemon
export interface StartDaemonOptions {
  // Корневая директория проекта
  rootDir: string
  // Путь к исполняемому файлу (по умолчанию: process.execPath)
  execPath?: string
  // Аргументы для запуска daemon (по умолчанию: ['--daemon-mode'])
  args?: string[]
  // Переменные окружения
  env?: Record<string, string>
  // Принудительный перезапуск (остановить существующий daemon)
  force?: boolean
  // Таймаут ожидания готовности daemon (мс)
  readyTimeout?: number
}

// Опции для остановки daemon
export interface StopDaemonOptions {
  // Корневая директория проекта
  rootDir: string
  // Таймаут ожидания остановки (мс)
  timeout?: number
  // Принудительная остановка (SIGKILL вместо SIGTERM)
  force?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Константы
// ─────────────────────────────────────────────────────────────────────────────

// Флаг для запуска в daemon mode
export const DAEMON_MODE_FLAG = '--daemon-mode'

// Таймаут по умолчанию для ожидания готовности daemon (мс)
const DEFAULT_READY_TIMEOUT = 5000

// Таймаут по умолчанию для остановки daemon (мс)
const DEFAULT_STOP_TIMEOUT = 10000

// Интервал проверки при ожидании (мс)
const POLL_INTERVAL = 100

// ─────────────────────────────────────────────────────────────────────────────
// Запуск daemon
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Запускает daemon-процесс в фоновом режиме.
 *
 * Алгоритм:
 * 1. Проверяет, не запущен ли уже daemon
 * 2. Форкает новый процесс с флагом --daemon-mode (он сам очистит stale ресурсы)
 * 3. Ожидает готовности daemon (появление PID-файла или socket)
 * 4. Возвращает результат
 *
 * @param options - Опции запуска
 * @returns Результат запуска
 */
export async function startDaemon(options: StartDaemonOptions): Promise<DaemonStartResult> {
  const { rootDir, force = false, readyTimeout = DEFAULT_READY_TIMEOUT } = options
  const adapter = getPlatformAdapter()

  // Проверяем текущий статус daemon
  const status = await getDaemonStatus(rootDir)

  if (status.running && status.pid) {
    if (force) {
      // Принудительный перезапуск — сначала останавливаем
      const stopResult = await stopDaemon({ rootDir, force: true })
      if (!stopResult.success) {
        return {
          success: false,
          message: `Не удалось остановить существующий daemon: ${stopResult.message}`,
        }
      }
    } else {
      // Daemon уже запущен — возвращаем информацию
      return {
        success: true,
        pid: status.pid,
        message: `Daemon уже запущен (PID: ${status.pid})`,
        alreadyRunning: true,
      }
    }
  }

  // Определяем путь к исполняемому файлу
  const execPath = options.execPath ?? process.execPath

  // Определяем аргументы
  // Если execPath это bun — добавляем путь к скрипту
  const args = options.args ?? buildDaemonArgs(execPath, rootDir)

  // Опции daemonize
  const daemonizeOptions: DaemonizeOptions = {
    cwd: rootDir,
    env: options.env,
  }

  try {
    // Запускаем daemon
    const pid = await adapter.daemonize(execPath, args, daemonizeOptions)

    // Ожидаем готовности daemon
    const ready = await waitForDaemonReady(rootDir, pid, readyTimeout)

    if (!ready) {
      // PID не является доказательством владения. Не сигналим процесс по таймауту.
      return {
        success: false,
        message: `Daemon запустился (PID: ${pid}), но не стал ready в течение ${readyTimeout}мс`,
      }
    }

    return {
      success: true,
      pid,
      message: `Daemon успешно запущен (PID: ${pid})`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Ошибка запуска daemon: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Остановка daemon
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Останавливает запущенный daemon.
 *
 * Алгоритм:
 * 1. Читает PID из файла
 * 2. Отправляет SIGTERM (или SIGKILL при force)
 * 3. Ожидает завершения процесса
 * 4. Очищает ресурсы
 *
 * @param options - Опции остановки
 * @returns Результат остановки
 */
export async function stopDaemon(options: StopDaemonOptions): Promise<DaemonStopResult> {
  const client = createDaemonClient({ rootDir: options.rootDir })
  try {
    await client.connect()
    const status = await client.status()
    await client.shutdown()
    const stopped = await waitForProcessExit(status.daemon.pid, options.timeout ?? DEFAULT_STOP_TIMEOUT)
    return { success: stopped, pid: status.daemon.pid, message: stopped ? 'Daemon остановлен' : 'Остановка не подтверждена; сигнал по PID не отправлен' }
  } catch (error) {
    return { success: false, message: `IPC shutdown не подтверждён; сигнал не отправлен: ${error}` }
  } finally { await client.disconnect() }
}

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Формирует аргументы для запуска daemon.
 */
function buildDaemonArgs(execPath: string, rootDir: string): string[] {
  const args: string[] = []

  // Если запускаем через bun — добавляем путь к скрипту
  if (/^bun(?:\.exe)?$/i.test(path.basename(execPath))) {
    // Путь к index.ts относительно rootDir
    const scriptPath = path.resolve(import.meta.dir, '..', 'index.ts')
    args.push('run', scriptPath)
  }

  // Добавляем флаг daemon mode
  args.push(DAEMON_MODE_FLAG)

  // Добавляем root directory
  args.push('--root', rootDir)

  return args
}

/**
 * Ожидает готовности daemon.
 * Daemon считается ready, когда:
 * - Процесс ещё жив
 * - Появился PID-файл с корректным PID
 * - Появился socket (на Unix) или Named Pipe доступен (на Windows)
 */
async function waitForDaemonReady(rootDir: string, expectedPid: number, timeout: number): Promise<boolean> {
  const adapter = getPlatformAdapter()
  const pidPath = path.join(rootDir, PIDS_DIR, DAEMON_PID)
  const socketPath = adapter.getSocketPath(rootDir)

  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    // Проверяем, жив ли процесс
    if (!adapter.isProcessRunning(expectedPid)) {
      // Процесс умер — daemon не запустился
      return false
    }

    // Проверяем PID-файл
    const pid = await adapter.readPidFile(pidPath)
    if (pid !== expectedPid) {
      // PID-файл ещё не создан или с другим PID
      await sleep(POLL_INTERVAL)
      continue
    }

    // Проверяем socket/pipe
    const socketExists = await adapter.exists(socketPath)
    if (socketExists) {
      // Daemon ready
      return true
    }

    await sleep(POLL_INTERVAL)
  }

  // Таймаут истёк
  return false
}

/**
 * Ожидает завершения процесса.
 */
async function waitForProcessExit(pid: number, timeout: number): Promise<boolean> {
  const adapter = getPlatformAdapter()
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    if (!adapter.isProcessRunning(pid)) {
      return true
    }
    await sleep(POLL_INTERVAL)
  }

  return !adapter.isProcessRunning(pid)
}

/**
 * Проверяет, является ли текущий процесс daemon.
 */
export function isDaemonMode(): boolean {
  return process.argv.includes(DAEMON_MODE_FLAG)
}

/**
 * Получает root directory из аргументов командной строки.
 */
export function getRootDirFromArgs(): string | null {
  const rootIndex = process.argv.indexOf('--root')
  if (rootIndex !== -1 && process.argv[rootIndex + 1]) {
    return process.argv[rootIndex + 1]
  }
  return null
}

/**
 * Sleep утилита.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─────────────────────────────────────────────────────────────────────────────
// Инициализация daemon (вызывается из daemon-процесса)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Запускает daemon-процесс: чистит stale ресурсы и захватывает lock.
 * Должен вызываться из daemon-процесса после старта.
 *
 * Прямой запуск в --daemon-mode (systemd unit, self-update) не проходит через CLI,
 * поэтому stale lock/socket/PID от упавшего daemon чистим здесь: иначе старт падает
 * на «Не удалось захватить lock» и systemd-юнит уходит в failed.
 * Блокировка этапа запуска не даёт конкурентному процессу очистить только что
 * созданный lock до записи PID-файла.
 *
 * @param rootDir - Корневая директория проекта
 * @returns Lock manager для освобождения при shutdown
 */
export async function prepareDaemonStart(rootDir: string): Promise<DaemonLockManager> {
  const adapter = getPlatformAdapter()
  const startupLockPath = path.join(rootDir, PIDS_DIR, 'daemon-start.lock')
  const deadline = Date.now() + 5000
  let startupLock = await adapter.acquireLock(startupLockPath)

  while (!startupLock) {
    if (Date.now() >= deadline) {
      throw new Error('Не удалось захватить блокировку запуска daemon; stale startup lock требует ручной проверки')
    }
    await sleep(50)
    startupLock = await adapter.acquireLock(startupLockPath)
  }

  try {
    const stale = await cleanupStaleResources(rootDir)
    if (stale.cleaned) {
      console.log(stale.message)
    }

    return await initializeDaemon(rootDir)
  } finally {
    await startupLock.release()
  }
}

/**
 * Инициализирует daemon при запуске.
 *
 * Выполняет:
 * 1. Захват exclusive lock
 * 2. Запись PID-файла
 * 3. Запуск IPC сервера
 *
 * @param rootDir - Корневая директория проекта
 * @returns Lock manager для освобождения при shutdown
 */
export async function initializeDaemon(rootDir: string): Promise<DaemonLockManager> {
  const lockManager = createLockManager(rootDir)

  // Пытаемся захватить lock
  const lock = await lockManager.acquireExclusive()
  if (!lock) {
    throw new Error('Не удалось захватить lock — возможно, daemon уже запущен')
  }

  const identity = readIdentity(rootDir)
  try { await writeFile(path.join(rootDir, '.sm-identity.json'), JSON.stringify(identity, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; readIdentity(rootDir) }

  // Записываем PID
  await lockManager.writeDaemonPid(process.pid)

  return lockManager
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

// Обработчик владеет полным shutdown; при ошибке сигнал не завершает процесс.
export function setupShutdownHandlers(shutdown: () => Promise<void>): void {
  const handleSignal = (signal: string) => {
    console.log(`\nПолучен сигнал ${signal}, завершаем работу...`)
    void shutdown().catch((error) => {
      // Не освобождаем lock и не выходим с оставшимися детьми.
      console.error('Shutdown не подтверждён; требуется ручная проверка:', error)
    })
  }
  process.on('SIGTERM', () => handleSignal('SIGTERM'))
  process.on('SIGINT', () => handleSignal('SIGINT'))
  if (process.platform === 'win32') process.on('SIGBREAK', () => handleSignal('SIGBREAK'))
}
