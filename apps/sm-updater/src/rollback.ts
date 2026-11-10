// Проверяемый rollback v2: replacement останавливается только cooperative IPC
// handoff; нет PID guessing и удаления чужих artefacts.

import type { UpdateTask, OperationResult } from './types'
import { readTask, writeTask } from './task'
import { restoreFromBackup } from './files'
import { startDaemon, waitForProcessExit } from './process'
import { performHealthCheck, requestDaemonHandoff } from './health'
import { logError, logInfo } from './log'

async function waitForApps(taskId: string, timeout: number): Promise<UpdateTask | null> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const current = await readTask()
    if (!current || current.id !== taskId) return null
    if (current.postUpdateApps.status === 'completed') return current
    if (current.postUpdateApps.status === 'failed') return null
    await Bun.sleep(200)
  }
  return null
}

export async function performRollback(task: UpdateTask, reason: string): Promise<OperationResult> {
  const current = await readTask()
  if (!current || current.id !== task.id || current.status !== 'in_progress') {
    const error = `Автооткат заблокирован: задача не в состоянии in_progress (${reason})`
    await logError(error)
    return { success: false, error }
  }
  const replacement = current.replacement
  if (!replacement?.identity) {
    const error = `Автооткат заблокирован: нет подтверждённой replacement identity (${reason})`
    current.status = 'manual_recovery'; current.error = error; delete current.completedAt
    await writeTask(current); await logError(error)
    return { success: false, error }
  }

  if (!(await requestDaemonHandoff(current, replacement.identity.instanceId))
    || !(await waitForProcessExit(replacement.identity.pid, 30000))) {
    const error = `Автооткат заблокирован: replacement не подтвердил handoff (${reason})`
    current.status = 'manual_recovery'; current.error = error; delete current.completedAt
    await writeTask(current); await logError(error)
    return { success: false, error }
  }

  const restored = await restoreFromBackup(current)
  if (!restored.success) return restored
  current.replacement = undefined
  current.postUpdateApps = { status: 'required' }
  await writeTask(current)
  const started = await startDaemon(current)
  if (!started.success) return started
  await writeTask(current)

  const version = current.components[0]?.currentVersion
  if (!version || !(await performHealthCheck(version, current.healthCheck.timeout, current))) {
    const error = 'Восстановленный daemon не подтвердил identity/исходную версию'
    current.status = 'manual_recovery'; current.error = error; delete current.completedAt
    await writeTask(current); return { success: false, error }
  }
  const ready = await waitForApps(current.id, current.healthCheck.timeout)
  if (!ready) return { success: false, error: 'Восстановленный daemon не подтвердил restart приложений' }
  ready.status = 'rolled_back'; ready.error = reason; ready.completedAt = new Date().toISOString()
  await writeTask(ready)
  await logInfo('Откат успешно завершён')
  return { success: true }
}

export async function recoverFromInterruptedUpdate(): Promise<void> {
  // Нетерминальная задача требует оператора: никаких догадок о владельце.
}
