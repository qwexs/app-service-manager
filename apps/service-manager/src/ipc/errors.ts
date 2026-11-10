// Коды ошибок JSON-RPC для IPC протокола
// Соответствует спецификации JSON-RPC 2.0 и расширениям для daemon

import { createErrorResponse, type ErrorResponse, type RequestId, type RpcError } from './protocol'

// ─────────────────────────────────────────────────────────────────────────────
// Стандартные коды ошибок JSON-RPC 2.0
// ─────────────────────────────────────────────────────────────────────────────

export const RpcErrorCode = {
  // Стандартные ошибки JSON-RPC 2.0
  PARSE_ERROR: -32700, // Невалидный JSON
  INVALID_REQUEST: -32600, // Неверная структура запроса
  METHOD_NOT_FOUND: -32601, // Неизвестный метод
  INVALID_PARAMS: -32602, // Неверные параметры
  INTERNAL_ERROR: -32603, // Внутренняя ошибка

  // Кастомные ошибки daemon (-32000 to -32099 зарезервированы для сервера)
  VERSION_MISMATCH: -32000, // Несовместимые версии CLI и Daemon
  SERVICE_NOT_FOUND: -32001, // Сервис не существует
  SERVICE_ALREADY_RUNNING: -32002, // Сервис уже запущен
  SERVICE_FAILED: -32003, // Ошибка запуска/остановки сервиса
  DAEMON_NOT_RUNNING: -32004, // Daemon не запущен
  DAEMON_ALREADY_RUNNING: -32005, // Daemon уже запущен
  LOCK_FAILED: -32006, // Не удалось захватить lock
  SOCKET_ERROR: -32007, // Ошибка сокета
  TIMEOUT: -32008, // Таймаут операции
} as const

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode]

// ─────────────────────────────────────────────────────────────────────────────
// Описания ошибок для пользователя
// ─────────────────────────────────────────────────────────────────────────────

export const RpcErrorMessage: Record<RpcErrorCode, string> = {
  [RpcErrorCode.PARSE_ERROR]: 'Parse error: невалидный JSON',
  [RpcErrorCode.INVALID_REQUEST]: 'Invalid Request: неверная структура запроса',
  [RpcErrorCode.METHOD_NOT_FOUND]: 'Method not found: неизвестный метод',
  [RpcErrorCode.INVALID_PARAMS]: 'Invalid params: неверные параметры',
  [RpcErrorCode.INTERNAL_ERROR]: 'Internal error: внутренняя ошибка daemon',
  [RpcErrorCode.VERSION_MISMATCH]: 'Version mismatch: несовместимые версии CLI и Daemon',
  [RpcErrorCode.SERVICE_NOT_FOUND]: 'Service not found: сервис не существует',
  [RpcErrorCode.SERVICE_ALREADY_RUNNING]: 'Service already running: сервис уже запущен',
  [RpcErrorCode.SERVICE_FAILED]: 'Service failed: ошибка сервиса',
  [RpcErrorCode.DAEMON_NOT_RUNNING]: 'Daemon not running: daemon не запущен',
  [RpcErrorCode.DAEMON_ALREADY_RUNNING]: 'Daemon already running: daemon уже запущен',
  [RpcErrorCode.LOCK_FAILED]: 'Lock failed: не удалось захватить блокировку',
  [RpcErrorCode.SOCKET_ERROR]: 'Socket error: ошибка соединения',
  [RpcErrorCode.TIMEOUT]: 'Timeout: превышено время ожидания',
}

// ─────────────────────────────────────────────────────────────────────────────
// Класс ошибки RPC для удобного использования
// ─────────────────────────────────────────────────────────────────────────────

export class IpcError extends Error {
  readonly code: RpcErrorCode
  readonly data?: unknown

  constructor(code: RpcErrorCode, message?: string, data?: unknown) {
    super(message ?? RpcErrorMessage[code])
    this.name = 'IpcError'
    this.code = code
    this.data = data
  }

  // Преобразование в RpcError для ответа
  toRpcError(): RpcError {
    return {
      code: this.code,
      message: this.message,
      ...(this.data !== undefined && { data: this.data }),
    }
  }

