import { expect, test, spyOn } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceManager } from '../src/manager'
import { BunService } from '../src/services/bun-service'
import { BaseService } from '../src/services/base'
import { createShutdown } from '../src/daemon/shutdown'
import { createLockManager } from '../src/daemon/lock'
import { cleanupOnShutdown, cleanupStaleResources } from '../src/daemon/cleanup'
import { getPlatformAdapter } from '../src/daemon/platform'
import { createDispatcher } from '../src/ipc/handlers/dispatcher'
import { createRequest } from '../src/ipc/protocol'
import { UpdateService } from '../src/update/service'
import { Supervisor } from '../src/daemon/supervisor'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sm-review-'))
  await mkdir(join(root, 'app'))
  await writeFile(join(root, 'sm.project.json'), JSON.stringify({ schemaVersion: 1, id: 'review', services: [
    { name: 'app', type: 'bun', cwd: 'app', executable: 'app', healthCheck: { type: 'http', url: 'http://unused', interval: 1 } },
    { name: 'proxy', type: 'docker-compose', cwd: '.', composeFile: 'compose.yaml', services: ['proxy'], dependsOn: ['app'] },
  ] }))
  return root
}

test('stop attempts remaining owned services and reports failure', async () => {
  const root = await fixture()
  const manager = new ServiceManager(root), calls: string[] = []
  const app = manager.getService('app')!, proxy = manager.getService('proxy')!
  const a = spyOn(app, 'stop').mockImplementation(async () => { calls.push('app') })
  const b = spyOn(proxy, 'stop').mockImplementation(async () => { calls.push('proxy'); throw new Error('stop proxy failed') })
  try {
    await expect(manager.stop()).rejects.toThrow('stop proxy failed')
    expect(calls).toEqual(['proxy', 'app'])
  } finally { a.mockRestore(); b.mockRestore(); await rm(root, { recursive: true, force: true }) }
})

test('shutdown cleans metadata before releasing lock; repeated signals share one run', async () => {
  const calls: string[] = []
  const run = createShutdown({
    stopMonitoring: () => { calls.push('monitor') },
    stopServices: async () => { calls.push('services') },
    stopIPC: async () => { calls.push('ipc') },
    closeLogger: async () => { calls.push('logger') },
    cleanup: async () => { calls.push('cleanup') },
    releaseLock: async () => { calls.push('release') },
  })
  await Promise.all([run(), run()])
  expect(calls).toEqual(['monitor', 'services', 'ipc', 'logger', 'cleanup', 'release'])
  const failedCalls: string[] = []
  const failed = createShutdown({
    stopMonitoring: () => {}, stopServices: async () => { throw new Error('owned stop uncertain') },
    stopIPC: async () => { failedCalls.push('ipc') }, closeLogger: async () => {}, cleanup: async () => {},
    releaseLock: async () => { failedCalls.push('release') },
  })
  await expect(failed()).rejects.toThrow('owned stop uncertain')
  expect(failedCalls).toEqual([])
})

