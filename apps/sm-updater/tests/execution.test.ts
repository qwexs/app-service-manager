import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalRoot } from '../../../packages/project/src'
import { acquireExecutionLock } from '../src/execution'
import { main } from '../src/index'
import * as files from '../src/files'
import * as health from '../src/health'
import * as log from '../src/log'
import * as processes from '../src/process'
import * as rollback from '../src/rollback'
import { readTask, writeTask } from '../src/task'
import type { UpdateTask } from '../src/types'

let root: string
let outside: string
let argv: string[]
let exitCode: typeof process.exitCode
let wait: ReturnType<typeof spyOn<typeof processes, 'waitForProcessExit'>>
let replace: ReturnType<typeof spyOn<typeof files, 'replaceFiles'>>
let start: ReturnType<typeof spyOn<typeof processes, 'startDaemon'>>
let check: ReturnType<typeof spyOn<typeof health, 'performHealthCheck'>>
let revert: ReturnType<typeof spyOn<typeof rollback, 'performRollback'>>

function task(status: UpdateTask['status'] = 'in_progress'): UpdateTask {
  return {
    schemaVersion: 2, id: 'task-first', rootDir: root, createdAt: '2026-01-01T00:00:00.000Z',
    status, components: [{ name: 'service-manager', currentVersion: '0.1.0', targetVersion: '0.2.0',
      sourcePath: '.update/asm.new', targetPath: 'asm',
      backupPath: '.update/asm.old', sha256: 'a'.repeat(64) }],
    daemon: { pid: 12345, instanceId: 'original-instance', rootDir: root, version: '0.1.0' },
    handoff: { requested: true, acknowledged: true }, postUpdateApps: { status: 'required' },
    healthCheck: { enabled: true, endpoint: 'ipc', timeout: 1000 }, rollbackOnFailure: true,
  }
}

function markerPath(taskId: string): string {
  const key = createHash('sha256').update(taskId).digest('hex')
  return join(root, '.update', `updater-claim-${key}.json`)
}

async function expectReleased(): Promise<void> {
  expect(await Bun.file(join(root, '.update/updater-execution.lock')).exists()).toBe(false)
}

beforeEach(async () => {
  root = canonicalRoot(await mkdtemp(join(tmpdir(), 'sm-execution-')))
  outside = canonicalRoot(await mkdtemp(join(tmpdir(), 'sm-execution-outside-')))
  await writeFile(join(root, 'sm.project.json'), JSON.stringify({ id: 'fixture' }))
  argv = process.argv
  exitCode = process.exitCode
  process.argv = [argv[0]!, argv[1]!, '--root', root]
  process.exitCode = 0
  // Даже при регрессии test не завершает Bun и не запускает настоящий runtime.
  spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit запрещён') })
  spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('spawn запрещён') })
  for (const name of ['logInfo', 'logWarn', 'logError'] as const) spyOn(log, name).mockResolvedValue(undefined)
  wait = spyOn(processes, 'waitForProcessExit').mockResolvedValue(true)
  replace = spyOn(files, 'replaceFiles').mockResolvedValue({ success: true })
  start = spyOn(processes, 'startDaemon').mockResolvedValue({ success: true, pid: 23456 })
  check = spyOn(health, 'performHealthCheck').mockImplementation(async () => {
    const current = (await readTask())!
    current.postUpdateApps.status = 'completed'
    await writeTask(current)
    return true
  })
  revert = spyOn(rollback, 'performRollback').mockResolvedValue({ success: true })
})

