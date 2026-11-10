// Dispatcher — маршрутизация IPC запросов к обработчикам
// Центральная точка обработки всех входящих JSON-RPC сообщений

import type { Request, Response, IpcMethod, LogEntry } from '../protocol'
import { createLogNotification } from '../protocol'
import { methodNotFound, internalError } from '../errors'
import { handleHandshake, type DaemonContext as HandshakeDaemonContext } from './handshake'
import { handleStatus, handleStart, handleStop, handleRestart, handleShutdown, handleUpdateHandoff, validateServiceCommandParams, type CommandContext } from './commands'
import type { Supervisor } from '../../daemon/supervisor'
import {
  handleLogs,
  handleSubscribe,
  handleUnsubscribe,
  subscriptionManager,
  type LogsContext,
  type SubscriptionContext,
} from './logs'
import { handleUpdateCheck, handleUpdateInstall, handleUpdateRollback, handleUpdateStatus } from './update'
import type { ServiceManager } from '../../manager'
import type { FileLogger } from '../../daemon/file-logger'
import type { UpdateCheckParams, UpdateInstallParams, UpdateRollbackParams } from '../protocol'
import { APP_VERSION } from '../../version'

// ─────────────────────────────────────────────────────────────────────────────
// Контекст daemon для dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export interface DaemonState {
  manager: ServiceManager
  pid: number
  startTime: number // timestamp запуска daemon
  version: string
  instanceId: string
  restartCounts: Map<string, number>
  // File logger для логирования (Фаза 2)
  fileLogger?: FileLogger
  // Supervisor для автоматического перезапуска сервисов
  supervisor?: Supervisor
  // Callback для graceful shutdown
  shutdown: () => Promise<void>
  handoffForUpdate?: (taskId: string) => Promise<void>
  // Корневая директория проекта (для update)
  rootDir: string
}

// Контекст для обработки запроса с информацией о клиенте
export interface RequestContext {
  // Уникальный идентификатор клиента (socket id)
  clientId: string
  // Функция отправки уведомления клиенту
  sendNotification: ((notification: string) => void) | ((method: string, params: Record<string, unknown>) => void)
  // Корневая директория проекта (для update)
  rootDir: string
  // Менеджер сервисов (для перезапуска после обновления)
  manager: ServiceManager
  // Hold pending при update/DDL. Не меняет IPC protocol.
  supervisor?: Supervisor
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher класс
// ─────────────────────────────────────────────────────────────────────────────

export class RequestDispatcher {
  private state: DaemonState
  private closing = false
  // Контекст текущего запроса (устанавливается перед dispatch)
  private currentRequestContext: RequestContext | null = null

  constructor(state: DaemonState) {
    this.state = state
  }

  /**
   * Установить контекст запроса (клиент, функция отправки уведомлений).
   * Должен вызываться перед dispatch для поддержки subscribe.
   */
  setRequestContext(context: RequestContext): void {
    this.currentRequestContext = context
  }

  /**
   * Очистить контекст запроса.
   */
  clearRequestContext(): void {
    this.currentRequestContext = null
  }

  // Обработка входящего запроса
  async dispatch(request: Request): Promise<Response> {
    const method = request.method as IpcMethod
    const mutating = ['start', 'stop', 'restart', 'shutdown', 'update.install', 'update.rollback', 'update.handoff'].includes(method)
    try {
      if (!mutating) return await this.dispatchRequest(request)
      if (this.closing) throw new Error('Daemon завершает работу; изменение сервисов запрещено')
      return await this.state.manager.withLifecycle(async () => {
        if (['start', 'stop', 'restart'].includes(method)) {
          const params = validateServiceCommandParams(request.params)
          const selected = params.services ?? this.state.manager.getAllServices().map((s) => s.name)
          const affected = method === 'stop' ? selected : this.state.manager.getStartOrder(selected)
          if (affected.some((name) => this.state.supervisor?.isPending(name))) throw new Error('Сервис удержан обновлением/handoff')
        }
        const response = await this.dispatchRequest(request)
        if (['shutdown', 'update.handoff'].includes(method) && 'result' in response) this.closing = true
        return response
      })
    } catch (error) {
      return internalError(error instanceof Error ? error.message : String(error)).toErrorResponse(request.id)
    }
  }

