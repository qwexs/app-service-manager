import { confinedPath } from '../../../packages/project/src'
import { validSelfUpdateTask, validateTaskPaths } from '../../../packages/project/src/task'
// Версионированное и атомарное хранилище задачи self-update.

import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpdateTask } from './types'
import { readIdentity } from '../../../packages/project/src'

export function getRootDir(): string {
  const index = process.argv.indexOf('--root')
  const root = index >= 0 ? process.argv[index + 1] : undefined
  if (!root) throw new Error('Требуется --root <absolute-project-root>')
  return readIdentity(root).rootDir
}

const TASK_DIR = '.update'
const TASK_FILE = 'update-task.json'

function taskPath(): string {
  return confinedPath(getRootDir(), `${TASK_DIR}/${TASK_FILE}`)
}

export function parseTask(value: unknown): UpdateTask | null {
  return validSelfUpdateTask(value) ? value as UpdateTask : null
}

export async function readTask(): Promise<UpdateTask | null> {
  const file = Bun.file(taskPath())
  if (!(await file.exists())) return null
  try {
    const task = parseTask(JSON.parse(await file.text()))
    if (!task) throw new Error('task не соответствует schema v2')
    validateTaskPaths(task, getRootDir())
    return task
  } catch (error) {
    throw new Error(`Невалидная self-update task; требуется controlled manual recovery: ${error instanceof Error ? error.message : error}`)
  }
}

export async function writeTask(task: UpdateTask): Promise<void> {
  const rootDir = getRootDir()
  if (task.rootDir !== rootDir) throw new Error('Корень задачи не совпадает с корнем updater')
  validateTaskPaths(task, rootDir)
  const dir = confinedPath(rootDir, TASK_DIR)
  await mkdir(dir, { recursive: true })
  const target = taskPath()
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, JSON.stringify(task, null, 2))
  await rename(temporary, target)
}

export async function updateTask(
  task: UpdateTask,
  mutate: (current: UpdateTask) => void,
): Promise<UpdateTask> {
  // Updater — единственный writer своих transition; runner меняет только
  // replacement identity/apps acknowledgement до terminal status.
  const current = await readTask()
  if (!current || current.id !== task.id) throw new Error('Задача self-update была заменена')
  mutate(current)
  await writeTask(current)
  return current
}