afterEach(async () => {
  mock.restore()
  process.argv = argv
  process.exitCode = exitCode
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

for (const status of ['pending', 'in_progress'] as const) {
  test(`первый ${status} handoff исполняется и сохраняет claim после release`, async () => {
    const prepared = task(status)
    await writeTask(prepared)
    expect(await main()).toBeUndefined()
    expect(process.exitCode).toBe(0)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    expect(revert).not.toHaveBeenCalled()
    expect((await readTask())?.status).toBe('completed')
    expect(await Bun.file(markerPath(prepared.id)).json()).toEqual({ taskId: prepared.id })
    await expectReleased()
  })
}

test('прерванная claimed task с live replacement не доходит до wait/replace/rollback', async () => {
  const prepared = task()
  prepared.replacement = { pid: 23456, gate: 'replacement-gate', identity: {
    pid: 23456, instanceId: 'replacement-instance', rootDir: root, version: '0.2.0',
  } }
  await writeTask(prepared)
  const previous = await acquireExecutionLock()
  await previous.claim(prepared.id)
  await previous.release()
  const before = await Bun.file(join(root, '.update/update-task.json')).text()
  const result = await main().then(() => null, error => error)
  expect(wait).not.toHaveBeenCalled()
  expect(replace).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
  expect(revert).not.toHaveBeenCalled()
  expect(result).toBeInstanceOf(Error)
  expect(await Bun.file(join(root, '.update/update-task.json')).text()).toBe(before)
  await expectReleased()
})

test('конкурентный main блокируется до task transition, первый остаётся единственным writer', async () => {
  await writeTask(task())
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<boolean>()
  wait.mockImplementation(() => { entered.resolve(); return finish.promise })
  const first = main()
  await entered.promise
  try {
    const before = await Bun.file(join(root, '.update/update-task.json')).text()
    await expect(main()).rejects.toThrow('уже запущен или прерван')
    expect(await Bun.file(join(root, '.update/update-task.json')).text()).toBe(before)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
    expect(revert).not.toHaveBeenCalled()
  } finally {
    finish.resolve(true)
    await first
  }
  expect(replace).toHaveBeenCalledTimes(1)
  await expectReleased()
})

test('оставшийся после crash lock не снимается даже без PID/claim', async () => {
  await writeTask(task())
  await writeFile(join(root, '.update/updater-execution.lock'), '')
  await expect(main()).rejects.toThrow('уже запущен или прерван')
  expect(wait).not.toHaveBeenCalled()
  expect(replace).not.toHaveBeenCalled()
  expect(revert).not.toHaveBeenCalled()
  expect(await Bun.file(join(root, '.update/updater-execution.lock')).exists()).toBe(true)
})

test('normal failure освобождает lock, но оставляет claim и повтор блокируется', async () => {
  const prepared = task()
  await writeTask(prepared)
  check.mockResolvedValue(false)
  prepared.rollbackOnFailure = false
  await writeTask(prepared)
  await main()
  expect(process.exitCode).toBe(1)
  expect((await readTask())?.status).toBe('manual_recovery')
  await expectReleased()
  expect(await Bun.file(markerPath(prepared.id)).exists()).toBe(true)
  // Сымитирован незавершённый persisted state: статус не является execution claim.
  await writeTask(prepared)
  await expect(main()).rejects.toThrow('уже запускалась или прервана')
  expect(replace).toHaveBeenCalledTimes(1)
  expect(revert).not.toHaveBeenCalled()
  await expectReleased()
})


test('ошибка replacement освобождает lock через catch и сохраняет claim', async () => {
  const prepared = task()
  await writeTask(prepared)
  replace.mockRejectedValue(new Error('fixture replacement failure'))
  await main()
  expect(process.exitCode).toBe(1)
  expect((await readTask())?.status).toBe('manual_recovery')
  expect(await Bun.file(markerPath(prepared.id)).exists()).toBe(true)
  expect(start).not.toHaveBeenCalled()
  expect(revert).not.toHaveBeenCalled()
  await expectReleased()
})

test('отсутствующая и невалидная task освобождают lock без execution claim', async () => {
  await main()
  expect(process.exitCode).toBe(0)
  await expectReleased()
  await writeFile(join(root, '.update/update-task.json'), '{}')
  await main()
  expect(process.exitCode).toBe(1)
  await expectReleased()
  expect(wait).not.toHaveBeenCalled()
  expect((await readdir(join(root, '.update'))).some(name => name.startsWith('updater-claim-'))).toBe(false)
})

test('claim привязан к task id, не допускает traversal и не мешает новой task', async () => {
  const first = await acquireExecutionLock()
  await first.claim('../outside/arbitrary-id')
  await first.release()
  expect(await Bun.file(markerPath('../outside/arbitrary-id')).json()).toEqual({ taskId: '../outside/arbitrary-id' })
  expect(await readdir(outside)).toEqual([])
  const prepared = task('pending')
  prepared.id = 'a-new-task'
  await writeTask(prepared)
  await main()
  expect(process.exitCode).toBe(0)
  expect(replace).toHaveBeenCalledTimes(1)
  await expectReleased()
})

test('update directory symlink вне root отвергается до lock/claim writes', async () => {
  await symlink(outside, join(root, '.update'))
  await expect(acquireExecutionLock()).rejects.toThrow('Symlink вне проекта')
  expect(await readdir(outside)).toEqual([])
})
