// IPC протокол на основе JSON-RPC 2.0
// Определяет типы для коммуникации между CLI и Daemon

// Версия протокола — используется для проверки совместимости CLI и Daemon
export const PROTOCOL_VERSION = '1.0.0'

// JSON-RPC версия
export const JSONRPC_VERSION = '2.0' as const

// ─────────────────────────────────────────────────────────────────────────────
// Базовые типы JSON-RPC 2.0
// ─────────────────────────────────────────────────────────────────────────────

// Идентификатор запроса — строка или число
export type RequestId = string | number

// Параметры запроса — объект с произвольными полями
export type RequestParams = Record<string, unknown>

// Запрос от CLI к Daemon
export interface Request {
  jsonrpc: typeof JSONRPC_VERSION
  id: RequestId
  method: string
  params?: RequestParams
}

// Успешный ответ от Daemon
export interface SuccessResponse<T = unknown> {
  jsonrpc: typeof JSONRPC_VERSION
  id: RequestId
  result: T
}

// Структура ошибки JSON-RPC
export interface RpcError {
  code: number
  message: string
  data?: unknown
}

// Ответ с ошибкой от Daemon
export interface ErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: RequestId
  error: RpcError
}

// Общий тип ответа
export type Response<T = unknown> = SuccessResponse<T> | ErrorResponse

// Уведомление (без id, не требует ответа)
export interface Notification<P extends RequestParams = RequestParams> {
  jsonrpc: typeof JSONRPC_VERSION
  method: string
  params?: P
}

// ─────────────────────────────────────────────────────────────────────────────
// Специализированные типы для уведомлений о логах
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogNotificationParams extends RequestParams {
  service: string
  level: LogLevel
  message: string
  timestamp: string // ISO 8601 формат
  [key: string]: unknown // Индексная сигнатура для совместимости с RequestParams
}

