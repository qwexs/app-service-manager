// Обработчики IPC команд для управления сервисами
// Методы: status, start, stop, restart, shutdown

import {
  createSuccessResponse,
  type Request,
  type SuccessResponse,
  type ErrorResponse,
  type StatusResult,
  type ServiceStatusInfo,
  type DaemonInfo,
  type ServiceCommandParams,
  type ServiceCommandResult,
  type ShutdownResult,
  type DaemonServiceStatus,
  type UpdateHandoffParams,
  type UpdateHandoffResult,
} from '../protocol'
import { invalidParams, serviceNotFound, serviceFailed, internalError } from '../errors'
import type { ServiceManager } from '../../manager'
import type { ServiceStatus } from '../../types'
import type { Supervisor } from '../../daemon/supervisor'

// ─────────────────────────────────────────────────────────────────────────────
// Контекст daemon для обработчиков команд
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandContext {
  manager: ServiceManager
  daemonPid: number
  daemonStartTime: number // timestamp запуска
  daemonVersion: string
  daemonInstanceId: string
  // Счётчики перезапусков для каждого сервиса (будут использоваться Supervisor в фазе 3)
  restartCounts: Map<string, number>
  // Callback для остановки daemon
  onShutdown: () => Promise<void>
  /** Планирует daemon-only handoff после отправки IPC-ответа. */
  onUpdateHandoff?: (taskId: string) => Promise<void>
  // Supervisor для автоматического перезапуска сервисов
  supervisor?: Supervisor
}

// ─────────────────────────────────────────────────────────────────────────────
// Преобразование типов
// ─────────────────────────────────────────────────────────────────────────────

// Преобразование ServiceStatus из types.ts в DaemonServiceStatus из protocol.ts
function toDaemonStatus(status: ServiceStatus): DaemonServiceStatus {
  if (status === 'unknown') return 'stopped'
  return status
}

// ─────────────────────────────────────────────────────────────────────────────
// Валидация параметров
// ─────────────────────────────────────────────────────────────────────────────