test('shutdown metadata cleanup leaves lock; stale cleanup respects live lock without PID', async () => {
  const root = await fixture(), adapter = getPlatformAdapter()
  const lock = createLockManager(root)
  try {
    expect(await lock.acquireExclusive()).not.toBeNull()
    await lock.writeDaemonPid(process.pid)
    await cleanupOnShutdown(root)
    expect(await adapter.exists(join(root, '.pids/daemon.lock'))).toBe(true)
    expect((await cleanupStaleResources(root)).cleaned).toBe(false)
    const events: string[] = []
    const unlink = spyOn(adapter, 'unlink').mockImplementation(async (path) => { events.push(path.endsWith('daemon.pid') ? 'pid' : 'other') })
    const handle = (lock as any).lockHandle
    const release = spyOn(handle, 'release').mockImplementation(async () => { events.push('lock') })
    try { await lock.release(); expect(events).toEqual(['pid', 'lock']) }
    finally { unlink.mockRestore(); release.mockRestore(); await handle.release() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('healthy foreign endpoint cannot hide owned child exit during probe', async () => {
  const root = await fixture(), manager = new ServiceManager(root)
  const app = manager.getService('app') as BunService
  const child = { pid: 1, exitCode: null } as any
  ;(app as any).process = child
  ;(app as any)._state = { status: 'running', pid: 1 }
  const health = spyOn(BaseService.prototype as any, 'performHealthCheck').mockImplementation(async () => {
    child.exitCode = 1
    ;(app as any).process = null
    ;(app as any)._state = { status: 'stopped' }
    return true
  })
  const start = spyOn(app, 'start').mockResolvedValue()
  const dependent = spyOn(manager.getService('proxy')!, 'start').mockResolvedValue()
  try {
    await expect(manager.start(['proxy'])).rejects.toThrow('Health check')
    expect(dependent).not.toHaveBeenCalled()
    expect(await app.checkHealth()).toBe(false)
    expect(await app.waitForHealthy(2)).toBe(false)
  } finally { health.mockRestore(); start.mockRestore(); dependent.mockRestore(); await rm(root, { recursive: true, force: true }) }
})

test('paused app commit excludes restart and dependency start; prior mutation blocks update', async () => {
  const root = await fixture(), manager = new ServiceManager(root)
  const supervisor = new Supervisor({ manager })
  const dispatcher = createDispatcher({ manager, supervisor, shutdown: async () => {}, rootDir: root })
  let commitEntered!: () => void, finishCommit!: () => void
  const entered = new Promise<void>((resolve) => { commitEntered = resolve })
  const finish = new Promise<void>((resolve) => { finishCommit = resolve })
  const stage = spyOn(UpdateService.prototype, 'stageUpdate').mockResolvedValue({ success: true, staged: {} as any })
  const commit = spyOn(UpdateService.prototype, 'commitStaged').mockImplementation(async () => {
    commitEntered(); await finish
    return { success: true, component: 'app', oldVersion: '0.1.0', newVersion: '0.1.1' } as any
  })
  const discard = spyOn(UpdateService.prototype, 'discardStaged').mockResolvedValue()
  const stop = spyOn(manager, 'stopStrict').mockResolvedValue()
  const start = spyOn(manager, 'start').mockResolvedValue()
  const restart = spyOn(manager, 'restart').mockResolvedValue()
  const env = { ...process.env }
  Object.assign(process.env, { UPDATE_S3_ENDPOINT: 'http://unused', UPDATE_S3_BUCKET: 'fixture', UPDATE_S3_ACCESS_KEY_ID: 'fixture', UPDATE_S3_SECRET_ACCESS_KEY: 'fixture' })
  try {
    const update = dispatcher.dispatch(createRequest('update.install', { components: ['app'] }))
    await entered
    expect(supervisor.isPending('app')).toBe(true)
    for (const [method, names] of [['restart', ['app']], ['start', ['proxy']], ['stop', ['app']]] as const) {
      const result = await dispatcher.dispatch(createRequest(method, { services: [...names] }))
      expect('error' in result).toBe(true)
    }
    expect(restart).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
    finishCommit(); expect('result' in await update).toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
    // A hold remains authoritative even outside an active update call.
    supervisor.beginPending(['app'])
    expect('error' in await dispatcher.dispatch(createRequest('start', { services: ['proxy'] }))).toBe(true)
    supervisor.endPending(['app'])
    let unlock!: () => void
    const active = manager.withLifecycle(() => new Promise<void>((resolve) => { unlock = resolve }))
    expect('error' in await dispatcher.dispatch(createRequest('update.install', { components: ['app'] }))).toBe(true)
    expect(stage).toHaveBeenCalledTimes(1)
    unlock(); await active
  } finally {
    stage.mockRestore(); commit.mockRestore(); discard.mockRestore(); stop.mockRestore(); start.mockRestore(); restart.mockRestore()
    for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name]
    Object.assign(process.env, env)
    await rm(root, { recursive: true, force: true })
  }
})
