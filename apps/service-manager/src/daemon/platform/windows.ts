import { socketPath } from '../../../../../packages/project/src'
// Windows Platform Adapter
// Реализация для Windows (Named Pipes)

import { createServer, createConnection, type Server as NetServer, type Socket } from 'net'
import { spawn } from 'child_process'
import { open, unlink as fsUnlink, readFile, writeFile, stat, constants, mkdir } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import type { PlatformAdapter, IPCServer, IPCClient, LockHandle, DaemonizeOptions, MessageHandler } from './index'
import { PIDS_DIR, DAEMON_LOCK } from './index'

// ─────────────────────────────────────────────────────────────────────────────
// Windows IPC Server (Named Pipe)
// ─────────────────────────────────────────────────────────────────────────────

class WindowsIPCServer implements IPCServer {
  readonly path: string
  private server: NetServer | null = null
  private messageHandler: MessageHandler | null = null
  private errorHandler: ((error: Error) => void) | null = null
  private clients: Set<Socket> = new Set()

  constructor(pipePath: string) {
    this.path = pipePath
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Сервер уже запущен')
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

      // На Windows используем Named Pipe
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
          resolve()
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
// Windows IPC Client (Named Pipe)
// ─────────────────────────────────────────────────────────────────────────────

class WindowsIPCClient implements IPCClient {
  private readonly pipePath: string
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

  constructor(pipePath: string) {
    this.pipePath = pipePath
  }

  async connect(): Promise<void> {
    if (this.socket) {
      throw new Error('Клиент уже подключен')
    }

    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.pipePath, () => {
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
// Windows Lock Handle
// ─────────────────────────────────────────────────────────────────────────────

class WindowsLockHandle implements LockHandle {
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
// Windows Platform Adapter
// ─────────────────────────────────────────────────────────────────────────────

export class WindowsPlatformAdapter implements PlatformAdapter {
  readonly platform = 'windows' as const

  getSocketPath(rootDir: string): string {
    return socketPath(rootDir, 'win32')
  }

  createIPCServer(pipePath: string): IPCServer {
    return new WindowsIPCServer(pipePath)
  }

  createIPCClient(pipePath: string): IPCClient {
    return new WindowsIPCClient(pipePath)
  }

  async daemonize(execPath: string, args: string[], options?: DaemonizeOptions): Promise<number> {
    // На Windows используем PowerShell для запуска процесса в фоне
    const quotedArgs = args.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(' ')
    const psCommand = `Start-Process -FilePath "${execPath}" -ArgumentList '${quotedArgs}' -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id`

    return new Promise((resolve, reject) => {
      const ps = spawn('powershell', ['-Command', psCommand], {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      ps.stdout?.on('data', (data) => {
        stdout += data.toString()
      })

      ps.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      ps.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Не удалось запустить daemon: ${stderr}`))
          return
        }

        const pid = parseInt(stdout.trim(), 10)
        if (isNaN(pid)) {
          reject(new Error(`Невалидный PID: ${stdout}`))
          return
        }

        resolve(pid)
      })

      ps.on('error', (error) => {
        reject(error)
      })
    })
  }

  isProcessRunning(pid: number): boolean {
    try {
      // На Windows тоже работает process.kill(pid, 0)
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

      // На Windows используем writeFile с флагом 'wx' (exclusive create)
      // так как open с O_CREAT | O_EXCL не работает корректно в Bun на Windows
      await writeFile(lockPath, String(process.pid), { flag: 'wx' })

      // Открываем файл для получения handle (для совместимости с LockHandle)
      const handle = await open(lockPath, 'r+')

      return new WindowsLockHandle(lockPath, handle)
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

  // Вспомогательный метод для получения пути к lock-файлу
  getLockPath(rootDir: string): string {
    return path.join(rootDir, PIDS_DIR, DAEMON_LOCK)
  }
}
