// Управление только процессами, identity которых находится в v2 task.
// Здесь намеренно нет broad process matching: при сомнении updater fail-closed.

import { confinedPath } from '../../../packages/project/src'
import { closeSync, openSync } from 'node:fs'
import { getRootDir } from './task'
import { logError, logInfo } from './log'
import type { OperationResult, UpdateTask } from './types'

export async function waitForProcessExit(pid: number, timeout: number = 30000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      process.kill(pid, 0)
      await Bun.sleep(200)
    } catch {
      return true
    }
  }
  return false
}

/**
 * Direct start avoids the `daemon start` wrapper: returned PID is the daemon
 * which must claim the task gate before it opens IPC.
 */
export async function startDaemon(task: UpdateTask): Promise<OperationResult & { pid?: number }> {
  const rootDir = getRootDir()
  if (task.rootDir !== rootDir) return { success: false, error: 'Корень task не совпадает с updater' }
  const binary = confinedPath(rootDir, process.platform === 'win32' ? 'asm.exe' : 'asm')
  if (!(await Bun.file(binary).exists())) return { success: false, error: `Бинарник не найден: ${binary}` }
  const gate = crypto.randomUUID()
  let consoleFd: number | undefined
  try {
    if (Bun.env.SM_SELF_UPDATE_DEBUG === '1') {
      const consolePath = confinedPath(rootDir, '.update/daemon-console.log')
      consoleFd = openSync(consolePath, 'a', 0o600)
      await logInfo(`Диагностика stdout/stderr daemon: ${consolePath}`)
    }
    const process = Bun.spawn(
      [binary, '--daemon-mode', '--root', rootDir, '--update-task', task.id, '--update-gate', gate],
      {
        cwd: rootDir,
        stdio: ['ignore', consoleFd ?? 'ignore', consoleFd ?? 'ignore'],
        detached: true,
      },
    )
    process.unref()
    task.replacement = { pid: process.pid, gate }
    await logInfo(`Daemon запущен напрямую с PID: ${process.pid}`)
    return { success: true, pid: process.pid }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await logError(`Ошибка запуска daemon: ${message}`)
    return { success: false, error: message }
  } finally {
    // Spawn наследует fd; updater закрывает только свою копию.
    if (consoleFd !== undefined) closeSync(consoleFd)
  }
}
