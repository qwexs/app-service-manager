// Cleanup Module
// Очистка устаревших (stale) ресурсов daemon

import path from 'path'
import { getPlatformAdapter, PIDS_DIR, SOCKET_DIR, DAEMON_PID, DAEMON_LOCK, DAEMON_SOCKET } from './platform'

// ─────────────────────────────────────────────────────────────────────────────
// Результат очистки
// ─────────────────────────────────────────────────────────────────────────────

export interface CleanupResult {
  // Были ли очищены какие-либо ресурсы
  cleaned: boolean
  // Список очищенных ресурсов
  resources: string[]
  // PID предыдущего daemon (если был)
  stalePid?: number
  // Сообщение для логирования
  message: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Основная функция очистки
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Очищает устаревшие ресурсы от предыдущего запуска daemon.
 *
 * Выполняет следующие проверки:
 * 1. Если есть PID-файл — проверяет, жив ли процесс
 * 2. Если процесс мёртв — удаляет PID-файл, lock-файл и socket
 * 3. Если есть socket без PID-файла — удаляет socket (аварийное завершение)
 *
 * @param rootDir - Корневая директория проекта
 * @returns Результат очистки
 */
export async function cleanupStaleResources(rootDir: string): Promise<CleanupResult> {
  const adapter = getPlatformAdapter()
  const resources: string[] = []
  let stalePid: number | undefined

  // Пути к ресурсам
  const pidPath = path.join(rootDir, PIDS_DIR, DAEMON_PID)
  const lockPath = path.join(rootDir, PIDS_DIR, DAEMON_LOCK)
  const socketPath = adapter.getSocketPath(rootDir)

  // Проверяем, есть ли PID-файл
  const pid = await adapter.readPidFile(pidPath)
  const lockOwner = await adapter.readPidFile(lockPath)
  if (lockOwner !== null && adapter.isProcessRunning(lockOwner)) {
    return { cleaned: false, resources: [], message: 'Lock удерживается живым процессом' }
  }

  if (pid !== null) {
    // PID-файл существует — проверяем, жив ли процесс
    const isRunning = adapter.isProcessRunning(pid)

    if (!isRunning) {
      // Процесс мёртв — очищаем все ресурсы
      stalePid = pid

      // Удаляем PID-файл
      if (await adapter.exists(pidPath)) {
        await adapter.unlink(pidPath)
        resources.push(pidPath)
      }

      // Удаляем lock-файл
      if (await adapter.exists(lockPath)) {
        await adapter.unlink(lockPath)
        resources.push(lockPath)
      }

      // Удаляем socket (только на Unix)
      if (adapter.platform === 'unix' && (await adapter.exists(socketPath))) {
        await adapter.unlink(socketPath)
        resources.push(socketPath)
      }
    }
  } else {
    // Нет PID-файла — проверяем, остался ли socket (аварийное завершение)
    if (adapter.platform === 'unix' && (await adapter.exists(socketPath))) {
      await adapter.unlink(socketPath)
      resources.push(socketPath)
    }

    // Проверяем stale lock-файл
    if (await adapter.exists(lockPath)) {
      await adapter.unlink(lockPath)
      resources.push(lockPath)
    }
  }

  // Формируем результат
  const cleaned = resources.length > 0

  let message: string
  if (cleaned) {
    if (stalePid !== undefined) {
      message = `Очищены stale ресурсы от предыдущего daemon (PID: ${stalePid}): ${resources.length} файл(ов)`
    } else {
      message = `Очищены orphan ресурсы: ${resources.length} файл(ов)`
    }
  } else {
    message = 'Stale ресурсов не обнаружено'
  }

  return {
    cleaned,
    resources,
    stalePid,
    message,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Проверка состояния daemon
// ─────────────────────────────────────────────────────────────────────────────

export interface DaemonStatus {
  // Запущен ли daemon
  running: boolean
  // PID daemon (если запущен)
  pid?: number
  // Путь к socket
  socketPath: string
  // Доступен ли socket для подключения
  socketExists: boolean
}

/**
 * Проверяет текущее состояние daemon.
 *
 * @param rootDir - Корневая директория проекта
 * @returns Статус daemon
 */
export async function getDaemonStatus(rootDir: string): Promise<DaemonStatus> {
  const adapter = getPlatformAdapter()

  const pidPath = path.join(rootDir, PIDS_DIR, DAEMON_PID)
  const socketPath = adapter.getSocketPath(rootDir)

  const pid = await adapter.readPidFile(pidPath)
  const socketExists = await adapter.exists(socketPath)

  let running = false

  if (pid !== null) {
    running = adapter.isProcessRunning(pid)
  }

  return {
    running,
    pid: pid ?? undefined,
    socketPath,
    socketExists,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Утилита для graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Выполняет полную очистку ресурсов daemon при остановке.
 * Вызывается из daemon при graceful shutdown.
 *
 * @param rootDir - Корневая директория проекта
 */
export async function cleanupOnShutdown(rootDir: string): Promise<void> {
  const adapter = getPlatformAdapter()

  const pidPath = path.join(rootDir, PIDS_DIR, DAEMON_PID)
  const socketPath = adapter.getSocketPath(rootDir)

  // Вызывается только владельцем lock после закрытия IPC. Lock снимает его handle.
  await adapter.unlink(pidPath)

  // Socket на Unix
  if (adapter.platform === 'unix') {
    await adapter.unlink(socketPath)
  }
}