export function validateServiceCommandParams(params: unknown): ServiceCommandParams {
  // params может быть undefined — это валидно (означает все сервисы)
  if (params === undefined || params === null) {
    return {}
  }

  if (typeof params !== 'object') {
    throw invalidParams('Параметры должны быть объектом')
  }

  const obj = params as Record<string, unknown>

  // services — опциональный массив строк
  if (obj.services !== undefined) {
    if (!Array.isArray(obj.services)) {
      throw invalidParams('Параметр services должен быть массивом')
    }

    for (const name of obj.services) {
      if (typeof name !== 'string') {
        throw invalidParams('Все элементы services должны быть строками')
      }
    }
  }

  return {
    services: obj.services as string[] | undefined,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработчик status
// ─────────────────────────────────────────────────────────────────────────────

export type StatusResponse = SuccessResponse<StatusResult> | ErrorResponse

export async function handleStatus(request: Request, context: CommandContext): Promise<StatusResponse> {
  try {
    const { manager, daemonPid, daemonStartTime, daemonVersion, restartCounts } = context

    // Получаем статусы всех сервисов
    const statusMap = await manager.status()

    // Формируем информацию о daemon
    const daemonUptime = Math.floor((Date.now() - daemonStartTime) / 1000)
    const daemon: DaemonInfo = {
      pid: daemonPid,
      uptime: daemonUptime,
      version: daemonVersion,
      instanceId: context.daemonInstanceId,
    }

    // Формируем информацию о сервисах
    const services: ServiceStatusInfo[] = []

    for (const service of manager.getAllServices()) {
      const status = statusMap.get(service.name) || 'stopped'
      const state = service.state

      const serviceInfo: ServiceStatusInfo = {
        name: service.name,
        status: toDaemonStatus(status),
        restarts: restartCounts.get(service.name) || 0,
      }

      // Добавляем опциональные поля
      if (state.pid) {
        serviceInfo.pid = state.pid
      }

      if (state.startedAt) {
        // Вычисляем uptime сервиса в секундах
        serviceInfo.uptime = Math.floor((Date.now() - state.startedAt.getTime()) / 1000)
      }

      if (state.error) {
        serviceInfo.lastError = state.error
      }

      services.push(serviceInfo)
    }

    const result: StatusResult = {
      daemon,
      services,
    }

    return createSuccessResponse(request.id, result)
  } catch (error) {
    const ipcError = internalError(error instanceof Error ? error.message : String(error))
    return ipcError.toErrorResponse(request.id)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработчик start
// ─────────────────────────────────────────────────────────────────────────────

export type ServiceCommandResponse = SuccessResponse<ServiceCommandResult> | ErrorResponse

export async function handleStart(request: Request, context: CommandContext): Promise<ServiceCommandResponse> {
  try {
    const params = validateServiceCommandParams(request.params)
    const { manager, supervisor } = context

    // Валидация имён сервисов
    if (params.services) {
      for (const name of params.services) {
        if (!manager.getService(name)) {
          const error = serviceNotFound(name)
          return error.toErrorResponse(request.id)
        }
      }
    }

    // Запуск сервисов
    const serviceNames = params.services
    const results: ServiceCommandResult['services'] = []

    try {
      // Если есть supervisor — запускаем через него для автоперезапуска
      if (supervisor) {
        const servicesToStart = manager.getStartOrder(serviceNames)
        for (const name of servicesToStart) {
          await supervisor.startService(name)
        }
      } else {
        await manager.start(serviceNames)
      }

      // Получаем статусы после запуска
      const allServices = serviceNames ? serviceNames.map((n) => manager.getService(n)!) : manager.getAllServices()

      for (const service of allServices) {
        results.push({
          name: service.name,
          status: toDaemonStatus(service.getStatus()),
        })
      }

      return createSuccessResponse(request.id, {
        success: true,
        services: results,
      })
    } catch (error) {
      // Ошибка при запуске — возвращаем частичный результат
      const allServices = serviceNames ? serviceNames.map((n) => manager.getService(n)!) : manager.getAllServices()

      for (const service of allServices) {
        const status = service.getStatus()
        results.push({
          name: service.name,
          status: toDaemonStatus(status),
          error: status === 'failed' ? service.state.error : undefined,
        })
      }

      return createSuccessResponse(request.id, {
        success: false,
        services: results,
      })
    }
  } catch (error) {
    const ipcError = internalError(error instanceof Error ? error.message : String(error))
    return ipcError.toErrorResponse(request.id)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработчик stop
// ─────────────────────────────────────────────────────────────────────────────

export async function handleStop(request: Request, context: CommandContext): Promise<ServiceCommandResponse> {
  try {
    const params = validateServiceCommandParams(request.params)
    const { manager, supervisor } = context

    // Валидация имён сервисов
    if (params.services) {
      for (const name of params.services) {
        if (!manager.getService(name)) {
          const error = serviceNotFound(name)
          return error.toErrorResponse(request.id)
        }
      }
    }

    // Остановка сервисов
    const serviceNames = params.services
    const results: ServiceCommandResult['services'] = []

    try {
      // Если есть supervisor — останавливаем через него (убирает из мониторинга)
      if (supervisor) {
        const selected = serviceNames ?? manager.getAllServices().map((s) => s.name)
        const servicesToStop = manager.getStartOrder(selected).filter((name) => selected.includes(name)).reverse()
        for (const name of servicesToStop) {
          await supervisor.stopService(name)
        }
      } else {
        await manager.stop(serviceNames)
      }

      // Получаем статусы после остановки
      const allServices = serviceNames ? serviceNames.map((n) => manager.getService(n)!) : manager.getAllServices()

      for (const service of allServices) {
        results.push({
          name: service.name,
          status: toDaemonStatus(service.getStatus()),
        })
      }

      return createSuccessResponse(request.id, {
        success: true,
        services: results,
      })
    } catch (error) {
      // Ошибка при остановке — возвращаем частичный результат
      const allServices = serviceNames ? serviceNames.map((n) => manager.getService(n)!) : manager.getAllServices()

      for (const service of allServices) {
        const status = service.getStatus()
        results.push({
          name: service.name,
          status: toDaemonStatus(status),
          error: status === 'failed' ? service.state.error : undefined,
        })
      }

      return createSuccessResponse(request.id, {
        success: false,
        services: results,
      })
    }
  } catch (error) {
    const ipcError = internalError(error instanceof Error ? error.message : String(error))
    return ipcError.toErrorResponse(request.id)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработчик restart
// ─────────────────────────────────────────────────────────────────────────────

export async function handleRestart(request: Request, context: CommandContext): Promise<ServiceCommandResponse> {
  try {
    const params = validateServiceCommandParams(request.params)
    const { manager, restartCounts, supervisor } = context

    // Валидация имён сервисов
    if (params.services) {
      for (const name of params.services) {
        if (!manager.getService(name)) {
          const error = serviceNotFound(name)
          return error.toErrorResponse(request.id)
        }
      }
    }

    // Перезапуск сервисов
    const serviceNames = params.services
    const results: ServiceCommandResult['services'] = []

    try {
      const allServices = serviceNames ? serviceNames.map((n) => manager.getService(n)!) : manager.getAllServices()

      if (supervisor) {
        for (const service of allServices) {
          supervisor.resetFailedStatus(service.name)
        }
      }

      await manager.restart(serviceNames)

      for (const service of allServices) {
        if (supervisor) {
          supervisor.adoptService(service.name)
        } else {
          const currentCount = restartCounts.get(service.name) || 0
          restartCounts.set(service.name, currentCount + 1)
        }

        results.push({
          name: service.name,
          status: toDaemonStatus(service.getStatus()),
        })
      }

      return createSuccessResponse(request.id, {
        success: true,
        services: results,
      })
    } catch (error) {
      // Ошибка при перезапуске — возвращаем частичный результат
      const allServices = serviceNames ? serviceNames.map((n) => manager.getService(n)!) : manager.getAllServices()

      for (const service of allServices) {
        const status = service.getStatus()
        results.push({
          name: service.name,
          status: toDaemonStatus(status),
          error: status === 'failed' ? service.state.error : undefined,
        })
      }

      return createSuccessResponse(request.id, {
        success: false,
        services: results,
      })
    }
  } catch (error) {
    const ipcError = internalError(error instanceof Error ? error.message : String(error))
    return ipcError.toErrorResponse(request.id)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработчик shutdown
// ─────────────────────────────────────────────────────────────────────────────

export type ShutdownResponse = SuccessResponse<ShutdownResult> | ErrorResponse

export async function handleShutdown(request: Request, context: CommandContext): Promise<ShutdownResponse> {
  try {
    const { manager, onShutdown } = context

    // Health loop не должен поднять child во время shutdown.
    context.supervisor?.beginPending(manager.getAllServices().map((s) => s.name))
    await manager.stop()

    // Отправляем успешный ответ перед завершением
    const result: ShutdownResult = {
      success: true,
      message: 'Daemon остановлен',
    }

    // Планируем shutdown после отправки ответа
    setImmediate(() => {
      void onShutdown().catch((error) => console.error('Shutdown не подтверждён:', error))
    })

    return createSuccessResponse(request.id, result)
  } catch (error) {
    const ipcError = internalError(error instanceof Error ? error.message : String(error))
    return ipcError.toErrorResponse(request.id)
  }
}

/**
 * Подтверждает handoff только текущему daemon instance. Реальный выход
 * планируется callback-ом, чтобы JSON-RPC ответ успел уйти клиенту.
 */
export async function handleUpdateHandoff(
  request: Request,
  context: CommandContext,
): Promise<SuccessResponse<UpdateHandoffResult> | ErrorResponse> {
  const params = request.params as UpdateHandoffParams | undefined
  if (!params || typeof params.taskId !== 'string' || typeof params.instanceId !== 'string') {
    return invalidParams('Нужны taskId и instanceId').toErrorResponse(request.id)
  }
  if (params.instanceId !== context.daemonInstanceId || !context.onUpdateHandoff) {
    return invalidParams('Handoff не принадлежит этому daemon').toErrorResponse(request.id)
  }
  await context.onUpdateHandoff(params.taskId)
  return createSuccessResponse(request.id, { accepted: true })
}
