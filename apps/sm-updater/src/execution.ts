import { createHash } from 'node:crypto'
import { mkdir, open, unlink } from 'node:fs/promises'
import { confinedPath } from '../../../packages/project/src'
import { getRootDir } from './task'

export interface ExecutionLock {
  claim(taskId: string): Promise<void>
  release(): Promise<void>
}

export async function acquireExecutionLock(): Promise<ExecutionLock> {
  const root = getRootDir()
  await mkdir(confinedPath(root, '.update'), { recursive: true })
  const lockPath = confinedPath(root, '.update/updater-execution.lock')
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Updater уже запущен или прерван; требуется ручное восстановление')
    }
    throw error
  }

  return {
    async claim(taskId) {
      // Task id не становится частью пути: schema допускает произвольную строку.
      const key = createHash('sha256').update(taskId).digest('hex')
      const markerPath = confinedPath(root, `.update/updater-claim-${key}.json`)
      let marker
      try {
        marker = await open(markerPath, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Задача updater уже запускалась или прервана; требуется ручное восстановление')
        }
        throw error
      }
      try {
        await marker.writeFile(JSON.stringify({ taskId }))
        await marker.sync()
      } finally {
        await marker.close()
      }
      // Marker намеренно остаётся и после успеха/ошибки; recovery здесь нет.
    },
    async release() {
      await lock.close()
      await unlink(confinedPath(root, '.update/updater-execution.lock'))
    },
  }
}
