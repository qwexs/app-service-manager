// Unit-тесты для Supervisor
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import {
  Supervisor,
  createSupervisor,
  DEFAULT_AUTO_RESTART_CONFIG,
  type AutoRestartConfig,
  type SupervisorEvent,
} from '../../src/daemon/supervisor'
import type { ServiceManager } from '../../src/manager'
import type { IService, ServiceState, ServiceStatus, ServiceConfig } from '../../src/types'

// ─────────────────────────────────────────────────────────────────────────────
// Моки
// ─────────────────────────────────────────────────────────────────────────────

// Мок сервиса
function createMockService(name: string, status: ServiceStatus = 'stopped'): IService {
  const state: ServiceState = {
    status,
    pid: status === 'running' ? 12345 : undefined,
    startedAt: status === 'running' ? new Date() : undefined,
  }

  return {
    name,
    config: { name, type: 'bun', cwd: '.', executable: 'index.ts' } as ServiceConfig,
    state,
    getStatus: () => state.status,
    start: mock(async () => {
      state.status = 'running'
      state.pid = 12345
      state.startedAt = new Date()
    }),
    stop: mock(async () => {
      state.status = 'stopped'
      state.pid = undefined
    }),
    restart: mock(async () => {}),
    waitForHealthy: mock(async () => true),
    checkHealth: mock(async () => true),
    on: mock(() => () => {}),
  }
}

// Мок ServiceManager
function createMockManager(services: IService[]): ServiceManager {
  const serviceMap = new Map(services.map((s) => [s.name, s]))

  return {
    getService: (name: string) => serviceMap.get(name),
    getAllServices: () => services,
    getStartOrder: (names?: string[]) => names ?? services.map((s) => s.name),
    withLifecycle: async <T>(operation: () => Promise<T>) => operation(),
    start: mock(async (names?: string[]) => {
      const targets = names ? names.map((n) => serviceMap.get(n)!).filter(Boolean) : services
      for (const service of targets) {
        await service.start()
      }
    }),
    stop: mock(async (names?: string[]) => {
      const targets = names ? names.map((n) => serviceMap.get(n)!).filter(Boolean) : services
      for (const service of targets) {
        await service.stop()
      }
    }),
    restart: mock(async () => {}),
    status: mock(async () => new Map()),
    shutdown: mock(async () => {}),
    setupSignalHandlers: mock(() => {}),
  } as unknown as ServiceManager
}

type RestartInfoMap = Map<string, {
  markedAsFailed: boolean
  restartTimestamps: number[]
  totalRestarts: number
}>

function restartInfoMapOf(sup: Supervisor): RestartInfoMap {
  return (sup as unknown as { restartInfoMap: RestartInfoMap }).restartInfoMap
}

