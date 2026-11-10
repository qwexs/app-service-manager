// Базовый абстрактный класс для всех сервисов

import type {
  ServiceConfig,
  ServiceState,
  ServiceStatus,
  IService,
  ServiceEventHandler,
  ServiceEvent,
  ServiceEventType,
} from '../types'
import { logger } from '../utils/logger'

export abstract class BaseService implements IService {
  readonly name: string
  readonly config: ServiceConfig
  protected _state: ServiceState = { status: 'stopped' }
  protected eventHandlers: ServiceEventHandler[] = []

  constructor(config: ServiceConfig) {
    this.name = config.name
    this.config = config
  }

  get state(): ServiceState {
    return { ...this._state }
  }

  getStatus(): ServiceStatus {
    return this._state.status
  }

  // Подписка на события сервиса
  on(handler: ServiceEventHandler): () => void {
    this.eventHandlers.push(handler)
    return () => {
      const index = this.eventHandlers.indexOf(handler)
      if (index > -1) {
        this.eventHandlers.splice(index, 1)
      }
    }
  }

  protected emit(type: ServiceEventType, data?: unknown): void {
    const event: ServiceEvent = {
      type,
      service: this.name,
      timestamp: new Date(),
      data,
    }
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (err) {
        logger.error(this.name, `Ошибка в обработчике события: ${err}`)
      }
    }
  }

  protected setState(updates: Partial<ServiceState>): void {
    this._state = { ...this._state, ...updates }
  }

  // Абстрактные методы для реализации в наследниках
  abstract start(): Promise<void>
  abstract stop(): Promise<void>

  async restart(): Promise<void> {
    logger.info(this.name, 'Перезапуск...')
    await this.stop()
    await this.start()
  }

  async checkHealth(): Promise<boolean> {
    if (this._state.status !== 'running' && this._state.status !== 'starting') {
      return false
    }
    return this.performHealthCheck()
  }

  // Health check — по умолчанию просто проверяем статус
  async waitForHealthy(timeoutMs: number = 30000): Promise<boolean> {
    const healthCheck = this.config.healthCheck
    if (!healthCheck) {
      // Если health check не настроен, считаем сервис готовым сразу после запуска
      return this._state.status === 'running'
    }

    const startTime = Date.now()
    const interval = healthCheck.interval || 1000
    const initialDelay = healthCheck.initialDelay || 0
    const retries = healthCheck.retries || 1

    // Начальная задержка
    if (initialDelay > 0) {
      await this.sleep(initialDelay)
    }

    let successCount = 0

    while (Date.now() - startTime < timeoutMs) {
      if (!['running', 'starting'].includes(this.getStatus())) return false
      const healthy = await this.checkHealth()
      if (healthy) {
        successCount++
        if (successCount >= retries) {
          this.emit('healthy')
          return true
        }
      } else {
        successCount = 0
      }
      await this.sleep(interval)
    }

    this.emit('unhealthy')
    return false
  }

  // Выполнение health check — переопределяется в наследниках
  protected async performHealthCheck(): Promise<boolean> {
    const healthCheck = this.config.healthCheck
    if (!healthCheck) return true

    const timeout = healthCheck.timeout || 5000

    try {
      switch (healthCheck.type) {
        case 'http':
          return await this.httpHealthCheck(healthCheck.url!, timeout)
        case 'tcp':
          return await this.tcpHealthCheck(healthCheck.host!, healthCheck.port!, timeout)
        case 'command':
          return await this.commandHealthCheck(healthCheck.command!, timeout)
        default:
          return true
      }
    } catch {
      return false
    }
  }

  protected async httpHealthCheck(url: string, timeout: number): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeout),
      })
      return response.ok
    } catch {
      return false
    }
  }

  protected async tcpHealthCheck(host: string, port: number, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = Bun.connect({
        hostname: host,
        port: port,
        socket: {
          open() {
            resolve(true)
          },
          error() {
            resolve(false)
          },
          data() {},
          close() {},
        },
      })

      setTimeout(() => {
        socket.then((s) => s.end())
        resolve(false)
      }, timeout)
    })
  }

  protected async commandHealthCheck(command: string[], timeout: number): Promise<boolean> {
    try {
      const proc = Bun.spawn(command, {
        stdout: 'ignore',
        stderr: 'ignore',
        timeout,
        killSignal: 'SIGKILL',
      })
      const code = await proc.exited
      return code === 0 && !proc.killed
    } catch {
      return false
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
