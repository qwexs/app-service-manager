// Unit-тесты для IPC протокола
import { describe, expect, test } from 'bun:test'
import {
  PROTOCOL_VERSION,
  JSONRPC_VERSION,
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  createLogNotification,
  isRequest,
  isNotification,
  isSuccessResponse,
  isErrorResponse,
  isLogNotification,
  parseRequest,
  parseResponse,
  parseMessage,
  generateRequestId,
  type Request,
  type SuccessResponse,
  type ErrorResponse,
  type LogNotification,
} from '../../src/ipc/protocol'
import {
  RpcErrorCode,
  RpcErrorMessage,
  IpcError,
  parseError,
  methodNotFound,
  versionMismatch,
  serviceNotFound,
  daemonNotRunning,
  toIpcError,
  isIpcError,
} from '../../src/ipc/errors'

// ─────────────────────────────────────────────────────────────────────────────
// Тесты констант
// ─────────────────────────────────────────────────────────────────────────────

describe('Protocol Constants', () => {
  test('PROTOCOL_VERSION имеет корректный формат semver', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('JSONRPC_VERSION равен 2.0', () => {
    expect(JSONRPC_VERSION).toBe('2.0')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Тесты создания сообщений
// ─────────────────────────────────────────────────────────────────────────────

describe('createRequest', () => {
  test('создаёт корректный запрос без параметров', () => {
    const req = createRequest('status', undefined)
    expect(req.jsonrpc).toBe('2.0')
    expect(req.method).toBe('status')
    expect(req.id).toBeDefined()
    expect(typeof req.id).toBe('string')
    expect(req.params).toBeUndefined()
  })

  test('создаёт корректный запрос с параметрами', () => {
    const req = createRequest('handshake', { version: '1.0.0' })
    expect(req.jsonrpc).toBe('2.0')
    expect(req.method).toBe('handshake')
    expect(req.params).toEqual({ version: '1.0.0' })
  })

  test('создаёт корректный запрос для start с сервисами', () => {
    const req = createRequest('start', { services: ['server', 'ai-admin'] })
    expect(req.method).toBe('start')
    expect(req.params).toEqual({ services: ['server', 'ai-admin'] })
  })
})

describe('generateRequestId', () => {
  test('генерирует уникальные ID', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateRequestId())
    }
    expect(ids.size).toBe(100)
  })

  test('ID имеет корректный формат', () => {
    const id = generateRequestId()
    expect(id).toMatch(/^req_\d+_\d+$/)
  })
})

describe('createSuccessResponse', () => {
  test('создаёт корректный успешный ответ', () => {
    const res = createSuccessResponse('test-id', { status: 'ok' })
    expect(res.jsonrpc).toBe('2.0')
    expect(res.id).toBe('test-id')
    expect(res.result).toEqual({ status: 'ok' })
  })

  test('работает с примитивными результатами', () => {
    const res = createSuccessResponse(123, true)
    expect(res.id).toBe(123)
    expect(res.result).toBe(true)
  })
})

describe('createErrorResponse', () => {
  test('создаёт корректный ответ с ошибкой', () => {
    const res = createErrorResponse('test-id', -32601, 'Method not found')
    expect(res.jsonrpc).toBe('2.0')
    expect(res.id).toBe('test-id')
    expect(res.error.code).toBe(-32601)
    expect(res.error.message).toBe('Method not found')
  })

  test('включает дополнительные данные', () => {
    const res = createErrorResponse('test-id', -32000, 'Version mismatch', {
      daemonVersion: '1.1.0',
      minClientVersion: '1.1.0',
    })
    expect(res.error.data).toEqual({
      daemonVersion: '1.1.0',
      minClientVersion: '1.1.0',
    })
  })
})

describe('createLogNotification', () => {
  test('создаёт корректное уведомление о логе', () => {
    const notification = createLogNotification('server', 'info', 'Server started')
    expect(notification.jsonrpc).toBe('2.0')
    expect(notification.method).toBe('log')
    expect(notification.params.service).toBe('server')
    expect(notification.params.level).toBe('info')
    expect(notification.params.message).toBe('Server started')
    expect(notification.params.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Тесты type guards
// ─────────────────────────────────────────────────────────────────────────────

describe('isRequest', () => {
  test('возвращает true для валидного запроса', () => {
    const req: Request = {
      jsonrpc: '2.0',
      id: 'test',
      method: 'status',
    }
    expect(isRequest(req)).toBe(true)
  })

  test('возвращает true для запроса с числовым id', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 123, method: 'status' })).toBe(true)
  })

  test('возвращает false для неверной jsonrpc версии', () => {
    expect(isRequest({ jsonrpc: '1.0', id: 'test', method: 'status' })).toBe(false)
  })

  test('возвращает false без id', () => {
    expect(isRequest({ jsonrpc: '2.0', method: 'status' })).toBe(false)
  })

  test('возвращает false без method', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 'test' })).toBe(false)
  })

  test('возвращает false для null', () => {
    expect(isRequest(null)).toBe(false)
  })

  test('возвращает false для примитивов', () => {
    expect(isRequest('string')).toBe(false)
    expect(isRequest(123)).toBe(false)
    expect(isRequest(undefined)).toBe(false)
  })
})