function markFailed(
  sup: Supervisor,
  name: string,
  options?: { timestamps?: number[]; totalRestarts?: number },
): void {
  const info = restartInfoMapOf(sup).get(name)
  if (!info) throw new Error(`Нет restart info для ${name}`)
  info.markedAsFailed = true
  info.restartTimestamps = options?.timestamps ?? [Date.now()]
  if (options?.totalRestarts !== undefined) {
    info.totalRestarts = options.totalRestarts
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Тесты
// ─────────────────────────────────────────────────────────────────────────────

describe('Supervisor', () => {
  let supervisor: Supervisor
  let mockManager: ServiceManager
  let mockServices: IService[]

  beforeEach(() => {
    mockServices = [createMockService('app'), createMockService('worker')]
    mockManager = createMockManager(mockServices)
    supervisor = createSupervisor({
      manager: mockManager,
      config: {
        healthCheckInterval: 100, // Быстрый интервал для тестов
        initialDelay: 10,
        maxDelay: 100,
      },
    })
  })

  afterEach(() => {
    supervisor.stop()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Создание Supervisor
  // ─────────────────────────────────────────────────────────────────────────

  describe('createSupervisor', () => {
    test('создаёт экземпляр Supervisor', () => {
      const sup = createSupervisor({ manager: mockManager })
      expect(sup).toBeInstanceOf(Supervisor)
      sup.stop()
    })

    test('использует конфигурацию по умолчанию', () => {
      const sup = createSupervisor({ manager: mockManager })
      expect(sup.isRunning()).toBe(false)
      sup.stop()
    })

    test('принимает пользовательскую конфигурацию', () => {
      const config: Partial<AutoRestartConfig> = {
        enabled: false,
        maxRestarts: 10,
      }
      const sup = createSupervisor({ manager: mockManager, config })
      expect(sup).toBeInstanceOf(Supervisor)
      sup.stop()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Запуск и остановка
  // ─────────────────────────────────────────────────────────────────────────

  describe('start/stop', () => {
    test('start запускает supervisor', () => {
      expect(supervisor.isRunning()).toBe(false)
      supervisor.start()
      expect(supervisor.isRunning()).toBe(true)
    })

    test('stop останавливает supervisor', () => {
      supervisor.start()
      expect(supervisor.isRunning()).toBe(true)
      supervisor.stop()
      expect(supervisor.isRunning()).toBe(false)
    })

    test('повторный start не вызывает ошибку', () => {
      supervisor.start()
      expect(() => supervisor.start()).not.toThrow()
      expect(supervisor.isRunning()).toBe(true)
    })

    test('повторный stop не вызывает ошибку', () => {
      supervisor.stop()
      expect(() => supervisor.stop()).not.toThrow()
      expect(supervisor.isRunning()).toBe(false)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Управление сервисами
  // ─────────────────────────────────────────────────────────────────────────

  describe('startService', () => {
    test('запускает сервис через manager', async () => {
      await supervisor.startService('app')
      expect(mockManager.start).toHaveBeenCalledWith(['app'])
    })

    test('добавляет сервис в мониторинг', async () => {
      await supervisor.startService('app')
      const stats = supervisor.getServiceStats('app')
      expect(stats).not.toBeNull()
      expect(stats!.restarts).toBe(0)
    })

    test('сбрасывает markedAsFailed при повторном старте', async () => {
      await supervisor.startService('app')
      markFailed(supervisor, 'app', { timestamps: [Date.now(), Date.now()] })

      await supervisor.startService('app')

      const stats = supervisor.getServiceStats('app')
      expect(stats!.markedAsFailed).toBe(false)
    })

    test('выбрасывает ошибку для несуществующего сервиса', async () => {
      await expect(supervisor.startService('unknown')).rejects.toThrow('Сервис unknown не найден')
    })
  })

  describe('stopService', () => {
    test('останавливает сервис через manager', async () => {
      await supervisor.startService('app')
      await supervisor.stopService('app')
      expect(mockManager.stop).toHaveBeenCalledWith(['app'])
    })

    test('удаляет сервис из мониторинга', async () => {
      await supervisor.startService('app')
      await supervisor.stopService('app')
      // Сервис всё ещё доступен через manager, но не мониторится
    })
  })

  describe('pending', () => {
    test('beginPending/endPending держат hold-Set без смены статуса', async () => {
      await supervisor.startService('app')
      expect(supervisor.isPending('app')).toBe(false)

      supervisor.beginPending(['worker', 'app'])
      expect(supervisor.isPending('app')).toBe(true)
      expect(supervisor.isPending('worker')).toBe(true)
      expect(supervisor.getServiceStats('app')!.status).toBe('running')

      supervisor.endPending(['app'])
      expect(supervisor.isPending('app')).toBe(false)
      expect(supervisor.isPending('worker')).toBe(true)
    })

    test('health не поднимает сервис в pending после stop через manager', async () => {
      const fastSupervisor = createSupervisor({
        manager: mockManager,
        config: {
          healthCheckInterval: 40,
          initialDelay: 5,
          maxDelay: 20,
        },
      })

      await fastSupervisor.startService('app')
      await fastSupervisor.startService('worker')
      fastSupervisor.beginPending(['worker', 'app'])
      await mockManager.stop(['worker', 'app'])
      ;(mockServices[0] as { state: ServiceState }).state.status = 'stopped'
      ;(mockServices[1] as { state: ServiceState }).state.status = 'stopped'

      const startCallsBefore = (mockManager.start as ReturnType<typeof mock>).mock.calls.length
      fastSupervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 150))
      fastSupervisor.stop()

      expect((mockManager.start as ReturnType<typeof mock>).mock.calls.length).toBe(startCallsBefore)
      expect(fastSupervisor.isPending('app')).toBe(true)
    })

    test('startService в pending не вызывает manager.start', async () => {
      await supervisor.startService('app')
      supervisor.beginPending(['app'])
      const startCallsBefore = (mockManager.start as ReturnType<typeof mock>).mock.calls.length

      await supervisor.startService('app')

      expect((mockManager.start as ReturnType<typeof mock>).mock.calls.length).toBe(startCallsBefore)
    })
  })

  describe('adoptService', () => {
    test('добавляет запущенный сервис в мониторинг', () => {
      // Делаем сервис "запущенным"
      const service = mockServices[0]
      ;(service as { state: ServiceState }).state.status = 'running'

      supervisor.adoptService('app')
      const stats = supervisor.getServiceStats('app')
      expect(stats).not.toBeNull()
    })

    test('берёт остановленный сервис в мониторинг', () => {
      supervisor.adoptService('app')
      expect(supervisor.getRestartCounts().has('app')).toBe(true)
      expect(supervisor.getServiceStats('app')!.status).toBe('stopped')
    })

    test('перезапускает adopted сервис, если он уже не running', async () => {
      const fastSupervisor = createSupervisor({
        manager: mockManager,
        config: {
          healthCheckInterval: 40,
          initialDelay: 5,
          maxDelay: 20,
        },
      })

      supervisor.stop()
      fastSupervisor.adoptService('app')
      ;(mockServices[0] as { state: ServiceState }).state.status = 'stopped'

      const startCallsBefore = (mockManager.start as ReturnType<typeof mock>).mock.calls.length
      fastSupervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 120))
      fastSupervisor.stop()

      expect((mockManager.start as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(startCallsBefore)
    })

    test('игнорирует несуществующий сервис', () => {
      expect(() => supervisor.adoptService('unknown')).not.toThrow()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Статистика
  // ─────────────────────────────────────────────────────────────────────────

  describe('getServiceStats', () => {
    test('возвращает null для несуществующего сервиса', () => {
      const stats = supervisor.getServiceStats('unknown')
      expect(stats).toBeNull()
    })

    test('возвращает статистику сервиса', async () => {
      await supervisor.startService('app')
      const stats = supervisor.getServiceStats('app')

      expect(stats).not.toBeNull()
      expect(stats!.name).toBe('app')
      expect(stats!.status).toBe('running')
      expect(stats!.restarts).toBe(0)
      expect(stats!.markedAsFailed).toBe(false)
    })

    test('включает PID запущенного сервиса', async () => {
      await supervisor.startService('app')
      const stats = supervisor.getServiceStats('app')
      expect(stats!.pid).toBe(12345)
    })
  })

  describe('getAllStats', () => {
    test('возвращает статистику всех сервисов', () => {
      const stats = supervisor.getAllStats()
      expect(stats).toHaveLength(2)
      expect(stats.map((s) => s.name)).toEqual(['app', 'worker'])
    })
  })

  describe('getRestartCount', () => {
    test('возвращает 0 для нового сервиса', () => {
      expect(supervisor.getRestartCount('app')).toBe(0)
    })
  })

  describe('getRestartCounts', () => {
    test('возвращает Map с количеством перезапусков', async () => {
      await supervisor.startService('app')
      const counts = supervisor.getRestartCounts()
      expect(counts).toBeInstanceOf(Map)
      expect(counts.get('app')).toBe(0)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Сброс статуса failed
  // ─────────────────────────────────────────────────────────────────────────

  describe('resetFailedStatus', () => {
    test('сбрасывает статус failed', async () => {
      await supervisor.startService('app')
      markFailed(supervisor, 'app')

      supervisor.resetFailedStatus('app')
      const stats = supervisor.getServiceStats('app')
      expect(stats!.markedAsFailed).toBe(false)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // События
  // ─────────────────────────────────────────────────────────────────────────

  describe('on (события)', () => {
    test('подписка на события возвращает функцию отписки', () => {
      const handler = mock(() => {})
      const unsubscribe = supervisor.on(handler)
      expect(typeof unsubscribe).toBe('function')
    })

    test('отписка удаляет обработчик', () => {
      const handler = mock(() => {})
      const unsubscribe = supervisor.on(handler)
      unsubscribe()
      // Обработчик не должен вызываться после отписки
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Автоперезапуск с backoff
  // ─────────────────────────────────────────────────────────────────────────

  describe('автоперезапуск', () => {
    test('перезапускает упавший сервис', async () => {
      // Конфигурация с быстрым интервалом
      const fastSupervisor = createSupervisor({
        manager: mockManager,
        config: {
          healthCheckInterval: 50,
          initialDelay: 10,
          maxDelay: 100,
        },
      })

      // Запускаем сервис
      await fastSupervisor.startService('app')

      // Симулируем падение сервиса
      const service = mockServices[0]
      ;(service as { state: ServiceState }).state.status = 'stopped'
      ;(service as { state: ServiceState }).state.pid = undefined

      // Запускаем supervisor и ждём health check
      fastSupervisor.start()

      // Ждём, пока supervisor обнаружит падение и перезапустит
      await new Promise((resolve) => setTimeout(resolve, 200))

      fastSupervisor.stop()

      // Проверяем, что сервис был перезапущен
      expect(mockManager.start).toHaveBeenCalled()
    })

    test('увеличивает счётчик перезапусков', async () => {
      const fastSupervisor = createSupervisor({
        manager: mockManager,
        config: {
          healthCheckInterval: 50,
          initialDelay: 10,
          maxDelay: 100,
        },
      })

      await fastSupervisor.startService('app')

      // Симулируем падение
      const service = mockServices[0]
      ;(service as { state: ServiceState }).state.status = 'stopped'

      fastSupervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 200))
      fastSupervisor.stop()

      const count = fastSupervisor.getRestartCount('app')
      expect(count).toBeGreaterThanOrEqual(1)
    })

    test('помечает сервис как failed после maxRestarts', async () => {
      const fastSupervisor = createSupervisor({
        manager: mockManager,
        config: {
          healthCheckInterval: 30,
          initialDelay: 5,
          maxDelay: 20,
          maxRestarts: 2,
          restartWindow: 60_000,
        },
      })

      await fastSupervisor.startService('app')

      // Делаем сервис всегда падающим
      const service = mockServices[0]
      ;(service.start as ReturnType<typeof mock>).mockImplementation(async () => {
        // Сервис сразу падает после запуска
        ;(service as { state: ServiceState }).state.status = 'stopped'
      })
      ;(service as { state: ServiceState }).state.status = 'stopped'

      fastSupervisor.start()

      // Ждём несколько циклов
      await new Promise((resolve) => setTimeout(resolve, 400))

      fastSupervisor.stop()

      const stats = fastSupervisor.getServiceStats('app')
      expect(stats!.markedAsFailed).toBe(true)
    })

    test('не перезапускает сервис с markedAsFailed, пока окно не истекло', async () => {
      const fastSupervisor = createSupervisor({
        manager: mockManager,
        config: {
          healthCheckInterval: 50,
          initialDelay: 10,
          maxRestarts: 2,
          restartWindow: 60_000,
        },
      })

      await fastSupervisor.startService('app')

      markFailed(fastSupervisor, 'app', { timestamps: [Date.now(), Date.now()] })
      ;(mockServices[0] as { state: ServiceState }).state.status = 'stopped'

      const startCallsBefore = (mockManager.start as ReturnType<typeof mock>).mock.calls.length

      fastSupervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 150))
      fastSupervisor.stop()

      const startCallsAfter = (mockManager.start as ReturnType<typeof mock>).mock.calls.length
      expect(startCallsAfter).toBe(startCallsBefore)
    })

    test('после истечения окна снова перезапускает markedAsFailed сервис', async () => {
      const fastSupervisor = createSupervisor({
        manager: mockManager,
        config: {
          healthCheckInterval: 40,
          initialDelay: 5,
          maxDelay: 20,
          maxRestarts: 2,
          restartWindow: 100,
        },
      })

      await fastSupervisor.startService('app')
      markFailed(fastSupervisor, 'app', {
        timestamps: [Date.now() - 500, Date.now() - 400],
        totalRestarts: 2,
      })
      ;(mockServices[0] as { state: ServiceState }).state.status = 'stopped'

      const startCallsBefore = (mockManager.start as ReturnType<typeof mock>).mock.calls.length

      fastSupervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 150))
      fastSupervisor.stop()

      const startCallsAfter = (mockManager.start as ReturnType<typeof mock>).mock.calls.length
      expect(startCallsAfter).toBeGreaterThan(startCallsBefore)
      expect(fastSupervisor.getServiceStats('app')!.markedAsFailed).toBe(false)
    })
  })

  describe('health probe', () => {
    test('перезапускает running сервис после порога неуспешных checkHealth', async () => {
      const service = mockServices[0]
      service.checkHealth = mock(async () => false)

      const fastSupervisor = createSupervisor({
        manager: mockManager,
        config: {
          healthCheckInterval: 40,
          initialDelay: 10,
          maxDelay: 50,
          healthFailThreshold: 2,
        },
      })

      await fastSupervisor.startService('app')
      const startCallsBefore = (mockManager.start as ReturnType<typeof mock>).mock.calls.length

      fastSupervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 250))
      fastSupervisor.stop()

      const startCallsAfter = (mockManager.start as ReturnType<typeof mock>).mock.calls.length
      expect(startCallsAfter).toBeGreaterThan(startCallsBefore)
    })

    test('не рестартит, если checkHealth снова успешен', async () => {
      const service = mockServices[0]
      let calls = 0
      service.checkHealth = mock(async () => {
        calls++
        return calls > 1
      })

      const fastSupervisor = createSupervisor({
        manager: mockManager,
        config: {
          healthCheckInterval: 40,
          initialDelay: 10,
          healthFailThreshold: 3,
        },
      })

      await fastSupervisor.startService('app')
      const startCallsBefore = (mockManager.start as ReturnType<typeof mock>).mock.calls.length

      fastSupervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 200))
      fastSupervisor.stop()

      const startCallsAfter = (mockManager.start as ReturnType<typeof mock>).mock.calls.length
      expect(startCallsAfter).toBe(startCallsBefore)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Тесты конфигурации по умолчанию
// ─────────────────────────────────────────────────────────────────────────────

describe('DEFAULT_AUTO_RESTART_CONFIG', () => {
  test('содержит все необходимые поля', () => {
    expect(DEFAULT_AUTO_RESTART_CONFIG.enabled).toBe(true)
    expect(DEFAULT_AUTO_RESTART_CONFIG.maxRestarts).toBe(5)
    expect(DEFAULT_AUTO_RESTART_CONFIG.restartWindow).toBe(300_000)
    expect(DEFAULT_AUTO_RESTART_CONFIG.backoffMultiplier).toBe(2)
    expect(DEFAULT_AUTO_RESTART_CONFIG.initialDelay).toBe(1000)
    expect(DEFAULT_AUTO_RESTART_CONFIG.maxDelay).toBe(30_000)
    expect(DEFAULT_AUTO_RESTART_CONFIG.healthCheckInterval).toBe(10_000)
    expect(DEFAULT_AUTO_RESTART_CONFIG.healthFailThreshold).toBe(3)
  })
})