export interface LogNotification {
  jsonrpc: typeof JSONRPC_VERSION
  method: 'log'
  params: LogNotificationParams
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы для метода handshake
// ─────────────────────────────────────────────────────────────────────────────

export interface HandshakeParams {
  version: string
}

export interface HandshakeResult {
  // Версия приложения (APP_VERSION), не PROTOCOL_VERSION
  version: string
  compatible: boolean
  daemonUptime: number // секунды
  servicesCount: number
  /** Уникален для одного запуска daemon; используется self-update. */
  instanceId: string
}

export interface VersionMismatchData {
  daemonVersion: string
  minClientVersion: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы для метода status
// ─────────────────────────────────────────────────────────────────────────────

export type DaemonServiceStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'failed'

export interface ServiceStatusInfo {
  name: string
  status: DaemonServiceStatus
  pid?: number
  uptime?: number // секунды
  restarts: number
  lastError?: string
}

export interface DaemonInfo {
  pid: number
  uptime: number // секунды
  // Версия приложения (APP_VERSION)
  version: string
  /** Случайный ID экземпляра; PID сам по себе не является identity. */
  instanceId: string
}

export interface StatusResult {
  daemon: DaemonInfo
  services: ServiceStatusInfo[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы для методов start/stop/restart
// ─────────────────────────────────────────────────────────────────────────────

export interface ServiceCommandParams {
  services?: string[]
}

export interface ServiceCommandResult {
  success: boolean
  services: Array<{
    name: string
    status: DaemonServiceStatus
    error?: string
  }>
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы для метода logs
// ─────────────────────────────────────────────────────────────────────────────

export interface LogsParams {
  service?: string
  lines?: number
}

export interface LogEntry {
  service: string
  level: LogLevel
  message: string
  timestamp: string
}

export interface LogsResult {
  logs: LogEntry[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы для метода subscribe/unsubscribe
// ─────────────────────────────────────────────────────────────────────────────

export interface SubscribeParams {
  service?: string // Если не указан — подписка на все сервисы
}

export interface SubscribeResult {
  subscribed: boolean
}

export interface UnsubscribeResult {
  unsubscribed: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы для метода shutdown
// ─────────────────────────────────────────────────────────────────────────────

export interface ShutdownResult {
  success: boolean
  message: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы для методов update.*
// ─────────────────────────────────────────────────────────────────────────────

export type UpdateComponentName = 'service-manager' | 'app'

export type UpdateStep = 'checking' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'restarting'

// update.check — проверка наличия обновлений
export interface UpdateCheckParams {
  components?: UpdateComponentName[]
}

export interface UpdateInfoItem {
  component: UpdateComponentName
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  changelog?: string
  critical?: boolean
}

export interface UpdateCheckResult {
  updates: UpdateInfoItem[]
}

// update.install — установка обновлений
export interface UpdateInstallParams {
  components?: UpdateComponentName[]
  version?: string
  force?: boolean
}

export interface UpdateInstallResultItem {
  name: UpdateComponentName
  oldVersion?: string
  newVersion?: string
  status: 'updated' | 'skipped' | 'failed'
  error?: string
}

export interface UpdateInstallResult {
  success: boolean
  components: UpdateInstallResultItem[]
  requiresRestart: boolean
}

// update.rollback — откат компонента
export interface UpdateRollbackParams {
  component: UpdateComponentName
  version?: string
}

export interface UpdateRollbackResult {
  success: boolean
  component: UpdateComponentName
  error?: string
}

// update.status — статус текущего обновления
export interface UpdateStatusResult {
  inProgress: boolean
  currentComponent?: UpdateComponentName
  step?: UpdateStep
  progress?: number
}

// update.progress — уведомление о прогрессе (Notification)
export interface UpdateProgressNotificationParams extends RequestParams {
  component: UpdateComponentName
  step: UpdateStep
  progress: number
  message: string
  [key: string]: unknown
}

export interface UpdateProgressNotification {
  jsonrpc: typeof JSONRPC_VERSION
  method: 'update.progress'
  params: UpdateProgressNotificationParams
}


/** Кооперативная передача daemon внешнему self-updater. */
export interface UpdateHandoffParams {
  taskId: string
  instanceId: string
}

export interface UpdateHandoffResult {
  accepted: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Перечисление всех доступных методов
// ─────────────────────────────────────────────────────────────────────────────

export type IpcMethod =
  | 'handshake'
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'logs'
  | 'subscribe'
  | 'unsubscribe'
  | 'shutdown'
  // Update методы
  | 'update.check'
  | 'update.install'
  | 'update.rollback'
  | 'update.status'
  | 'update.handoff'

// Маппинг метод → параметры
export interface MethodParams {
  handshake: HandshakeParams
  start: ServiceCommandParams
  stop: ServiceCommandParams
  restart: ServiceCommandParams
  status: undefined
  logs: LogsParams
  subscribe: SubscribeParams
  unsubscribe: undefined
  shutdown: undefined
  // Update методы
  'update.check': UpdateCheckParams
  'update.install': UpdateInstallParams
  'update.rollback': UpdateRollbackParams
  'update.status': undefined
  'update.handoff': UpdateHandoffParams
}

// Маппинг метод → результат
export interface MethodResults {
  handshake: HandshakeResult
  start: ServiceCommandResult
  stop: ServiceCommandResult
  restart: ServiceCommandResult
  status: StatusResult
  logs: LogsResult
  subscribe: SubscribeResult
  unsubscribe: UnsubscribeResult
  shutdown: ShutdownResult
  // Update методы
  'update.check': UpdateCheckResult
  'update.install': UpdateInstallResult
  'update.rollback': UpdateRollbackResult
  'update.status': UpdateStatusResult
  'update.handoff': UpdateHandoffResult
}

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции для создания сообщений
// ─────────────────────────────────────────────────────────────────────────────

// Генератор уникальных ID для запросов
let requestIdCounter = 0
export function generateRequestId(): string {
  return `req_${++requestIdCounter}_${Date.now()}`
}

// Создание запроса
export function createRequest<M extends IpcMethod>(method: M, params?: MethodParams[M]): Request {
  const request: Request = {
    jsonrpc: JSONRPC_VERSION,
    id: generateRequestId(),
    method,
  }
  if (params !== undefined) {
    request.params = params as RequestParams
  }
  return request
}

// Создание успешного ответа
export function createSuccessResponse<T>(id: RequestId, result: T): SuccessResponse<T> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  }
}

// Создание ответа с ошибкой
export function createErrorResponse(id: RequestId, code: number, message: string, data?: unknown): ErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data !== undefined && { data }),
    },
  }
}

// Создание уведомления о логе
export function createLogNotification(service: string, level: LogLevel, message: string): LogNotification {
  return {
    jsonrpc: JSONRPC_VERSION,
    method: 'log',
    params: {
      service,
      level,
      message,
      timestamp: new Date().toISOString(),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Type guards для проверки типов сообщений
// ─────────────────────────────────────────────────────────────────────────────

export function isRequest(msg: unknown): msg is Request {
  if (typeof msg !== 'object' || msg === null) return false
  const obj = msg as Record<string, unknown>
  return (
    obj.jsonrpc === JSONRPC_VERSION &&
    (typeof obj.id === 'string' || typeof obj.id === 'number') &&
    typeof obj.method === 'string'
  )
}

export function isNotification(msg: unknown): msg is Notification {
  if (typeof msg !== 'object' || msg === null) return false
  const obj = msg as Record<string, unknown>
  return obj.jsonrpc === JSONRPC_VERSION && obj.id === undefined && typeof obj.method === 'string'
}

export function isSuccessResponse(msg: unknown): msg is SuccessResponse {
  if (typeof msg !== 'object' || msg === null) return false
  const obj = msg as Record<string, unknown>
  return (
    obj.jsonrpc === JSONRPC_VERSION && (typeof obj.id === 'string' || typeof obj.id === 'number') && 'result' in obj
  )
}

export function isErrorResponse(msg: unknown): msg is ErrorResponse {
  if (typeof msg !== 'object' || msg === null) return false
  const obj = msg as Record<string, unknown>
  return (
    obj.jsonrpc === JSONRPC_VERSION &&
    (typeof obj.id === 'string' || typeof obj.id === 'number') &&
    typeof obj.error === 'object' &&
    obj.error !== null
  )
}

export function isLogNotification(msg: unknown): msg is LogNotification {
  if (!isNotification(msg)) return false
  return msg.method === 'log' && typeof msg.params === 'object' && msg.params !== null
}

// ─────────────────────────────────────────────────────────────────────────────
// Парсинг и валидация сообщений
// ─────────────────────────────────────────────────────────────────────────────

export interface ParseResult<T> {
  success: true
  data: T
}

export interface ParseError {
  success: false
  error: RpcError
}

export type ParseOutcome<T> = ParseResult<T> | ParseError

// Парсинг JSON и валидация как Request
export function parseRequest(json: string): ParseOutcome<Request> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return {
      success: false,
      error: { code: -32700, message: 'Parse error: невалидный JSON' },
    }
  }

  if (!isRequest(parsed)) {
    return {
      success: false,
      error: { code: -32600, message: 'Invalid Request: неверная структура запроса' },
    }
  }

  return { success: true, data: parsed }
}

// Парсинг JSON и валидация как Response
export function parseResponse(json: string): ParseOutcome<Response> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return {
      success: false,
      error: { code: -32700, message: 'Parse error: невалидный JSON' },
    }
  }

  if (isSuccessResponse(parsed) || isErrorResponse(parsed)) {
    return { success: true, data: parsed }
  }

  return {
    success: false,
    error: { code: -32600, message: 'Invalid Response: неверная структура ответа' },
  }
}

// Парсинг JSON и определение типа сообщения
export type MessageType = 'request' | 'notification' | 'response' | 'error'

export interface ParsedMessage {
  type: MessageType
  message: Request | Notification | Response
}

export function parseMessage(json: string): ParseOutcome<ParsedMessage> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return {
      success: false,
      error: { code: -32700, message: 'Parse error: невалидный JSON' },
    }
  }

  if (isRequest(parsed)) {
    return { success: true, data: { type: 'request', message: parsed } }
  }

  if (isNotification(parsed)) {
    return { success: true, data: { type: 'notification', message: parsed } }
  }

  if (isSuccessResponse(parsed)) {
    return { success: true, data: { type: 'response', message: parsed } }
  }

  if (isErrorResponse(parsed)) {
    return { success: true, data: { type: 'error', message: parsed } }
  }

  return {
    success: false,
    error: { code: -32600, message: 'Invalid Message: неизвестный тип сообщения' },
  }
}
