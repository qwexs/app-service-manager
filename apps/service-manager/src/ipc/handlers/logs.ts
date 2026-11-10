// Обработчики IPC команд для логов
// Методы: logs, subscribe, unsubscribe

import {
  createSuccessResponse,
  type Request,
  type SuccessResponse,
  type ErrorResponse,
  type LogsParams,
  type LogsResult,
  type SubscribeParams,
  type SubscribeResult,
  type UnsubscribeResult,
  type LogEntry,
} from '../protocol'
import { invalidParams, serviceNotFound, internalError } from '../errors'
import type { FileLogger } from '../../daemon/file-logger'
import type { ServiceManager } from '../../manager'

// ─────────────────────────────────────────────────────────────────────────────
// Контекст для обработчиков логов
// ─────────────────────────────────────────────────────────────────────────────

export interface LogsContext {
  // Файловый логгер daemon
  fileLogger: FileLogger
  // Менеджер сервисов (для валидации имён)
  manager: ServiceManager
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы ответов
// ─────────────────────────────────────────────────────────────────────────────

export type LogsResponse = SuccessResponse<LogsResult> | ErrorResponse
export type SubscribeResponse = SuccessResponse<SubscribeResult> | ErrorResponse
export type UnsubscribeResponse = SuccessResponse<UnsubscribeResult> | ErrorResponse

// ─────────────────────────────────────────────────────────────────────────────
// Валидация параметров
// ─────────────────────────────────────────────────────────────────────────────

export function validateLogsParams(params: unknown): LogsParams {
  // params может быть undefined — это валидно (все логи)
  if (params === undefined || params === null) {
    return {}
  }

  if (typeof params !== 'object') {
    throw invalidParams('Параметры должны быть объектом')
  }

  const obj = params as Record<string, unknown>
  const result: LogsParams = {}

  // service — опциональная строка
  if (obj.service !== undefined) {
    if (typeof obj.service !== 'string') {
      throw invalidParams('Параметр service должен быть строкой')
    }
    result.service = obj.service
  }

  // lines — опциональное число
  if (obj.lines !== undefined) {
    if (typeof obj.lines !== 'number' || !Number.isInteger(obj.lines) || obj.lines < 1) {
      throw invalidParams('Параметр lines должен быть положительным целым числом')
    }
    result.lines = obj.lines
  }

  return result
}

export function validateSubscribeParams(params: unknown): SubscribeParams {
  // params может быть undefined — подписка на все сервисы
  if (params === undefined || params === null) {
    return {}
  }

  if (typeof params !== 'object') {
    throw invalidParams('Параметры должны быть объектом')
  }

  const obj = params as Record<string, unknown>
  const result: SubscribeParams = {}

  // service — опциональная строка
  if (obj.service !== undefined) {
    if (typeof obj.service !== 'string') {
      throw invalidParams('Параметр service должен быть строкой')
    }
    result.service = obj.service
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработчик logs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Получить последние N строк логов.
 */
export async function handleLogs(request: Request, context: LogsContext): Promise<LogsResponse> {
  try {
    const params = validateLogsParams(request.params)
    const { fileLogger, manager } = context

    // Валидация имени сервиса если указано
    if (params.service) {
      const service = manager.getService(params.service)
      if (!service) {
        const error = serviceNotFound(params.service)
        return error.toErrorResponse(request.id)
      }
    }

    // Получаем логи
    const logs = await fileLogger.getLogs(params.service, params.lines ?? 100)

    const result: LogsResult = { logs }
    return createSuccessResponse(request.id, result)
  } catch (error) {
    const ipcError = internalError(error instanceof Error ? error.message : String(error))
    return ipcError.toErrorResponse(request.id)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Менеджер подписок
// ─────────────────────────────────────────────────────────────────────────────

// Хранилище подписок для каждого клиента
// Ключ — идентификатор клиента (будет передаваться через context)
export class SubscriptionManager {
  // Map: clientId → unsubscribe function
  private subscriptions: Map<string, () => void> = new Map()

  /**
   * Подписать клиента на логи.
   */
  subscribe(
    clientId: string,
    fileLogger: FileLogger,
    service: string | undefined,
    sendNotification: (entry: LogEntry) => void,
  ): boolean {
    // Отписываем предыдущую подписку если была
    this.unsubscribe(clientId)

    // Создаём новую подписку
    const unsubscribe = service
      ? fileLogger.subscribeToService(service, sendNotification)
      : fileLogger.subscribe(sendNotification)

    this.subscriptions.set(clientId, unsubscribe)
    return true
  }

  /**
   * Отписать клиента от логов.
   */
  unsubscribe(clientId: string): boolean {
    const unsubscribe = this.subscriptions.get(clientId)
    if (unsubscribe) {
      unsubscribe()
      this.subscriptions.delete(clientId)
      return true
    }
    return false
  }

  /**
   * Проверить, подписан ли клиент.
   */
  isSubscribed(clientId: string): boolean {
    return this.subscriptions.has(clientId)
  }

  /**
   * Очистить все подписки (при остановке daemon).
   */
  clear(): void {
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe()
    }
    this.subscriptions.clear()
  }
}

// Глобальный менеджер подписок (singleton)
export const subscriptionManager = new SubscriptionManager()

// ─────────────────────────────────────────────────────────────────────────────
// Контекст для subscribe/unsubscribe с clientId
// ─────────────────────────────────────────────────────────────────────────────

export interface SubscriptionContext {
  // Файловый логгер daemon
  fileLogger: FileLogger
  // Менеджер сервисов (для валидации имён)
  manager: ServiceManager
  // Уникальный идентификатор клиента (например, socket id)
  clientId: string
  // Функция отправки уведомления клиенту
  sendNotification: (entry: LogEntry) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработчик subscribe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Подписаться на streaming логов.
 */
export async function handleSubscribe(request: Request, context: SubscriptionContext): Promise<SubscribeResponse> {
  try {
    const params = validateSubscribeParams(request.params)
    const { fileLogger, manager, clientId, sendNotification } = context

    // Валидация имени сервиса если указано
    if (params.service) {
      const service = manager.getService(params.service)
      if (!service) {
        const error = serviceNotFound(params.service)
        return error.toErrorResponse(request.id)
      }
    }

    // Подписываем клиента
    const subscribed = subscriptionManager.subscribe(clientId, fileLogger, params.service, sendNotification)

    const result: SubscribeResult = { subscribed }
    return createSuccessResponse(request.id, result)
  } catch (error) {
    const ipcError = internalError(error instanceof Error ? error.message : String(error))
    return ipcError.toErrorResponse(request.id)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработчик unsubscribe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Отписаться от streaming логов.
 */
export async function handleUnsubscribe(request: Request, context: SubscriptionContext): Promise<UnsubscribeResponse> {
  try {
    const { clientId } = context

    // Отписываем клиента
    const unsubscribed = subscriptionManager.unsubscribe(clientId)

    const result: UnsubscribeResult = { unsubscribed }
    return createSuccessResponse(request.id, result)
  } catch (error) {
    const ipcError = internalError(error instanceof Error ? error.message : String(error))
    return ipcError.toErrorResponse(request.id)
  }
}
