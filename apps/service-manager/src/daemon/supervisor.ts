// Supervisor — мониторинг и автоматический перезапуск сервисов
// Фаза 3: Мониторинг

import type { ServiceManager } from '../manager'
import type { IService, ServiceStatus } from '../types'
import type { FileLogger } from './file-logger'
import { logger } from '../utils/logger'

// ─────────────────────────────────────────────────────────────────────────────
// Конфигурация автоперезапуска
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoRestartConfig {
  // Включен ли автоперезапуск
  enabled: boolean
  // Максимум перезапусков за период
  maxRestarts: number
  // Период в миллисекундах, за который считаются перезапуски
  restartWindow: number
  // Множитель задержки при backoff
  backoffMultiplier: number
  // Начальная задержка в мс
  initialDelay: number
  // Максимальная задержка в мс
  maxDelay: number
  // Интервал проверки health check в мс
  healthCheckInterval: number
  // Сколько подряд неуспешных probe до рестарта
  healthFailThreshold: number
}

// Конфигурация по умолчанию
export const DEFAULT_AUTO_RESTART_CONFIG: AutoRestartConfig = {
  enabled: true,
  maxRestarts: 5,
  restartWindow: 300_000, // 5 минут
  backoffMultiplier: 2,
  initialDelay: 1000,
  maxDelay: 30_000,
  healthCheckInterval: 10_000,
  healthFailThreshold: 3,
}

// ─────────────────────────────────────────────────────────────────────────────
// Информация о перезапусках сервиса
// ─────────────────────────────────────────────────────────────────────────────

export interface RestartInfo {
  // Общее количество перезапусков за всё время
  totalRestarts: number
  // Временные метки перезапусков в окне restartWindow
  restartTimestamps: number[]
  // Текущая задержка backoff
  currentDelay: number
  // Сервис помечен как failed (превышен maxRestarts)
  markedAsFailed: boolean
  // Время последнего успешного старта
  lastSuccessfulStart?: number
  // Подряд неуспешные HTTP/TCP probe
  consecutiveHealthFailures: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Статистика сервиса для внешнего использования
// ─────────────────────────────────────────────────────────────────────────────

export interface ServiceStats {
  name: string
  status: ServiceStatus
  pid?: number
  uptime?: number // секунды
  restarts: number
  markedAsFailed: boolean
  lastError?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// События Supervisor
// ─────────────────────────────────────────────────────────────────────────────

export type SupervisorEventType =
  | 'service:crashed'
  | 'service:restarting'
  | 'service:restarted'
  | 'service:failed'
  | 'service:healthy'
  | 'service:unhealthy'

export interface SupervisorEvent {
  type: SupervisorEventType
  service: string
  timestamp: Date
  data?: unknown
}

export type SupervisorEventHandler = (event: SupervisorEvent) => void

// ─────────────────────────────────────────────────────────────────────────────
// Опции Supervisor
// ─────────────────────────────────────────────────────────────────────────────

export interface SupervisorOptions {
  manager: ServiceManager
  config?: Partial<AutoRestartConfig>
  fileLogger?: FileLogger
}

// ─────────────────────────────────────────────────────────────────────────────
// Supervisor класс
// ─────────────────────────────────────────────────────────────────────────────

export class Supervisor {
  private manager: ServiceManager
  private config: AutoRestartConfig
  private fileLogger?: FileLogger

  // Информация о перезапусках для каждого сервиса
  private restartInfoMap: Map<string, RestartInfo> = new Map()

  // Флаг работы health check loop
  private running = false

  // Таймер health check loop
  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null

  // Обработчики событий
  private eventHandlers: SupervisorEventHandler[] = []

  // Сервисы, которые supervisor отслеживает (запущенные через supervisor)
  private monitoredServices: Set<string> = new Set()

  // Hold на время update/DDL: намерение running сохраняется, health не поднимает.
  // Не отдельный ServiceStatus и не поле IPC.
  private pendingServices: Set<string> = new Set()

