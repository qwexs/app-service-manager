// Типы и интерфейсы для Service Manager

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' | 'unknown'

export type ServiceType = 'bun' | 'docker-compose'

export interface ServiceConfig {
  name: string
  type: ServiceType
  // Путь к рабочей директории относительно корня проекта
  cwd: string
  // Заявленный порт сервиса; чужие listeners не останавливаем
  port?: number
  // Зависимости — имена сервисов, которые должны быть запущены перед этим
  dependsOn?: string[]
  // Health check конфигурация
  healthCheck?: HealthCheckConfig
}

export interface BunServiceConfig extends ServiceConfig {
  type: 'bun'
  // Путь к исполняемому файлу относительно cwd
  executable: string
  // Аргументы командной строки
  args?: string[]
}

export interface DockerComposeServiceConfig extends ServiceConfig {
  type: 'docker-compose'
  // Путь к docker-compose файлу относительно cwd
  composeFile: string
  // Имена сервисов в compose файле (если нужно запустить только некоторые)
  services?: string[]
}

export interface HealthCheckConfig {
  // Тип проверки
  type: 'http' | 'tcp' | 'command'
  // Для HTTP: URL для проверки
  url?: string
  // Для TCP: хост и порт
  host?: string
  port?: number
  // Для command: команда для выполнения
  command?: string[]
  // Интервал проверки в мс
  interval?: number
  // Таймаут одной проверки в мс
  timeout?: number
  // Количество попыток перед признанием сервиса готовым
  retries?: number
  // Начальная задержка перед первой проверкой в мс
  initialDelay?: number
}

export interface ServiceState {
  status: ServiceStatus
  pid?: number
  startedAt?: Date
  error?: string
}

// Интерфейс для абстрактного сервиса
export interface IService {
  readonly name: string
  readonly config: ServiceConfig
  readonly state: ServiceState

  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  getStatus(): ServiceStatus
  waitForHealthy(timeoutMs?: number): Promise<boolean>
  checkHealth(): Promise<boolean>
  on(handler: ServiceEventHandler): () => void
}

// События сервиса
export type ServiceEventType = 'started' | 'stopped' | 'failed' | 'healthy' | 'unhealthy' | 'output'

export interface ServiceEvent {
  type: ServiceEventType
  service: string
  timestamp: Date
  data?: unknown
}

export type ServiceEventHandler = (event: ServiceEvent) => void
