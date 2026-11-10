// IPC Client
// Клиент для подключения к daemon и отправки команд

import { getPlatformAdapter, type IPCClient } from '../daemon/platform'
import {
  createRequest,
  parseResponse,
  isSuccessResponse,
  isErrorResponse,
  PROTOCOL_VERSION,
  type IpcMethod,
  type MethodParams,
  type MethodResults,
  type Response,
  type HandshakeResult,
  type LogNotification,
  isLogNotification,
} from './protocol'
import { IpcError, RpcErrorCode, daemonNotRunning, socketError, timeoutError } from './errors'

// ─────────────────────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────────────────────

export interface DaemonClientOptions {
  // Корневая директория проекта
  rootDir: string
  // Таймаут подключения (мс)
  connectTimeout?: number
  // Таймаут запроса (мс)
  requestTimeout?: number
  // Callback при получении лог-уведомлений
  onLog?: (log: LogNotification['params']) => void
  // Callback при отключении
  onDisconnect?: () => void
  // Callback при ошибке
  onError?: (error: Error) => void
}

// Результат вызова метода
export type CallResult<M extends IpcMethod> = MethodResults[M]

// ─────────────────────────────────────────────────────────────────────────────
// DaemonClient — клиент для подключения к daemon
// ─────────────────────────────────────────────────────────────────────────────

export class DaemonClient {
  private readonly rootDir: string
  private readonly connectTimeout: number
  private readonly requestTimeout: number
  private readonly onLogCallback?: (log: LogNotification['params']) => void
  private readonly onDisconnectCallback?: () => void
  private readonly onErrorCallback?: (error: Error) => void

  private client: IPCClient | null = null
  private handshakeCompleted = false

  constructor(options: DaemonClientOptions) {
    this.rootDir = options.rootDir
    this.connectTimeout = options.connectTimeout ?? 5000
    this.requestTimeout = options.requestTimeout ?? 120000 // 120 секунд (запуск Docker может быть долгим)
    this.onLogCallback = options.onLog
    this.onDisconnectCallback = options.onDisconnect
    this.onErrorCallback = options.onError
  }

  // Подключение к daemon
  async connect(): Promise<void> {
    if (this.client?.isConnected()) {
      return
    }

    const adapter = getPlatformAdapter()
    const socketPath = adapter.getSocketPath(this.rootDir)

    // Проверяем существование socket/pipe
    const exists = await adapter.exists(socketPath)
    if (!exists) {
      throw daemonNotRunning()
    }

    // Создаём клиент
    this.client = adapter.createIPCClient(socketPath)

    // Настраиваем обработчики
    this.client.onNotification((notification) => {
      this.handleNotification(notification)
    })

    this.client.onError((error) => {
      if (this.onErrorCallback) {
        this.onErrorCallback(error)
      }
    })

    this.client.onDisconnect(() => {
      this.handshakeCompleted = false
      if (this.onDisconnectCallback) {
        this.onDisconnectCallback()
      }
    })

    // Подключаемся с таймаутом
    const client = this.client
    try {
      await this.withTimeout(client.connect(), this.connectTimeout, 'Таймаут подключения к daemon')
    } catch (error) {
      try {
        await client.disconnect()
      } finally {
        if (this.client === client) this.client = null
      }
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        throw daemonNotRunning()
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw daemonNotRunning()
      }
      throw socketError(error instanceof Error ? error.message : 'Ошибка подключения')
    }

