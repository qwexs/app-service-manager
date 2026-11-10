import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseUpdateTask, readUpdateTask, withTaskLock, writeUpdateTask } from '../../src/update/task-store'
import type { UpdateTask } from '../../src/update/types'

const root = join(process.cwd(), '.test-self-update-task-store')

function task(): UpdateTask {
  return {
    schemaVersion: 2,
    id: 'task-1',
    createdAt: new Date().toISOString(),
    rootDir: root,
    components: [{ name: 'service-manager', currentVersion: '1.0.29', targetVersion: '1.0.30', sourcePath: '.update/asm.new', targetPath: 'asm', backupPath: '.update/asm.old', sha256: 'a'.repeat(64) }],
    daemon: { pid: 42, instanceId: 'daemon-instance-1234', rootDir: root, version: '1.0.29' },
    status: 'pending',
    handoff: { requested: true, acknowledged: false },
    postUpdateApps: { status: 'required' },
    healthCheck: { enabled: true, timeout: 30000, endpoint: 'ipc' },
    rollbackOnFailure: true,
  }
}

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('self-update task store', () => {
  test('отвергает legacy task с PID CLI', () => {
    expect(parseUpdateTask({ daemonPid: process.pid, status: 'pending' })).toBeNull()
  })

  test('атомарно сохраняет и читает только v2 task', async () => {
    await mkdir(root, { recursive: true })
    await writeUpdateTask(root, task())
    expect((await readUpdateTask(root))?.daemon.instanceId).toBe('daemon-instance-1234')
  })

  test('не допускает две одновременные reserve-секции', async () => {
    await mkdir(root, { recursive: true })
    await withTaskLock(root, async () => {
      await expect(withTaskLock(root, async () => {})).rejects.toThrow('Self-update уже выполняется')
    })
  })
})
