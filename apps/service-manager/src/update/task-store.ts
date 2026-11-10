import { confinedPath } from '../../../../packages/project/src'
import { validSelfUpdateTask, validateTaskPaths } from '../../../../packages/project/src/task'
// Надёжное хранилище handoff-задачи self-update.
// Задачи v1 намеренно не читаются: в них daemonPid был PID CLI.

import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DaemonIdentity, UpdateTask } from './types'

const TASK_DIR = '.update'
const TASK_FILE = 'update-task.json'
const LOCK_DIR = 'self-update.lock'

export function taskPath(rootDir: string): string {
  return confinedPath(rootDir, `${TASK_DIR}/${TASK_FILE}`)
}

export function parseUpdateTask(value: unknown): UpdateTask | null {
  return validSelfUpdateTask(value) ? value as UpdateTask : null
}

export async function readUpdateTask(rootDir: string): Promise<UpdateTask | null> {
  const file = Bun.file(taskPath(rootDir))
  if (!(await file.exists())) return null
  const task = parseUpdateTask(JSON.parse(await file.text()))
  if (!task) throw new Error('Невалидная self-update task; требуется ручная проверка')
  validateTaskPaths(task, rootDir)
  return task
}

/** Атомарно публикует целую JSON-задачу. */
export async function writeUpdateTask(rootDir: string, task: UpdateTask): Promise<void> {
  validateTaskPaths(task, rootDir)
  const directory = confinedPath(rootDir, TASK_DIR)
  await mkdir(directory, { recursive: true })
  const target = taskPath(rootDir)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, JSON.stringify(task, null, 2))
  await rename(temporary, target)
}

/**
 * Короткая эксклюзивная секция для reserve/transition. Не удаляет чужую
 * незавершённую задачу и не пытается восстановить её автоматически.
 */
export async function withTaskLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const directory = confinedPath(rootDir, TASK_DIR)
  const lock = join(directory, LOCK_DIR)
  await mkdir(directory, { recursive: true })
  try {
    await mkdir(lock)
  } catch {
    throw new Error('Self-update уже выполняется или требует ручного восстановления')
  }
  try {
    return await operation()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}