  constructor(options: SupervisorOptions) {
    this.manager = options.manager
    this.config = { ...DEFAULT_AUTO_RESTART_CONFIG, ...options.config }
    this.fileLogger = options.fileLogger
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Публичное API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Запуск supervisor (начинает health check loop)
   */
  start(): void {
    if (this.running) {
      logger.warn('supervisor', 'Supervisor уже запущен')
      return
    }

    this.running = true
    logger.info('supervisor', 'Supervisor запущен')
    this.log('info', 'Supervisor запущен')

    // Запускаем health check loop
    this.scheduleHealthCheck()
  }

  /**
   * Остановка supervisor
   */
  stop(): void {
    if (!this.running) {
      return
    }

    this.running = false

    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer)
      this.healthCheckTimer = null
    }

    logger.info('supervisor', 'Supervisor остановлен')
    this.log('info', 'Supervisor остановлен')
  }

  /**
   * Hold: health и startService не поднимают сервис, пока не endPending.
   * Не меняет ServiceStatus. stop — через manager.stop, не stopService.
   */
  beginPending(names: string[]): void {
    for (const name of names) {
      this.pendingServices.add(name)
    }
    logger.info('supervisor', `pending: ${names.join(', ')}`)
    this.log('info', `pending: ${names.join(', ')}`)
  }

  endPending(names: string[]): void {
    for (const name of names) {
      this.pendingServices.delete(name)
    }
    logger.info('supervisor', `pending снят: ${names.join(', ')}`)
    this.log('info', `pending снят: ${names.join(', ')}`)
  }

  isPending(name: string): boolean {
    return this.pendingServices.has(name)
  }

  /**
   * Запуск сервиса через supervisor (добавляет в мониторинг)
   */
  async startService(name: string): Promise<void> {
    const service = this.manager.getService(name)
    if (!service) {
      throw new Error(`Сервис ${name} не найден`)
    }

    if (this.pendingServices.has(name)) {
      logger.warn('supervisor', `start ${name} пропущен: pending update`)
      this.log('warn', `start ${name} пропущен: pending update`)
      this.monitoredServices.add(name)
      return
    }

    // Добавляем в мониторинг
    this.monitoredServices.add(name)

    // Инициализируем информацию о перезапусках
    if (!this.restartInfoMap.has(name)) {
      this.restartInfoMap.set(name, {
        totalRestarts: 0,
        restartTimestamps: [],
        currentDelay: this.config.initialDelay,
        markedAsFailed: false,
        consecutiveHealthFailures: 0,
      })
    } else {
      // Явный start даёт сервису новый лимит автоперезапуска
      this.resetFailedStatus(name)
    }

    // Запускаем сервис
    await this.manager.start([name])

    // Записываем время успешного старта
    const info = this.restartInfoMap.get(name)!
    info.lastSuccessfulStart = Date.now()
  }

  /**
   * Остановка сервиса (удаляет из мониторинга)
   */
  async stopService(name: string): Promise<void> {
    // Удаляем из мониторинга
    this.monitoredServices.delete(name)

    // Останавливаем сервис
    await this.manager.stop([name])
  }

  /**
   * Взять сервис под мониторинг. Не требует running: после self-update
   * процесс может уже упасть к моменту adopt — health loop его поднимет.
   */
  adoptService(name: string): void {
    const service = this.manager.getService(name)
    if (!service) {
      logger.warn('supervisor', `Сервис ${name} не найден для adopt`)
      return
    }

    this.monitoredServices.add(name)

    if (!this.restartInfoMap.has(name)) {
      this.restartInfoMap.set(name, {
        totalRestarts: 0,
        restartTimestamps: [],
        currentDelay: this.config.initialDelay,
        markedAsFailed: false,
        lastSuccessfulStart: service.getStatus() === 'running' ? Date.now() : undefined,
        consecutiveHealthFailures: 0,
      })
    }

    if (service.getStatus() !== 'running') {
      logger.warn('supervisor', `Сервис ${name} не запущен, берём в мониторинг`)
      this.log('warn', `Сервис ${name} не запущен, берём в мониторинг`)
      return
    }

    logger.info('supervisor', `Сервис ${name} взят под управление`)
    this.log('info', `Сервис ${name} взят под управление`)
  }