describe('isNotification', () => {
  test('возвращает true для валидного уведомления', () => {
    expect(isNotification({ jsonrpc: '2.0', method: 'log' })).toBe(true)
  })

  test('возвращает false если есть id', () => {
    expect(isNotification({ jsonrpc: '2.0', id: 'test', method: 'log' })).toBe(false)
  })
})

describe('isSuccessResponse', () => {
  test('возвращает true для успешного ответа', () => {
    const res: SuccessResponse = {
      jsonrpc: '2.0',
      id: 'test',
      result: { status: 'ok' },
    }
    expect(isSuccessResponse(res)).toBe(true)
  })

  test('возвращает false для ответа с ошибкой', () => {
    expect(isSuccessResponse({ jsonrpc: '2.0', id: 'test', error: { code: -1, message: 'err' } })).toBe(false)
  })
})

describe('isErrorResponse', () => {
  test('возвращает true для ответа с ошибкой', () => {
    const res: ErrorResponse = {
      jsonrpc: '2.0',
      id: 'test',
      error: { code: -32601, message: 'Method not found' },
    }
    expect(isErrorResponse(res)).toBe(true)
  })

  test('возвращает false для успешного ответа', () => {
    expect(isErrorResponse({ jsonrpc: '2.0', id: 'test', result: {} })).toBe(false)
  })
})

describe('isLogNotification', () => {
  test('возвращает true для уведомления о логе', () => {
    const notification: LogNotification = {
      jsonrpc: '2.0',
      method: 'log',
      params: {
        service: 'server',
        level: 'info',
        message: 'test',
        timestamp: new Date().toISOString(),
      },
    }
    expect(isLogNotification(notification)).toBe(true)
  })

  test('возвращает false для других уведомлений', () => {
    expect(isLogNotification({ jsonrpc: '2.0', method: 'other', params: {} })).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Тесты парсинга
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRequest', () => {
  test('парсит валидный запрос', () => {
    const json = JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'status' })
    const result = parseRequest(json)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.method).toBe('status')
    }
  })

  test('возвращает ошибку для невалидного JSON', () => {
    const result = parseRequest('{ invalid json }')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe(-32700)
    }
  })

  test('возвращает ошибку для неверной структуры', () => {
    const result = parseRequest(JSON.stringify({ foo: 'bar' }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe(-32600)
    }
  })

  test('возвращает ошибку для неверной jsonrpc версии', () => {
    const result = parseRequest(JSON.stringify({ jsonrpc: '1.0', id: 'test', method: 'status' }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe(-32600)
    }
  })
})