  private async dispatchRequest(request: Request): Promise<Response> {
    const method = request.method as IpcMethod
    try {
      switch (method) {
        case 'handshake':
          return this.handleHandshake(request)

        case 'status':
          return await this.handleStatus(request)

        case 'start':
          return await this.handleStart(request)

        case 'stop':
          return await this.handleStop(request)

        case 'restart':
          return await this.handleRestart(request)

        case 'shutdown':
          return await this.handleShutdown(request)

        case 'logs':
          return await this.handleLogs(request)

        case 'subscribe':
          return await this.handleSubscribe(request)

        case 'unsubscribe':
          return await this.handleUnsubscribe(request)

        // Update методы
        case 'update.check':
          return await this.handleUpdateCheck(request)

        case 'update.install':
          return await this.handleUpdateInstall(request)

        case 'update.rollback':
          return await this.handleUpdateRollback(request)

        case 'update.status':
          return this.handleUpdateStatus(request)

        case 'update.handoff':
          return await this.handleUpdateHandoff(request)

        default:
          const error = methodNotFound(method)
          return error.toErrorResponse(request.id)
      }
    } catch (error) {
      // Непредвиденная ошибка
      const ipcError = internalError(error instanceof Error ? error.message : String(error))
      return ipcError.toErrorResponse(request.id)
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Приватные методы для создания контекстов и вызова обработчиков
  // ───────────────────────────────────────────────────────────────────────────

  private handleHandshake(request: Request): Response {
    const context: HandshakeDaemonContext = {
      startTime: this.state.startTime,
      instanceId: this.state.instanceId,
      getServicesCount: () => this.state.manager.getAllServices().length,
    }
    return handleHandshake(request, context)
  }

  private async handleStatus(request: Request): Promise<Response> {
    const context = this.createCommandContext()
    return await handleStatus(request, context)
  }

  private async handleStart(request: Request): Promise<Response> {
    const context = this.createCommandContext()
    return await handleStart(request, context)
  }

  private async handleStop(request: Request): Promise<Response> {
    const context = this.createCommandContext()
    return await handleStop(request, context)
  }

  private async handleRestart(request: Request): Promise<Response> {
    const context = this.createCommandContext()
    return await handleRestart(request, context)
  }

  private async handleShutdown(request: Request): Promise<Response> {
    const context = this.createCommandContext()
    return await handleShutdown(request, context)
  }

  private async handleUpdateHandoff(request: Request): Promise<Response> {
    return handleUpdateHandoff(request, this.createCommandContext())
  }

  private createCommandContext(): CommandContext {
    return {
      manager: this.state.manager,
      daemonPid: this.state.pid,
      daemonStartTime: this.state.startTime,
      daemonVersion: this.state.version,
      daemonInstanceId: this.state.instanceId,
      restartCounts: this.state.restartCounts,
      onShutdown: this.state.shutdown,
      onUpdateHandoff: this.state.handoffForUpdate,
      supervisor: this.state.supervisor,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Обработчики logs/subscribe/unsubscribe
  // ───────────────────────────────────────────────────────────────────────────

  private async handleLogs(request: Request): Promise<Response> {
    if (!this.state.fileLogger) {
      const error = internalError('FileLogger не инициализирован')
      return error.toErrorResponse(request.id)
    }

    const context: LogsContext = {
      fileLogger: this.state.fileLogger,
      manager: this.state.manager,
    }
    return await handleLogs(request, context)
  }

  private async handleSubscribe(request: Request): Promise<Response> {
    if (!this.state.fileLogger) {
      const error = internalError('FileLogger не инициализирован')
      return error.toErrorResponse(request.id)
    }

    if (!this.currentRequestContext) {
      const error = internalError('Контекст запроса не установлен')
      return error.toErrorResponse(request.id)
    }

    const sendFn = this.currentRequestContext.sendNotification
    const context: SubscriptionContext = {
      fileLogger: this.state.fileLogger,
      manager: this.state.manager,
      clientId: this.currentRequestContext.clientId,
      sendNotification: (entry: LogEntry) => {
        // Преобразуем LogEntry в JSON-RPC Notification
        const notification = createLogNotification(entry.service, entry.level, entry.message)
        ;(sendFn as (n: string) => void)(JSON.stringify(notification))
      },
    }
    return await handleSubscribe(request, context)
  }

  private async handleUnsubscribe(request: Request): Promise<Response> {
    if (!this.state.fileLogger) {
      const error = internalError('FileLogger не инициализирован')
      return error.toErrorResponse(request.id)
    }

    if (!this.currentRequestContext) {
      const error = internalError('Контекст запроса не установлен')
      return error.toErrorResponse(request.id)
    }

    const context: SubscriptionContext = {
      fileLogger: this.state.fileLogger,
      manager: this.state.manager,
      clientId: this.currentRequestContext.clientId,
      sendNotification: () => {}, // Не используется при unsubscribe
    }
    return await handleUnsubscribe(request, context)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Обработчики update.*
  // ───────────────────────────────────────────────────────────────────────────

  private async handleUpdateCheck(request: Request): Promise<Response> {
    const context = this.createUpdateContext()
    try {
      const result = await handleUpdateCheck(request.params as UpdateCheckParams | undefined, context)
      return { jsonrpc: '2.0', id: request.id, result }
    } catch (error) {
      const ipcError = internalError(error instanceof Error ? error.message : String(error))
      return ipcError.toErrorResponse(request.id)
    }
  }

  private async handleUpdateInstall(request: Request): Promise<Response> {
    const context = this.createUpdateContext()
    try {
      const result = await handleUpdateInstall(request.params as UpdateInstallParams | undefined, context)
      return { jsonrpc: '2.0', id: request.id, result }
    } catch (error) {
      const ipcError = internalError(error instanceof Error ? error.message : String(error))
      return ipcError.toErrorResponse(request.id)
    }
  }

  private async handleUpdateRollback(request: Request): Promise<Response> {
    if (!request.params) {
      const error = internalError('Параметры не указаны')
      return error.toErrorResponse(request.id)
    }

    const context = this.createUpdateContext()
    try {
      const result = await handleUpdateRollback(request.params as unknown as UpdateRollbackParams, context)
      return { jsonrpc: '2.0', id: request.id, result }
    } catch (error) {
      const ipcError = internalError(error instanceof Error ? error.message : String(error))
      return ipcError.toErrorResponse(request.id)
    }
  }

  private handleUpdateStatus(request: Request): Response {
    const result = handleUpdateStatus()
    return { jsonrpc: '2.0', id: request.id, result }
  }

  private createUpdateContext(): RequestContext {
    const sendNotificationFn = this.currentRequestContext?.sendNotification
    return {
      clientId: this.currentRequestContext?.clientId || 'unknown',
      rootDir: this.state.rootDir,
      manager: this.state.manager,
      supervisor: this.state.supervisor,
      sendNotification: (methodOrNotification: string, params?: Record<string, unknown>) => {
        if (!sendNotificationFn) return

        if (params) {
          // Новый формат: method + params
          const notification = JSON.stringify({
            jsonrpc: '2.0',
            method: methodOrNotification,
            params,
          })
          ;(sendNotificationFn as (n: string) => void)(notification)
        } else {
          // Старый формат: JSON строка
          ;(sendNotificationFn as (n: string) => void)(methodOrNotification)
        }
      },
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Фабричная функция для создания dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateDispatcherOptions {
  manager: ServiceManager
  shutdown: () => Promise<void>
  fileLogger?: FileLogger
  supervisor?: Supervisor
  rootDir?: string
  instanceId?: string
  handoffForUpdate?: (taskId: string) => Promise<void>
}

export function createDispatcher(options: CreateDispatcherOptions): RequestDispatcher
export function createDispatcher(
  manager: ServiceManager,
  shutdown: () => Promise<void>,
  fileLogger?: FileLogger,
): RequestDispatcher
export function createDispatcher(
  managerOrOptions: ServiceManager | CreateDispatcherOptions,
  shutdown?: () => Promise<void>,
  fileLogger?: FileLogger,
): RequestDispatcher {
  // Поддержка обоих вариантов вызова для обратной совместимости
  let manager: ServiceManager
  let shutdownFn: () => Promise<void>
  let logger: FileLogger | undefined
  let rootDir: string
  let instanceId: string
  let handoffForUpdate: ((taskId: string) => Promise<void>) | undefined

  let supervisor: Supervisor | undefined

  if (typeof managerOrOptions === 'object' && 'manager' in managerOrOptions) {
    // Новый формат с options
    manager = managerOrOptions.manager
    shutdownFn = managerOrOptions.shutdown
    logger = managerOrOptions.fileLogger
    supervisor = managerOrOptions.supervisor
    rootDir = managerOrOptions.rootDir || process.cwd()
    instanceId = managerOrOptions.instanceId || crypto.randomUUID()
    handoffForUpdate = managerOrOptions.handoffForUpdate
  } else {
    // Старый формат с позиционными аргументами
    manager = managerOrOptions
    shutdownFn = shutdown!
    logger = fileLogger
    rootDir = process.cwd()
    instanceId = crypto.randomUUID()
  }

  const state: DaemonState = {
    manager,
    pid: process.pid,
    startTime: Date.now(),
    version: APP_VERSION,
    instanceId,
    restartCounts: new Map(),
    fileLogger: logger,
    supervisor,
    shutdown: shutdownFn,
    handoffForUpdate,
    rootDir,
  }

  return new RequestDispatcher(state)
}

// ─────────────────────────────────────────────────────────────────────────────
// Тип обработчика запросов для IPC сервера
// ─────────────────────────────────────────────────────────────────────────────

export type RequestHandler = (request: Request) => Promise<Response>

// Создание обработчика из dispatcher
export function createRequestHandler(dispatcher: RequestDispatcher): RequestHandler {
  return (request: Request) => dispatcher.dispatch(request)
}
