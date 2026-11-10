// Основной класс ServiceManager для управления всеми сервисами

import type { BunServiceConfig, DockerComposeServiceConfig, IService, ServiceConfig, ServiceStatus } from './types'
import { BunService } from './services/bun-service'
import { DockerComposeService } from './services/docker-compose-service'
import { logger } from './utils/logger'
import { loadProject, startOrder, type ProjectConfig } from './config'

export class ServiceManager {
  private services: Map<string, IService> = new Map()
  private rootDir: string

  private lifecycleBusy = false

  async withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lifecycleBusy) throw new Error('Операция управления сервисами уже выполняется')
    this.lifecycleBusy = true
    try { return await operation() } finally { this.lifecycleBusy = false }
  }

  private project: ProjectConfig

  constructor(rootDir: string) {
    this.project = loadProject(rootDir)
    this.rootDir = this.project.rootDir
    this.initializeServices()
  }

  private initializeServices(): void {
    // Создаём экземпляры всех доступных сервисов (включая опциональные)
    for (const config of this.project.services) {
      const service = this.createService(config)
      this.services.set(config.name, service)
    }
  }

  private createService(config: ServiceConfig): IService {
    switch (config.type) {
      case 'bun':
        return new BunService(config as BunServiceConfig, this.rootDir)
      case 'docker-compose':
        return new DockerComposeService(config as DockerComposeServiceConfig, this.rootDir, this.project.namespace)
      default:
        throw new Error(`Неизвестный тип сервиса: ${(config as ServiceConfig).type}`)
    }
  }

  // Получение сервиса по имени
  getService(name: string): IService | undefined {
    return this.services.get(name)
  }

  // Получение всех сервисов
  getAllServices(): IService[] {
    return Array.from(this.services.values())
  }

  // Топологическая сортировка для учёта зависимостей
  getStartOrder(serviceNames?: string[]): string[] {
    return startOrder(this.project, serviceNames ?? [...this.services.keys()])
  }

  // Обратный порядок для остановки
  private getStopOrder(serviceNames?: string[]): string[] {
    const selected = serviceNames ?? [...this.services.keys()]
    return this.getStartOrder(selected).filter((name) => selected.includes(name)).reverse()
  }

  // Запуск сервисов
  async start(serviceNames?: string[]): Promise<void> {
    const order = this.getStartOrder(serviceNames)
    logger.header('Запуск сервисов')
    logger.info('manager', `Порядок запуска: ${order.join(' → ')}`)

    for (const name of order) {
      const service = this.services.get(name)
      if (!service) {
        logger.warn('manager', `Сервис ${name} не найден`)
        continue
      }

      try {
        await service.start()

        // Ждём готовности сервиса (health check)
        logger.info(name, 'Ожидание готовности...')
        const healthy = await service.waitForHealthy(60000)

        if (healthy) {
          logger.success(name, 'Готов к работе')
        } else {
          throw new Error(`${name}: Health check не пройден; зависимые сервисы не запущены`)
        }
      } catch (err) {
        logger.error(name, `Не удалось запустить: ${err}`)
        // Продолжаем с остальными сервисами или прерываем?
        // Для production лучше прервать, для разработки — продолжить
        throw err
      }
    }

    logger.separator()
    logger.success('manager', 'Все сервисы запущены')
  }

  // Остановка сервисов
  async stop(serviceNames?: string[]): Promise<void> {
    const order = this.getStopOrder(serviceNames)
    logger.header('Остановка сервисов')
    logger.info('manager', `Порядок остановки: ${order.join(' → ')}`)

    const failures: unknown[] = []
    for (const name of order) {
      const service = this.services.get(name)
      if (!service) continue

      try {
        await service.stop()
      } catch (err) {
        logger.error(name, `Ошибка при остановке: ${err}`)
        failures.push(err)
      }
    }

    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Не все сервисы остановлены')
    logger.separator()
    logger.success('manager', 'Все сервисы остановлены')
  }

  async stopStrict(serviceNames: string[]): Promise<void> {
    await this.stop(serviceNames)
    for (const name of serviceNames) {
      const service = this.services.get(name)
      if (!service || service.getStatus() !== 'stopped') throw new Error(`${name}: stop не подтверждён`)
    }
  }

  // Перезапуск сервисов
  async restart(serviceNames?: string[]): Promise<void> {
    await this.stop(serviceNames)
    await this.start(serviceNames)
  }

  // Статус всех сервисов
  async status(): Promise<Map<string, ServiceStatus>> {
    const result = new Map<string, ServiceStatus>()

    logger.header('Статус сервисов')

    for (const [name, service] of this.services) {
      // Обновляем статус из реального состояния
      if (service instanceof DockerComposeService) {
        await service.refreshStatus()
      } else if (service instanceof BunService) {
        await service.refreshStatus()
      }

      const status = service.getStatus()
      result.set(name, status)

      const statusIcon = this.getStatusIcon(status)
      const statusColor = this.getStatusColor(status)
      logger.info(name, `${statusIcon} ${statusColor}${status}\x1b[0m`)

      // Для Docker сервисов показываем детали контейнеров
      if (service instanceof DockerComposeService && status === 'running') {
        const containerStatus = await service.checkContainerStatus()
        if (containerStatus === 'partial') {
          logger.warn(name, '  Некоторые контейнеры не запущены')
        }
      }

      // Показываем PID для Bun сервисов
      const state = service.state
      if (state.pid) {
        logger.info(name, `  PID: ${state.pid}`)
      }
      if (state.startedAt) {
        logger.info(name, `  Запущен: ${state.startedAt.toLocaleString()}`)
      }
      if (state.error) {
        logger.error(name, `  Ошибка: ${state.error}`)
      }
    }

    logger.separator()
    return result
  }

  private getStatusIcon(status: ServiceStatus): string {
    switch (status) {
      case 'running':
        return '●'
      case 'starting':
        return '◐'
      case 'stopping':
        return '◑'
      case 'stopped':
        return '○'
      case 'failed':
        return '✗'
      default:
        return '?'
    }
  }

  private getStatusColor(status: ServiceStatus): string {
    switch (status) {
      case 'running':
        return '\x1b[32m' // green
      case 'starting':
      case 'stopping':
        return '\x1b[33m' // yellow
      case 'stopped':
        return '\x1b[90m' // gray
      case 'failed':
        return '\x1b[31m' // red
      default:
        return '\x1b[0m'
    }
  }

  // Graceful shutdown при получении сигнала
  async shutdown(): Promise<void> {
    logger.header('Получен сигнал завершения')
    await this.stop()
    process.exit(0)
  }

  // Настройка обработчиков сигналов
  setupSignalHandlers(): void {
    const handler = async () => {
      await this.shutdown()
    }

    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
  }
}
