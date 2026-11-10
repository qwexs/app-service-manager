// Обработчик handshake — проверка совместимости версий CLI и Daemon
// Первое сообщение при подключении клиента

import {
  PROTOCOL_VERSION,
  createSuccessResponse,
  type Request,
  type SuccessResponse,
  type ErrorResponse,
  type HandshakeParams,
  type HandshakeResult,
} from '../protocol'
import { APP_VERSION } from '../../version'
import { RpcErrorCode, IpcError, versionMismatch, invalidParams } from '../errors'

// ─────────────────────────────────────────────────────────────────────────────
// Конфигурация совместимости версий
// ─────────────────────────────────────────────────────────────────────────────

// Минимальная версия клиента, совместимая с текущим daemon
export const MIN_CLIENT_VERSION = '1.0.0'

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты для работы с версиями
// ─────────────────────────────────────────────────────────────────────────────

// Парсинг semver версии в числовой массив
export function parseVersion(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)]
}

// Сравнение версий: -1 если a < b, 0 если a === b, 1 если a > b
export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)
  if (!parsedA || !parsedB) {
    throw new Error(`Невалидный формат версии: ${!parsedA ? a : b}`)
  }
  return Bun.semver.order(a, b)
}

// Проверка совместимости версии клиента
export function isVersionCompatible(clientVersion: string, minVersion: string = MIN_CLIENT_VERSION): boolean {
  try {
    return compareVersions(clientVersion, minVersion) >= 0
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Контекст daemon для handshake ответа
// ─────────────────────────────────────────────────────────────────────────────

export interface DaemonContext {
  startTime: number // timestamp запуска daemon
  instanceId: string
  getServicesCount: () => number // функция получения количества сервисов
}

// ─────────────────────────────────────────────────────────────────────────────
// Валидация параметров handshake
// ─────────────────────────────────────────────────────────────────────────────

export function validateHandshakeParams(params: unknown): HandshakeParams {
  if (typeof params !== 'object' || params === null) {
    throw invalidParams('Параметры handshake должны быть объектом')
  }

  const obj = params as Record<string, unknown>

  if (typeof obj.version !== 'string') {
    throw invalidParams('Параметр version обязателен и должен быть строкой')
  }

  if (!parseVersion(obj.version)) {
    throw invalidParams(`Невалидный формат версии: ${obj.version}. Ожидается semver (например, 1.0.0)`)
  }

  return { version: obj.version }
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработчик handshake
// ─────────────────────────────────────────────────────────────────────────────

export type HandshakeResponse = SuccessResponse<HandshakeResult> | ErrorResponse

export function handleHandshake(request: Request, context: DaemonContext): HandshakeResponse {
  // Валидация параметров
  const params = validateHandshakeParams(request.params)
  const clientVersion = params.version

  // Проверка совместимости
  const compatible = isVersionCompatible(clientVersion)

  if (!compatible) {
    // Возвращаем ошибку несовместимости версий
    const error = versionMismatch(PROTOCOL_VERSION, clientVersion, MIN_CLIENT_VERSION)
    return error.toErrorResponse(request.id)
  }

  // Вычисление uptime daemon в секундах
  const daemonUptime = Math.floor((Date.now() - context.startTime) / 1000)

  // Формирование успешного ответа
  // version — версия приложения (APP_VERSION), используется для health check при обновлении
  const result: HandshakeResult = {
    version: APP_VERSION,
    compatible: true,
    daemonUptime,
    servicesCount: context.getServicesCount(),
    instanceId: context.instanceId,
  }

  return createSuccessResponse(request.id, result)
}

// ─────────────────────────────────────────────────────────────────────────────
// Клиентская функция создания handshake запроса
// ─────────────────────────────────────────────────────────────────────────────

import { createRequest } from '../protocol'

export function createHandshakeRequest() {
  return createRequest('handshake', { version: PROTOCOL_VERSION })
}

// ─────────────────────────────────────────────────────────────────────────────
// Валидация handshake ответа на стороне клиента
// ─────────────────────────────────────────────────────────────────────────────

import { isSuccessResponse, isErrorResponse, type Response } from '../protocol'

export interface HandshakeValidationResult {
  success: boolean
  result?: HandshakeResult
  error?: {
    code: number
    message: string
    daemonVersion?: string
    minClientVersion?: string
  }
}

export function validateHandshakeResponse(response: Response): HandshakeValidationResult {
  if (isSuccessResponse(response)) {
    const result = response.result as HandshakeResult

    // Проверяем структуру результата
    if (
      typeof result.version !== 'string' ||
      typeof result.compatible !== 'boolean' ||
      typeof result.daemonUptime !== 'number' ||
      typeof result.servicesCount !== 'number'
    ) {
      return {
        success: false,
        error: {
          code: RpcErrorCode.INTERNAL_ERROR,
          message: 'Невалидная структура ответа handshake',
        },
      }
    }

    return { success: true, result }
  }

  if (isErrorResponse(response)) {
    const { code, message, data } = response.error
    const errorData = data as { daemonVersion?: string; minClientVersion?: string } | undefined

    return {
      success: false,
      error: {
        code,
        message,
        daemonVersion: errorData?.daemonVersion,
        minClientVersion: errorData?.minClientVersion,
      },
    }
  }

  return {
    success: false,
    error: {
      code: RpcErrorCode.INTERNAL_ERROR,
      message: 'Неизвестный формат ответа',
    },
  }
}
