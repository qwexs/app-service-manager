// Lock Manager
// Управление блокировками для предотвращения запуска нескольких экземпляров daemon

import path from 'path'
import { getPlatformAdapter, PIDS_DIR, DAEMON_LOCK, DAEMON_PID, type LockHandle } from './platform'

// ─────────────────────────────────────────────────────────────────────────────
// Интерфейс менеджера блокировок
// ─────────────────────────────────────────────────────────────────────────────

export interface LockManager {
  // Попытка захватить exclusive lock для запуска daemon
  acquireExclusive(): Promise<LockHandle | null>

  // Проверить, есть ли активный daemon
  isLocked(): Promise<boolean>

  // Получить PID запущенного daemon (если есть)
  getDaemonPid(): Promise<number | null>

  // Записать PID текущего daemon
  writeDaemonPid(pid: number): Promise<void>

  // Очистить PID-файл
  clearDaemonPid(): Promise<void>

  // Проверить, запущен ли daemon с указанным PID
  isDaemonRunning(pid: number): boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Реализация Lock Manager
// ─────────────────────────────────────────────────────────────────────────────

export class DaemonLockManager implements LockManager {
  private readonly rootDir: string
  private readonly adapter = getPlatformAdapter()
  private lockHandle: LockHandle | null = null

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  // Путь к lock-файлу
  private get lockPath(): string {
    return path.join(this.rootDir, PIDS_DIR, DAEMON_LOCK)
  }

  // Путь к PID-файлу
  private get pidPath(): string {
    return path.join(this.rootDir, PIDS_DIR, DAEMON_PID)
  }

  async acquireExclusive(): Promise<LockHandle | null> {
    // Если уже держим lock — вернём его
    if (this.lockHandle) {
      return this.lockHandle
    }

    // Пытаемся захватить lock
    const handle = await this.adapter.acquireLock(this.lockPath)
    if (handle) {
      this.lockHandle = handle
    }
    return handle
  }

  async isLocked(): Promise<boolean> {
    // Проверяем существование lock-файла
    const locked = await this.adapter.isLocked(this.lockPath)
    if (!locked) {
      return false
    }

    // Lock-файл есть — проверяем, жив ли процесс
    const pid = await this.getDaemonPid()
    if (pid === null) {
      // Нет PID-файла — считаем, что lock stale
      return false
    }

    // Проверяем, работает ли процесс
    return this.isDaemonRunning(pid)
  }

  async getDaemonPid(): Promise<number | null> {
    return this.adapter.readPidFile(this.pidPath)
  }

  async writeDaemonPid(pid: number): Promise<void> {
    await this.adapter.writePidFile(this.pidPath, pid)
  }

  async clearDaemonPid(): Promise<void> {
    await this.adapter.unlink(this.pidPath)
  }

  isDaemonRunning(pid: number): boolean {
    return this.adapter.isProcessRunning(pid)
  }

  // Освободить блокировку (вызывается при остановке daemon)
  async release(): Promise<void> {
    if (!this.lockHandle) return
    // PID удаляем под lock; после release новый daemon уже может владеть им.
    await this.clearDaemonPid()
    await this.lockHandle.release()
    this.lockHandle = null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Фабричная функция
// ─────────────────────────────────────────────────────────────────────────────

export function createLockManager(rootDir: string): DaemonLockManager {
  return new DaemonLockManager(rootDir)
}
