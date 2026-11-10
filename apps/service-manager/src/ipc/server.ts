// IPC Server
// Обёртка над платформенным IPC сервером с интеграцией JSON-RPC dispatcher

import { getPlatformAdapter, type IPCServer, type MessageHandler } from '../daemon/platform'
import { parseRequest, createErrorResponse, type Response } from './protocol'
import { RpcErrorCode } from './errors'
import type { RequestHandler, RequestDispatcher } from './handlers/dispatcher'
import type { ServiceManager } from '../manager'

// ─────────────────────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────────────────────

export interface DaemonIPCServerOptions {
  // Корневая директория проекта
  rootDir: string
  // Обработчик запросов (из dispatcher)
  requestHandler: RequestHandler
  // Dispatcher для установки контекста запроса (для subscribe/unsubscribe)
  dispatcher?: RequestDispatcher
  // Менеджер сервисов (для перезапуска после обновления)
  manager: ServiceManager
  // Callback при ошибке
  onError?: (error: Error) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// DaemonIPCServer — обёртка для IPC сервера с JSON-RPC
// ─────────────────────────────────────────────────────────────────────────────

export class DaemonIPCServer {
  private readonly server: IPCServer
  private readonly requestHandler: RequestHandler
  private readonly dispatcher?: RequestDispatcher
  private readonly onErrorCallback?: (error: Error) => void
  private readonly rootDir: string
  private readonly manager: ServiceManager
  // Счётчик для генерации уникальных clientId
  private clientIdCounter = 0

  constructor(options: DaemonIPCServerOptions) {
    const adapter = getPlatformAdapter()
    const socketPath = adapter.getSocketPath(options.rootDir)

    this.server = adapter.createIPCServer(socketPath)
    this.requestHandler = options.requestHandler
    this.dispatcher = options.dispatcher
    this.onErrorCallback = options.onError
    this.rootDir = options.rootDir
    this.manager = options.manager

    // Настраиваем обработчик сообщений
    this.server.onMessage(this.createMessageHandler())

    // Настраиваем обработчик ошибок
    this.server.onError((error) => {
      console.error('[IPC Server] Ошибка:', error.message)
      if (this.onErrorCallback) {
        this.onErrorCallback(error)
      }
    })
  }

  // Путь к socket/pipe
  get path(): string {
    return this.server.path
  }

  // Запуск сервера
  async start(): Promise<void> {
    await this.server.start()
    console.log(`[IPC Server] Запущен: ${this.path}`)
  }

  // Остановка сервера
  async stop(): Promise<void> {
    await this.server.stop()
    console.log('[IPC Server] Остановлен')
  }

  // Проверка, запущен ли сервер
  isRunning(): boolean {
    return this.server.isRunning()
  }

  // Создание обработчика сообщений для IPC сервера
  private createMessageHandler(): MessageHandler {
    // Генерируем уникальный clientId для каждого соединения
    const clientId = `client_${++this.clientIdCounter}_${Date.now()}`

    return async (message: string, reply: (response: string) => void) => {
      let response: Response

      try {
        // Парсим запрос
        const parseResult = parseRequest(message)

        if (!parseResult.success) {
          // Ошибка парсинга — возвращаем error response
          response = createErrorResponse('0', parseResult.error.code, parseResult.error.message)
        } else {
          // Устанавливаем контекст запроса для поддержки subscribe и update
          if (this.dispatcher) {
            this.dispatcher.setRequestContext({
              clientId,
              rootDir: this.rootDir,
              manager: this.manager,
              sendNotification: (notification: string) => {
                // Отправляем уведомление клиенту
                reply(notification)
              },
            })
          }

          try {
            // Передаём запрос в dispatcher
            response = await this.requestHandler(parseResult.data)
          } finally {
            // Очищаем контекст после обработки
            if (this.dispatcher) {
              this.dispatcher.clearRequestContext()
            }
          }
        }
      } catch (error) {
        // Непредвиденная ошибка
        console.error('[IPC Server] Ошибка обработки:', error)
        response = createErrorResponse(
          '0',
          RpcErrorCode.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Внутренняя ошибка',
        )
      }

      // Отправляем ответ
      reply(JSON.stringify(response))
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Фабричная функция
// ─────────────────────────────────────────────────────────────────────────────

export function createDaemonIPCServer(options: DaemonIPCServerOptions): DaemonIPCServer {
  return new DaemonIPCServer(options)
}
