import { socketPath } from '../../../../../packages/project/src'
// Unix Platform Adapter
// Реализация для Linux и macOS

import { createServer, createConnection, type Server as NetServer, type Socket } from 'net'
import { spawn } from 'child_process'
import { open, unlink as fsUnlink, readFile, writeFile, stat, constants, mkdir } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import type { PlatformAdapter, IPCServer, IPCClient, LockHandle, DaemonizeOptions, MessageHandler } from './index'
import { SOCKET_DIR, DAEMON_SOCKET } from './index'

// ─────────────────────────────────────────────────────────────────────────────
// Unix IPC Server (Unix Domain Socket)
// ─────────────────────────────────────────────────────────────────────────────

class UnixIPCServer implements IPCServer {
  readonly path: string
  private server: NetServer | null = null
  private messageHandler: MessageHandler | null = null
  private errorHandler: ((error: Error) => void) | null = null
  private clients: Set<Socket> = new Set()

  constructor(socketPath: string) {
    this.path = socketPath
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Сервер уже запущен')
    }

    // Убедимся, что директория существует
    const dir = path.dirname(this.path)
    await mkdir(dir, { recursive: true })

    // Удалим старый socket если существует
    try {
      await fsUnlink(this.path)
    } catch {
      // Игнорируем ошибку если файл не существует
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.clients.add(socket)
        let buffer = ''

        socket.on('data', (data) => {
          buffer += data.toString('utf-8')

          // Разбираем сообщения по разделителю \n
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.trim() && this.messageHandler) {
              this.messageHandler(line, (response) => {
                socket.write(response + '\n')
              })
            }
          }
        })

        socket.on('close', () => {
          this.clients.delete(socket)
        })

        socket.on('error', (error) => {
          this.clients.delete(socket)
          if (this.errorHandler) {
            this.errorHandler(error)
          }
        })
      })

      this.server.on('error', (error) => {
        if (this.errorHandler) {
          this.errorHandler(error)
        }
        reject(error)
      })

      this.server.listen(this.path, () => {
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    // Закрываем все клиентские соединения
    for (const client of this.clients) {
      client.destroy()
    }
    this.clients.clear()

    return new Promise((resolve, reject) => {
      this.server!.close((error) => {
        if (error) {
          reject(error)
        } else {
          this.server = null
          // Удаляем socket файл
          fsUnlink(this.path).then(resolve, (error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolve()
            else reject(error)
          })
        }
      })
    })
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }

  getServer(): NetServer | null {
    return this.server
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unix IPC Client (Unix Domain Socket)
// ─────────────────────────────────────────────────────────────────────────────

class UnixIPCClient implements IPCClient {
  private readonly socketPath: string
  private socket: Socket | null = null
  private notificationHandler: ((notification: string) => void) | null = null
  private errorHandler: ((error: Error) => void) | null = null
  private disconnectHandler: (() => void) | null = null
  private pendingRequests: Map<
    string,
    { resolve: (value: string) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
  > = new Map()
  private buffer = ''
  private requestIdCounter = 0

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  async connect(): Promise<void> {
    if (this.socket) {
      throw new Error('Клиент уже подключен')
    }

    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath, () => {
        resolve()
      })

      this.socket.on('data', (data) => {
        this.buffer += data.toString('utf-8')

        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue

          try {
            const parsed = JSON.parse(line)

            // Если есть id — это ответ на запрос
            if (parsed.id !== undefined) {
              const pending = this.pendingRequests.get(String(parsed.id))
              if (pending) {
                clearTimeout(pending.timeout)
                this.pendingRequests.delete(String(parsed.id))
                pending.resolve(line)
              }
            } else if (this.notificationHandler) {
              // Иначе это уведомление
              this.notificationHandler(line)
            }
          } catch {
            // Если не JSON — передаём как уведомление
            if (this.notificationHandler) {
              this.notificationHandler(line)
            }
          }
        }
      })

      this.socket.on('error', (error) => {
        if (this.errorHandler) {
          this.errorHandler(error)
        }
        reject(error)
      })

      this.socket.on('close', () => {
        this.socket = null
        // Отклоняем все ожидающие запросы и очищаем таймеры
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout)
          pending.reject(new Error('Соединение закрыто'))
        }
        this.pendingRequests.clear()

        if (this.disconnectHandler) {
          this.disconnectHandler()
        }
      })
    })
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      return
    }

    // Очищаем все ожидающие запросы и их таймеры
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
    }
    this.pendingRequests.clear()

    return new Promise((resolve) => {
      const socket = this.socket!
      this.socket = null

      // Таймаут на случай если сервер не отвечает на FIN
      const forceCloseTimeout = setTimeout(() => {
        socket.destroy()
        resolve()
      }, 1000)

      socket.end(() => {
        clearTimeout(forceCloseTimeout)
        resolve()
      })
    })
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  async send(message: string): Promise<string> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Не подключен к серверу')
    }

    // Извлекаем id из сообщения для отслеживания ответа
    let messageId: string
    try {
      const parsed = JSON.parse(message)
      messageId = String(parsed.id)
    } catch {
      // Если не JSON — генерируем свой id
      messageId = `client_${++this.requestIdCounter}`
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(messageId)
        reject(new Error('Таймаут ожидания ответа'))
      }, 120000) // 120 секунд таймаут (запуск Docker может быть долгим)

      this.pendingRequests.set(messageId, {
        resolve,
        reject,
        timeout,
      })

      this.socket!.write(message + '\n')
    })
  }

  onNotification(handler: (notification: string) => void): void {
    this.notificationHandler = handler
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unix Lock Handle
// ─────────────────────────────────────────────────────────────────────────────

class UnixLockHandle implements LockHandle {
  readonly path: string
  private fileHandle: FileHandle

  constructor(path: string, fileHandle: FileHandle) {
    this.path = path
    this.fileHandle = fileHandle
  }

  async release(): Promise<void> {
    try {
      await this.fileHandle.close()
      await fsUnlink(this.path)
    } catch {
      // Игнорируем ошибки при освобождении
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unix Platform Adapter
// ─────────────────────────────────────────────────────────────────────────────

export class UnixPlatformAdapter implements PlatformAdapter {
  readonly platform = 'unix' as const

  getSocketPath(rootDir: string): string {
    return socketPath(rootDir, 'darwin')
  }

  createIPCServer(socketPath: string): IPCServer {
    return new UnixIPCServer(socketPath)
  }

  createIPCClient(socketPath: string): IPCClient {
    return new UnixIPCClient(socketPath)
  }

  async daemonize(execPath: string, args: string[], options?: DaemonizeOptions): Promise<number> {
    const child = spawn(execPath, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
    })

    // Отсоединяем дочерний процесс
    child.unref()

    if (child.pid === undefined) {
      throw new Error('Не удалось запустить daemon процесс')
    }

    return child.pid
  }

  isProcessRunning(pid: number): boolean {
    try {
      // Отправка сигнала 0 проверяет существование процесса без его убийства
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async acquireLock(lockPath: string): Promise<LockHandle | null> {
    try {
      // Создаём директорию если не существует
      const dir = path.dirname(lockPath)
      await mkdir(dir, { recursive: true })

      // Пытаемся открыть файл с exclusive флагом
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o644)

      // Записываем PID для информации
      await handle.write(String(process.pid))

      return new UnixLockHandle(lockPath, handle)
    } catch (error) {
      // EEXIST означает, что файл уже заблокирован
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return null
      }
      throw error
    }
  }

  async isLocked(lockPath: string): Promise<boolean> {
    try {
      await stat(lockPath)
      return true
    } catch {
      return false
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath)
      return true
    } catch {
      return false
    }
  }

  async unlink(filePath: string): Promise<void> {
    try {
      await fsUnlink(filePath)
    } catch (error) {
      // Игнорируем ENOENT (файл не существует)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  async readPidFile(pidPath: string): Promise<number | null> {
    try {
      const content = await readFile(pidPath, 'utf-8')
      const pid = parseInt(content.trim(), 10)
      return isNaN(pid) ? null : pid
    } catch {
      return null
    }
  }

  async writePidFile(pidPath: string, pid: number): Promise<void> {
    // Создаём директорию если не существует
    const dir = path.dirname(pidPath)
    await mkdir(dir, { recursive: true })

    await writeFile(pidPath, String(pid), 'utf-8')
  }
}
