import type { UpdateTask } from '../update/types'
import { readUpdateTask as readTask, writeUpdateTask } from '../update/task-store'
import { loadProject } from '../config'
import type { ServiceManager } from '../manager'
import type { Supervisor } from './supervisor'
import { logger } from '../utils/logger'
import type { FileLogger } from './file-logger'

export interface PostSelfUpdateResult {
  triggered: boolean
  services: string[]
  error?: string
}

/**
 * Self-update SM в процессе: updater уже заменил бинарник и стартовал этот daemon.
 */
export function isSelfUpdateInProgress(task: UpdateTask | null): task is UpdateTask {
  if (!task) return false
  return task.status === 'in_progress' && task.handoff.acknowledged
    && task.components.some((component) => component.name === 'service-manager')
    && task.postUpdateApps.status !== 'completed'
}

export async function readUpdateTask(rootDir: string): Promise<UpdateTask | null> {
  return readTask(rootDir)
}

export async function restartAppsAfterSelfUpdate(options: {
  rootDir: string
  manager: Pick<ServiceManager, 'getService' | 'restart' | 'start'>
  supervisor?: Pick<Supervisor, 'adoptService'>
  fileLogger?: FileLogger
  daemon: { pid: number; instanceId: string; version: string }
}): Promise<PostSelfUpdateResult> {
  const { rootDir, manager, supervisor, fileLogger, daemon } = options
  const task = await readUpdateTask(rootDir)

  if (!isSelfUpdateInProgress(task)
    || task.rootDir !== rootDir
    || task.replacement?.identity?.pid !== daemon.pid
    || task.replacement.identity.instanceId !== daemon.instanceId
    || task.replacement.identity.version !== daemon.version) {
    return { triggered: false, services: [] }
  }

  task.postUpdateApps.status = 'restarting'
  await writeUpdateTask(rootDir, task)

  const services = loadProject(rootDir).services.filter((s) => s.type === 'bun').map((s) => s.name).filter((name) => manager.getService(name))
  if (services.length === 0) {
    task.postUpdateApps.status = 'completed'
    await writeUpdateTask(rootDir, task)
    return { triggered: false, services: [] }
  }

  const startMessage = `После self-update перезапускаем приложения: ${services.join(', ')}`
  logger.info('daemon', startMessage)
  fileLogger?.log('daemon', 'info', startMessage)

  try {
    await manager.restart(services)
    for (const name of services) {
      supervisor?.adoptService(name)
      const service = manager.getService(name)
      if (service && service.getStatus() !== 'running') {
        const retryMessage = `После restart ${name} не running — повторный start`
        logger.warn('daemon', retryMessage)
        fileLogger?.log('daemon', 'warn', retryMessage)
        await manager.start([name])
        supervisor?.adoptService(name)
      }
    }
    const okMessage = `Приложения перезапущены: ${services.join(', ')}`
    logger.success('daemon', okMessage)
    fileLogger?.log('daemon', 'info', okMessage)
    task.postUpdateApps.status = 'completed'
    await writeUpdateTask(rootDir, task)
    return { triggered: true, services }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('daemon', `Не удалось перезапустить приложения после self-update: ${message}`)
    fileLogger?.log('daemon', 'error', `Не удалось перезапустить приложения: ${message}`)
    task.postUpdateApps = { status: 'failed', error: message }
    await writeUpdateTask(rootDir, task)
    return { triggered: true, services, error: message }
  }
}