  /**
   * Получение статистики сервиса
   */
  getServiceStats(name: string): ServiceStats | null {
    const service = this.manager.getService(name)
    if (!service) {
      return null
    }

    const info = this.restartInfoMap.get(name) || {
      totalRestarts: 0,
      restartTimestamps: [],
      currentDelay: this.config.initialDelay,
      markedAsFailed: false,
      consecutiveHealthFailures: 0,
    }

    const state = service.state

    return {
      name,
      status: service.getStatus(),
      pid: state.pid,
      uptime: state.startedAt ? Math.floor((Date.now() - state.startedAt.getTime()) / 1000) : undefined,
      restarts: info.totalRestarts,
      markedAsFailed: info.markedAsFailed,
      lastError: state.error,
    }
  }

  /**
   * Получение статистики всех сервисов
   */
  getAllStats(): ServiceStats[] {
    const stats: ServiceStats[] = []

    for (const service of this.manager.getAllServices()) {
      const stat = this.getServiceStats(service.name)
      if (stat) {
        stats.push(stat)
      }
    }

    return stats
  }

  /**
   * Получение количества перезапусков сервиса
   */
  getRestartCount(name: string): number {
    return this.restartInfoMap.get(name)?.totalRestarts || 0
  }

  /**
   * Получение Map с количеством перезапусков (для совместимости с dispatcher)
   */
  getRestartCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const [name, info] of this.restartInfoMap) {
      counts.set(name, info.totalRestarts)
    }
    return counts
  }

  /**
   * Сброс статуса failed для сервиса (позволяет попытаться перезапустить)
   */
  resetFailedStatus(name: string): void {
    const info = this.restartInfoMap.get(name)
    if (!info) return

    const wasFailed = info.markedAsFailed
    info.markedAsFailed = false
    info.restartTimestamps = []
    info.currentDelay = this.config.initialDelay
    info.consecutiveHealthFailures = 0
    if (wasFailed) {
      logger.info('supervisor', `Статус failed сброшен для ${name}`)
      this.log('info', `Статус failed сброшен для ${name}`)
    }
  }

  /**
   * Подписка на события
   */
  on(handler: SupervisorEventHandler): () => void {
    this.eventHandlers.push(handler)
    return () => {
      const index = this.eventHandlers.indexOf(handler)
      if (index > -1) {
        this.eventHandlers.splice(index, 1)
      }
    }
  }

  /**
   * Проверка, запущен ли supervisor
   */
  isRunning(): boolean {
    return this.running
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Приватные методы
  // ───────────────────────────────────────────────────────────────────────────

  private scheduleHealthCheck(): void {
    if (!this.running) return

    this.healthCheckTimer = setTimeout(async () => {
      await this.performHealthCheck()
      this.scheduleHealthCheck()
    }, this.config.healthCheckInterval)
  }

  private async performHealthCheck(): Promise<void> {
    if (!this.running || !this.config.enabled) return

    for (const name of this.monitoredServices) {
      const service = this.manager.getService(name)
      if (!service) {
        // Сервис удалён — убираем из мониторинга
        this.monitoredServices.delete(name)
        continue
      }

      if (this.pendingServices.has(name)) {
        continue
      }

      const info = this.restartInfoMap.get(name)
      if (!info) continue

      // Лимит действует только внутри restartWindow, иначе снова пробуем
      if (!this.releaseFailedIfCooldownElapsed(name, info)) continue

      const status = service.getStatus()

      // Если сервис упал — пытаемся перезапустить
      if (status === 'stopped' || status === 'failed') {
        await this.handleCrashedService(name, service, info)
        continue
      }

      if (status === 'running') {
        await this.handleRunningHealth(name, service, info)
      }
    }
  }

  private async handleRunningHealth(name: string, service: IService, info: RestartInfo): Promise<void> {
    const healthy = await service.checkHealth()
    if (!this.running || this.pendingServices.has(name)) return

    if (healthy) {
      if (info.consecutiveHealthFailures > 0) {
        this.emit('service:healthy', name)
      }
      info.consecutiveHealthFailures = 0
      return
    }

    info.consecutiveHealthFailures++
    this.emit('service:unhealthy', name, { failures: info.consecutiveHealthFailures })
    this.log('warn', `Сервис ${name} не проходит health (${info.consecutiveHealthFailures}/${this.config.healthFailThreshold})`)

    if (info.consecutiveHealthFailures < this.config.healthFailThreshold) {
      return
    }

    logger.warn('supervisor', `Сервис ${name} признан unhealthy, перезапуск...`)
    this.log('warn', `Сервис ${name} признан unhealthy после ${info.consecutiveHealthFailures} проверок`)

    try {
      await this.manager.withLifecycle(async () => {
        if (!this.running || this.pendingServices.has(name)) return
        await this.manager.stop([name])
      })
    } catch (error) {
      logger.error('supervisor', `Не удалось остановить unhealthy ${name}: ${error}`)
      return
    }

    info.consecutiveHealthFailures = 0
    await this.handleCrashedService(name, service, info)
  }

  private pruneRestartWindow(info: RestartInfo): void {
    const now = Date.now()
    info.restartTimestamps = info.restartTimestamps.filter((ts) => now - ts < this.config.restartWindow)
  }

  /**
   * Снимает failed, если перезапуски в окне уже не держат лимит.
   * Возвращает false, пока cooldown ещё действует — сервис не трогаем.
   */
  private releaseFailedIfCooldownElapsed(name: string, info: RestartInfo): boolean {
    if (!info.markedAsFailed) return true

    this.pruneRestartWindow(info)
    if (info.restartTimestamps.length >= this.config.maxRestarts) {
      return false
    }

    info.markedAsFailed = false
    info.currentDelay = this.config.initialDelay
    logger.info('supervisor', `Статус failed сброшен для ${name}: окно перезапусков истекло`)
    this.log('info', `Статус failed сброшен для ${name}: окно перезапусков истекло`)
    return true
  }

  private async handleCrashedService(name: string, service: IService, info: RestartInfo): Promise<void> {
    this.pruneRestartWindow(info)

    // Проверяем лимит перезапусков
    if (info.restartTimestamps.length >= this.config.maxRestarts) {
      // Превышен лимит — помечаем как failed
      info.markedAsFailed = true
      logger.error('supervisor', `Сервис ${name} помечен как failed (превышен лимит перезапусков)`)
      this.log('error', `Сервис ${name} помечен как failed (${this.config.maxRestarts} перезапусков за ${this.config.restartWindow / 1000}с)`)
      this.emit('service:failed', name, { restarts: info.totalRestarts })
      return
    }

    // Логируем обнаружение падения
    logger.warn('supervisor', `Сервис ${name} упал, попытка перезапуска...`)
    this.log('warn', `Сервис ${name} упал, перезапуск через ${info.currentDelay}мс...`)
    this.emit('service:crashed', name, { status: service.getStatus() })

    // Ждём backoff delay
    await this.sleep(info.currentDelay)

    // Проверяем, что supervisor ещё работает и сервис не в pending
    if (!this.running) return
    if (this.pendingServices.has(name)) return

    // Пытаемся перезапустить
    this.emit('service:restarting', name)

    try {
      const started = await this.manager.withLifecycle(async () => {
        const affected = this.manager.getStartOrder([name])
        if (!this.running || affected.some((item) => this.pendingServices.has(item))) return false
        await this.manager.start([name])
        return true
      })
      if (!started) return

      // Успешный перезапуск
      info.totalRestarts++
      info.restartTimestamps.push(Date.now())
      info.lastSuccessfulStart = Date.now()

      // Сбрасываем backoff delay после успешного запуска
      info.currentDelay = this.config.initialDelay

      logger.success('supervisor', `Сервис ${name} успешно перезапущен (перезапуск #${info.totalRestarts})`)
      this.log('info', `Сервис ${name} перезапущен (всего: ${info.totalRestarts})`)
      this.emit('service:restarted', name, { restarts: info.totalRestarts })
    } catch (error) {
      // Ошибка перезапуска — увеличиваем backoff
      info.currentDelay = Math.min(info.currentDelay * this.config.backoffMultiplier, this.config.maxDelay)

      logger.error('supervisor', `Не удалось перезапустить ${name}: ${error}`)
      this.log('error', `Не удалось перезапустить ${name}: ${error}`)
    }
  }

  private emit(type: SupervisorEventType, service: string, data?: unknown): void {
    const event: SupervisorEvent = {
      type,
      service,
      timestamp: new Date(),
      data,
    }

    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (err) {
        logger.error('supervisor', `Ошибка в обработчике события: ${err}`)
      }
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    if (this.fileLogger) {
      this.fileLogger.log('supervisor', level, message)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Фабричная функция
// ─────────────────────────────────────────────────────────────────────────────

export function createSupervisor(options: SupervisorOptions): Supervisor {
  return new Supervisor(options)
}