    // Выполняем handshake
    try {
      await this.performHandshake()
    } catch (error) {
      if (this.client === client) {
        try {
          await client.disconnect()
        } finally {
          this.client = null
          this.handshakeCompleted = false
        }
      }
      throw error
    }
  }

  // Отключение от daemon
  async disconnect(): Promise<void> {
    if (!this.client) {
      return
    }

    try {
      await this.client.disconnect()
    } finally {
      this.client = null
      this.handshakeCompleted = false
    }
  }

  // Проверка подключения
  isConnected(): boolean {
    return this.client?.isConnected() ?? false
  }

  // Вызов метода daemon
  async call<M extends IpcMethod>(method: M, params?: MethodParams[M]): Promise<CallResult<M>> {
    if (!this.client?.isConnected()) {
      throw socketError('Не подключен к daemon')
    }

    // Создаём запрос
    const request = createRequest(method, params)
    const requestJson = JSON.stringify(request)

    // Отправляем запрос с таймаутом
    let responseJson: string
    try {
      responseJson = await this.withTimeout(
        this.client.send(requestJson),
        this.requestTimeout,
        `Таймаут выполнения команды ${method}`,
      )
    } catch (error) {
      if (error instanceof IpcError) {
        throw error
      }
      throw socketError(error instanceof Error ? error.message : 'Ошибка отправки')
    }

    // Парсим ответ
    const parseResult = parseResponse(responseJson)
    if (!parseResult.success) {
      throw new IpcError(parseResult.error.code as RpcErrorCode, parseResult.error.message)
    }

    const response = parseResult.data

    // Проверяем тип ответа
    if (isErrorResponse(response)) {
      throw new IpcError(response.error.code as RpcErrorCode, response.error.message, response.error.data)
    }

    if (isSuccessResponse(response)) {
      return response.result as CallResult<M>
    }

    // Неожиданный формат ответа
    throw new IpcError(RpcErrorCode.INTERNAL_ERROR, 'Неожиданный формат ответа')
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Удобные методы для вызова команд
  // ─────────────────────────────────────────────────────────────────────────

  async status(): Promise<MethodResults['status']> {
    return this.call('status')
  }

  async start(services?: string[]): Promise<MethodResults['start']> {
    return this.call('start', services ? { services } : undefined)
  }

  async stop(services?: string[]): Promise<MethodResults['stop']> {
    return this.call('stop', services ? { services } : undefined)
  }

  async restart(services?: string[]): Promise<MethodResults['restart']> {
    return this.call('restart', services ? { services } : undefined)
  }

  async shutdown(): Promise<MethodResults['shutdown']> {
    return this.call('shutdown')
  }

  async logs(service?: string, lines?: number): Promise<MethodResults['logs']> {
    const params: { service?: string; lines?: number } = {}
    if (service) params.service = service
    if (lines) params.lines = lines
    return this.call('logs', Object.keys(params).length > 0 ? params : undefined)
  }

  async subscribe(service?: string): Promise<MethodResults['subscribe']> {
    return this.call('subscribe', service ? { service } : undefined)
  }

  async unsubscribe(): Promise<MethodResults['unsubscribe']> {
    return this.call('unsubscribe')
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Приватные методы
  // ─────────────────────────────────────────────────────────────────────────

  private async performHandshake(): Promise<void> {
    const result = await this.call('handshake', { version: PROTOCOL_VERSION })

    if (!result.compatible) {
      await this.disconnect()
      throw new IpcError(
        RpcErrorCode.VERSION_MISMATCH,
        `Несовместимые версии: daemon v${result.version}, client v${PROTOCOL_VERSION}`,
        { daemonVersion: result.version, clientVersion: PROTOCOL_VERSION },
      )
    }

    this.handshakeCompleted = true
  }

  private handleNotification(notificationJson: string): void {
    try {
      const parsed = JSON.parse(notificationJson)

      // Проверяем, является ли это лог-уведомлением
      if (isLogNotification(parsed) && this.onLogCallback) {
        this.onLogCallback(parsed.params)
      }
    } catch {
      // Игнорируем невалидные уведомления
    }
  }

  private async withTimeout<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(timeoutError(message)), ms)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Фабричная функция
// ─────────────────────────────────────────────────────────────────────────────

export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
  return new DaemonClient(options)
}

// ─────────────────────────────────────────────────────────────────────────────
// Утилита для одноразового вызова команды
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Подключается к daemon, выполняет команду и отключается.
 * Удобно для CLI-вызовов.
 */
export async function callDaemon<M extends IpcMethod>(
  rootDir: string,
  method: M,
  params?: MethodParams[M],
): Promise<CallResult<M>> {
  const client = createDaemonClient({ rootDir })

  try {
    await client.connect()
    return await client.call(method, params)
  } finally {
    await client.disconnect()
  }
}

/**
 * Проверяет, запущен ли daemon.
 */
export async function isDaemonRunning(rootDir: string): Promise<boolean> {
  const adapter = getPlatformAdapter()
  const socketPath = adapter.getSocketPath(rootDir)

  // Проверяем существование socket
  const exists = await adapter.exists(socketPath)
  if (!exists) {
    return false
  }

  // Пробуем подключиться
  const client = createDaemonClient({ rootDir, connectTimeout: 1000 })
  try {
    await client.connect()
    await client.disconnect()
    return true
  } catch {
    return false
  }
}