  // Создание ErrorResponse для отправки клиенту
  toErrorResponse(id: RequestId): ErrorResponse {
    return createErrorResponse(id, this.code, this.message, this.data)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Фабричные функции для создания типичных ошибок
// ─────────────────────────────────────────────────────────────────────────────

export function parseError(details?: string): IpcError {
  return new IpcError(RpcErrorCode.PARSE_ERROR, details ?? RpcErrorMessage[RpcErrorCode.PARSE_ERROR])
}

export function invalidRequest(details?: string): IpcError {
  return new IpcError(RpcErrorCode.INVALID_REQUEST, details ?? RpcErrorMessage[RpcErrorCode.INVALID_REQUEST])
}

export function methodNotFound(method: string): IpcError {
  return new IpcError(RpcErrorCode.METHOD_NOT_FOUND, `Метод "${method}" не найден`)
}

export function invalidParams(details?: string): IpcError {
  return new IpcError(RpcErrorCode.INVALID_PARAMS, details ?? RpcErrorMessage[RpcErrorCode.INVALID_PARAMS])
}

export function internalError(details?: string): IpcError {
  return new IpcError(RpcErrorCode.INTERNAL_ERROR, details ?? RpcErrorMessage[RpcErrorCode.INTERNAL_ERROR])
}

export function versionMismatch(daemonVersion: string, clientVersion: string, minClientVersion: string): IpcError {
  return new IpcError(
    RpcErrorCode.VERSION_MISMATCH,
    `Несовместимость версий: daemon v${daemonVersion}, client v${clientVersion}. Требуется клиент v${minClientVersion}+`,
    { daemonVersion, minClientVersion },
  )
}

export function serviceNotFound(serviceName: string): IpcError {
  return new IpcError(RpcErrorCode.SERVICE_NOT_FOUND, `Сервис "${serviceName}" не найден`)
}

export function serviceAlreadyRunning(serviceName: string): IpcError {
  return new IpcError(RpcErrorCode.SERVICE_ALREADY_RUNNING, `Сервис "${serviceName}" уже запущен`)
}

export function serviceFailed(serviceName: string, reason?: string): IpcError {
  const message = reason ? `Ошибка сервиса "${serviceName}": ${reason}` : `Ошибка сервиса "${serviceName}"`
  return new IpcError(RpcErrorCode.SERVICE_FAILED, message)
}

export function daemonNotRunning(): IpcError {
  return new IpcError(RpcErrorCode.DAEMON_NOT_RUNNING, 'Daemon не запущен. Используйте "start" для запуска.')
}

export function daemonAlreadyRunning(pid: number): IpcError {
  return new IpcError(RpcErrorCode.DAEMON_ALREADY_RUNNING, `Daemon уже запущен (PID: ${pid})`, { pid })
}

export function lockFailed(path: string): IpcError {
  return new IpcError(RpcErrorCode.LOCK_FAILED, `Не удалось захватить блокировку: ${path}`)
}

export function socketError(details?: string): IpcError {
  return new IpcError(RpcErrorCode.SOCKET_ERROR, details ?? 'Ошибка соединения с daemon')
}

export function timeoutError(operation?: string): IpcError {
  const message = operation ? `Таймаут операции: ${operation}` : 'Превышено время ожидания'
  return new IpcError(RpcErrorCode.TIMEOUT, message)
}

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты для работы с ошибками
// ─────────────────────────────────────────────────────────────────────────────

// Проверка, является ли ошибка IpcError
export function isIpcError(error: unknown): error is IpcError {
  return error instanceof IpcError
}

// Преобразование любой ошибки в IpcError
export function toIpcError(error: unknown): IpcError {
  if (isIpcError(error)) {
    return error
  }

  if (error instanceof Error) {
    return new IpcError(RpcErrorCode.INTERNAL_ERROR, error.message)
  }

  return new IpcError(RpcErrorCode.INTERNAL_ERROR, String(error))
}

// Проверка кода ошибки на стандартный JSON-RPC
export function isStandardRpcError(code: number): boolean {
  return code >= -32700 && code <= -32600
}

// Проверка кода ошибки на кастомный daemon error
export function isCustomRpcError(code: number): boolean {
  return code >= -32099 && code <= -32000
}