describe('parseResponse', () => {
  test('парсит успешный ответ', () => {
    const json = JSON.stringify({ jsonrpc: '2.0', id: 'test', result: { status: 'ok' } })
    const result = parseResponse(json)
    expect(result.success).toBe(true)
    if (result.success && isSuccessResponse(result.data)) {
      expect(result.data.result).toEqual({ status: 'ok' })
    }
  })

  test('парсит ответ с ошибкой', () => {
    const json = JSON.stringify({
      jsonrpc: '2.0',
      id: 'test',
      error: { code: -32601, message: 'Method not found' },
    })
    const result = parseResponse(json)
    expect(result.success).toBe(true)
    if (result.success && isErrorResponse(result.data)) {
      expect(result.data.error.code).toBe(-32601)
    }
  })

  test('возвращает ошибку для невалидного JSON', () => {
    const result = parseResponse('not json')
    expect(result.success).toBe(false)
  })
})

describe('parseMessage', () => {
  test('определяет тип request', () => {
    const json = JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'status' })
    const result = parseMessage(json)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('request')
    }
  })

  test('определяет тип notification', () => {
    const json = JSON.stringify({ jsonrpc: '2.0', method: 'log', params: {} })
    const result = parseMessage(json)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('notification')
    }
  })

  test('определяет тип response', () => {
    const json = JSON.stringify({ jsonrpc: '2.0', id: 'test', result: {} })
    const result = parseMessage(json)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('response')
    }
  })

  test('определяет тип error', () => {
    const json = JSON.stringify({ jsonrpc: '2.0', id: 'test', error: { code: -1, message: 'err' } })
    const result = parseMessage(json)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('error')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Тесты Handshake версионирования
// ─────────────────────────────────────────────────────────────────────────────

describe('Handshake Protocol', () => {
  test('создаёт корректный handshake запрос', () => {
    const req = createRequest('handshake', { version: PROTOCOL_VERSION })
    expect(req.method).toBe('handshake')
    expect(req.params).toEqual({ version: PROTOCOL_VERSION })
  })

  test('создаёт успешный handshake ответ', () => {
    const res = createSuccessResponse('test-id', {
      version: PROTOCOL_VERSION,
      compatible: true,
      daemonUptime: 3600,
      servicesCount: 5,
    })
    expect(res.result).toEqual({
      version: PROTOCOL_VERSION,
      compatible: true,
      daemonUptime: 3600,
      servicesCount: 5,
    })
  })

  test('создаёт ответ с ошибкой версионирования', () => {
    const res = createErrorResponse('test-id', RpcErrorCode.VERSION_MISMATCH, 'Version mismatch', {
      daemonVersion: '1.1.0',
      minClientVersion: '1.1.0',
    })
    expect(res.error.code).toBe(-32000)
    expect(res.error.data).toEqual({
      daemonVersion: '1.1.0',
      minClientVersion: '1.1.0',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Тесты ошибок
// ─────────────────────────────────────────────────────────────────────────────

describe('RpcErrorCode', () => {
  test('содержит все стандартные коды JSON-RPC', () => {
    expect(RpcErrorCode.PARSE_ERROR).toBe(-32700)
    expect(RpcErrorCode.INVALID_REQUEST).toBe(-32600)
    expect(RpcErrorCode.METHOD_NOT_FOUND).toBe(-32601)
    expect(RpcErrorCode.INVALID_PARAMS).toBe(-32602)
    expect(RpcErrorCode.INTERNAL_ERROR).toBe(-32603)
  })

  test('содержит кастомные коды daemon', () => {
    expect(RpcErrorCode.VERSION_MISMATCH).toBe(-32000)
    expect(RpcErrorCode.SERVICE_NOT_FOUND).toBe(-32001)
    expect(RpcErrorCode.SERVICE_ALREADY_RUNNING).toBe(-32002)
    expect(RpcErrorCode.SERVICE_FAILED).toBe(-32003)
    expect(RpcErrorCode.DAEMON_NOT_RUNNING).toBe(-32004)
  })
})

describe('RpcErrorMessage', () => {
  test('содержит сообщения для всех кодов', () => {
    for (const code of Object.values(RpcErrorCode)) {
      expect(RpcErrorMessage[code as RpcErrorCode]).toBeDefined()
      expect(typeof RpcErrorMessage[code as RpcErrorCode]).toBe('string')
    }
  })
})

describe('IpcError', () => {
  test('создаёт ошибку с кодом и сообщением', () => {
    const error = new IpcError(RpcErrorCode.METHOD_NOT_FOUND, 'Test method not found')
    expect(error.code).toBe(-32601)
    expect(error.message).toBe('Test method not found')
    expect(error.name).toBe('IpcError')
  })

  test('использует сообщение по умолчанию', () => {
    const error = new IpcError(RpcErrorCode.INTERNAL_ERROR)
    expect(error.message).toBe(RpcErrorMessage[RpcErrorCode.INTERNAL_ERROR])
  })

  test('преобразуется в RpcError', () => {
    const error = new IpcError(RpcErrorCode.SERVICE_NOT_FOUND, 'server not found', { name: 'server' })
    const rpcError = error.toRpcError()
    expect(rpcError.code).toBe(-32001)
    expect(rpcError.message).toBe('server not found')
    expect(rpcError.data).toEqual({ name: 'server' })
  })

  test('создаёт ErrorResponse', () => {
    const error = new IpcError(RpcErrorCode.TIMEOUT, 'Operation timed out')
    const response = error.toErrorResponse('req-123')
    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req-123')
    expect(response.error.code).toBe(-32008)
  })
})

describe('Фабричные функции ошибок', () => {
  test('parseError создаёт ошибку парсинга', () => {
    const error = parseError('Invalid syntax')
    expect(error.code).toBe(RpcErrorCode.PARSE_ERROR)
    expect(error.message).toBe('Invalid syntax')
  })

  test('methodNotFound включает имя метода', () => {
    const error = methodNotFound('unknownMethod')
    expect(error.code).toBe(RpcErrorCode.METHOD_NOT_FOUND)
    expect(error.message).toContain('unknownMethod')
  })

  test('versionMismatch включает версии', () => {
    const error = versionMismatch('1.1.0', '1.0.0', '1.1.0')
    expect(error.code).toBe(RpcErrorCode.VERSION_MISMATCH)
    expect(error.message).toContain('1.1.0')
    expect(error.message).toContain('1.0.0')
    expect(error.data).toEqual({ daemonVersion: '1.1.0', minClientVersion: '1.1.0' })
  })

  test('serviceNotFound включает имя сервиса', () => {
    const error = serviceNotFound('unknown-service')
    expect(error.code).toBe(RpcErrorCode.SERVICE_NOT_FOUND)
    expect(error.message).toContain('unknown-service')
  })

  test('daemonNotRunning создаёт корректную ошибку', () => {
    const error = daemonNotRunning()
    expect(error.code).toBe(RpcErrorCode.DAEMON_NOT_RUNNING)
  })
})

describe('isIpcError и toIpcError', () => {
  test('isIpcError возвращает true для IpcError', () => {
    const error = new IpcError(RpcErrorCode.INTERNAL_ERROR)
    expect(isIpcError(error)).toBe(true)
  })

  test('isIpcError возвращает false для обычной ошибки', () => {
    const error = new Error('test')
    expect(isIpcError(error)).toBe(false)
  })

  test('toIpcError возвращает IpcError как есть', () => {
    const original = new IpcError(RpcErrorCode.TIMEOUT, 'test')
    const result = toIpcError(original)
    expect(result).toBe(original)
  })

  test('toIpcError преобразует Error в IpcError', () => {
    const error = new Error('Something went wrong')
    const result = toIpcError(error)
    expect(result.code).toBe(RpcErrorCode.INTERNAL_ERROR)
    expect(result.message).toBe('Something went wrong')
  })

  test('toIpcError преобразует строку в IpcError', () => {
    const result = toIpcError('Error message')
    expect(result.code).toBe(RpcErrorCode.INTERNAL_ERROR)
    expect(result.message).toBe('Error message')
  })
})
