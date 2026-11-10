import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalRoot, confinedPath, projectIdentity, socketPath } from '../../../packages/project/src'
import { parseProject, loadProject, selectServices, startOrder } from '../src/config'
import { parseArgs, main } from '../src/index'
import { ServiceManager } from '../src/manager'
import { BunService } from '../src/services/bun-service'
import { DockerComposeService } from '../src/services/docker-compose-service'
import { parseUpdateTask } from '../src/update/task-store'
import { validateTaskPaths } from '../../../packages/project/src/task'
import { validateMeta } from '../src/update/metadata'
import { preserveFiles, restoreFiles, extractTarGzToDir } from '../src/update/archive'
import { packArtifact } from '../../sm-updater/src/publish'
import { UpdateService } from '../src/update/service'
import { getPlatform } from '../src/update/types'

let root: string, outside: string
const manifest = () => ({ schemaVersion: 1, id: 'fixture', services: [
  { name: 'app', type: 'bun', cwd: 'app', executable: 'app' },
  { name: 'caddy', type: 'docker-compose', cwd: '.', composeFile: 'compose.yaml', services: ['caddy'], dependsOn: ['app'] },
] })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sm-invariant-'))
  outside = await mkdtemp(join(tmpdir(), 'sm-outside-'))
  await mkdir(join(root, 'app'))
  await writeFile(join(root, 'sm.project.json'), JSON.stringify(manifest()))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })

test('root/id isolates namespaces and Windows pipes; symlink root canonicalizes', async () => {
  await writeFile(join(outside, 'sm.project.json'), JSON.stringify(manifest()))
  const a = projectIdentity(root, 'fixture'), b = projectIdentity(outside, 'fixture')
  expect(a.namespace).not.toBe(b.namespace)
  expect(socketPath(root, 'win32')).toBe(`\\\\.\\pipe\\sm-${a.namespace}`)
  expect(socketPath(root, 'win32')).not.toBe(socketPath(outside, 'win32'))
  await symlink(root, join(outside, 'alias'))
  expect(projectIdentity(join(outside, 'alias'), 'fixture')).toEqual(a)
  expect(() => canonicalRoot('relative')).toThrow()
  await writeFile(join(root, '.sm-identity.json'), JSON.stringify(a))
  expect(() => parseProject({ ...manifest(), id: 'changed' }, root)).toThrow('Runtime root/id')
})

test('manifest groups/dependencies fail closed; no filesystem writes on parsing', async () => {
  const before = await readdir(root)
  const project = loadProject(root)
  expect(selectServices(project, ['apps'])).toEqual(['app'])
  expect(selectServices(project, ['infrastructure'])).toEqual(['caddy'])
  expect(startOrder(project, ['caddy'])).toEqual(['app', 'caddy'])
  expect(() => selectServices(project, ['missing'])).toThrow()
  const bad = manifest(); bad.services[0]!.dependsOn = ['caddy']
  expect(() => parseProject(bad, root)).toThrow('Цикл')
  const missing = manifest(); missing.services[1]!.dependsOn = ['missing']
  expect(() => parseProject(missing, root)).toThrow('Неизвестная зависимость')
  const absolute = manifest(); absolute.services[0]!.executable = '/outside'
  expect(() => parseProject(absolute, root)).toThrow()
  expect(await readdir(root)).toEqual(before)
})

test('traversal, symlink and dangling symlink escapes rejected at file seams', async () => {
  await symlink(outside, join(root, 'escape'))
  await symlink(join(outside, 'missing'), join(root, 'dangling'))
  for (const value of ['../x', '/tmp/x', 'C:/x', 'x\\y', 'escape/x', 'dangling/x']) expect(() => confinedPath(root, value)).toThrow()
  await expect(preserveFiles(root, ['escape/secret'])).rejects.toThrow()
  await expect(restoreFiles(root, new Map([['escape/secret', new Uint8Array([1])]]))).rejects.toThrow()
  const archive = await new Bun.Archive({ 'escape/secret': new Uint8Array([1]) }).bytes()
  await expect(extractTarGzToDir(archive, root)).rejects.toThrow()
  expect(await readdir(outside)).toEqual([])
})

test('help/version precede root, config command does not spawn, root flags are not services', async () => {
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('spawn forbidden') })
  const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(() => { throw new Error('network forbidden') }, { preconnect: fetch.preconnect }))
  const connect = spyOn(Bun, 'connect').mockImplementation(() => { throw new Error('IPC forbidden') })
  const before = await readdir(root)
  try {
    expect(parseArgs(['start', '--root', root, 'apps']).words).toEqual(['start', 'apps'])
    await main(['--help']); await main(['--version']); await main(['config', 'validate', '--root', root])
    await expect(main(['start'])).rejects.toThrow('Требуется --root')
    expect(spawn).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual(before)
  } finally { spawn.mockRestore(); network.mockRestore(); connect.mockRestore() }
})

test('unowned PID cannot be signalled or adopted, and cannot spawn replacement', async () => {
  await mkdir(join(root, '.pids'))
  await writeFile(join(root, '.pids/app.pid'), String(process.pid))
  const manager = new ServiceManager(root)
  const app = manager.getService('app') as BunService
  const kill = spyOn(process, 'kill').mockImplementation(() => { throw new Error('signal forbidden') })
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('spawn forbidden') })
  try {
    await expect(app.start()).rejects.toThrow('неподтверждённый PID')
    await expect(app.stop()).rejects.toThrow('не принадлежит')
    await expect(manager.stopStrict(['app'])).rejects.toThrow()
    expect(kill).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  } finally { kill.mockRestore(); spawn.mockRestore() }
})

test('dependency health failure prevents dependent start, stop error propagates', async () => {
  const manager = new ServiceManager(root), calls: string[] = []
  const app = manager.getService('app')!, caddy = manager.getService('caddy')!
  const startApp = spyOn(app, 'start').mockImplementation(async () => { calls.push('app') })
  const healthy = spyOn(app, 'waitForHealthy').mockResolvedValue(false)
  const startCaddy = spyOn(caddy, 'start').mockImplementation(async () => { calls.push('caddy') })
  const stopApp = spyOn(app, 'stop').mockRejectedValue(new Error('cannot stop'))
  try {
    await expect(manager.start(['caddy'])).rejects.toThrow('Health check')
    expect(calls).toEqual(['app'])
    await expect(manager.stopStrict(['app'])).rejects.toThrow('cannot stop')
  } finally { startApp.mockRestore(); healthy.mockRestore(); startCaddy.mockRestore(); stopApp.mockRestore() }
})

test('Compose argv stays within explicit namespace and named services; partial/error not stopped', async () => {
  const config = loadProject(root)
  const service = new DockerComposeService(config.services[1] as any, root, config.namespace)
  const calls: string[][] = []
  let bad = false, partial = false
  const spawn = spyOn(Bun, 'spawn').mockImplementation(((args: string[]) => {
    calls.push(args)
    const status = args.includes('ps')
    const output = status ? JSON.stringify({ Service: 'caddy', State: partial ? 'exited' : 'running' }) : ''
    return { stdout: new Response(output).body, stderr: new Response(bad ? 'fixture failure' : '').body, exited: Promise.resolve(bad ? 1 : 0) } as any
  }) as any)
  try {
    await service.start(); await service.stop()
    expect(calls.every((argv) => argv.includes('--project-name') && argv.includes(config.namespace) && argv.includes('caddy'))).toBe(true)
    expect(calls.flat()).not.toContain('down')
    bad = true
    await expect(service.stop()).rejects.toThrow('Docker Compose ps')
    bad = false; partial = true
    await service.refreshStatus(); expect(service.getStatus()).toBe('stopped')
  } finally { spawn.mockRestore() }
})

test('self-update task fixed paths/component/root and hash are checked', async () => {
  const task: any = { schemaVersion: 2, id: 'fixture', rootDir: root,
    components: [{ name: 'service-manager', sourcePath: '.update/asm.new', targetPath: 'asm', backupPath: '.update/asm.old', sha256: 'a'.repeat(64), currentVersion: '0.1.0', targetVersion: '0.1.1' }],
    daemon: { pid: 42, instanceId: 'fixture-instance-123', rootDir: root, version: '0.1.0' },
    handoff: { requested: true, acknowledged: false }, postUpdateApps: { status: 'required' }, status: 'pending',
    healthCheck: { enabled: true, endpoint: 'ipc', timeout: 30000 }, rollbackOnFailure: true }
  expect(parseUpdateTask(task)).not.toBeNull(); validateTaskPaths(task, root)
  for (const field of ['sourcePath', 'targetPath', 'backupPath']) {
    const bad = structuredClone(task); bad.components[0][field] = '../escape'
    expect(parseUpdateTask(bad)).toBeNull()
  }
  const bad = structuredClone(task); bad.components[0].name = 'app'
  expect(parseUpdateTask(bad)).toBeNull()
  await symlink(outside, join(root, '.update'))
  expect(() => validateTaskPaths(task, root)).toThrow()
})

test('offline producer is consumed by confined app staging/commit/rollback with no network', async () => {
  const artifact = join(outside, 'executable'); await writeFile(artifact, 'new fixture executable')
  await writeFile(join(root, 'app/app'), 'old fixture executable')
  const platform = getPlatform()
  const out = join(outside, 'release')
  const meta = await packArtifact({ component: 'app', artifact, version: '0.1.1', platform, out })
  validateMeta(meta, 'app', '0.1.1', platform, root)
  expect(() => validateMeta({ ...meta, preservePaths: ['../x'] }, 'app', '0.1.1', platform, root)).toThrow()
  const updater = new UpdateService({ rootDir: root, config: { channel: 'stable', checkInterval: 0, s3: { endpoint: 'http://invalid', bucket: 'fixture', accessKeyId: 'fixture', secretAccessKey: 'fixture', region: 'fixture' } }, currentVersions: { app: '0.1.0' } })
  const repo = (updater as any).repo
  repo.getVersionMeta = async () => meta
  repo.downloadArchive = async (_c: string, _v: string, _p: string, dest: string) => {
    await Bun.write(dest, await Bun.file(join(out, `${platform}.tar.gz`)).bytes())
    return { sha256: meta.platforms[platform]!.archiveSha256 }
  }
  const staged = await updater.stageUpdate('app', '0.1.1')
  expect(staged.success).toBe(true)
  if (!staged.success) throw new Error(staged.result.error)
  expect(await Bun.file(join(root, 'app/app')).text()).toBe('old fixture executable')
  await updater.commitStaged(staged.staged)
  expect(await Bun.file(join(root, 'app/app')).text()).toBe('new fixture executable')
  expect(await Bun.file(join(root, 'app/.version')).text()).toBe('0.1.1\n')
  expect((await updater.rollback('app')).success).toBe(true)
  expect(await Bun.file(join(root, 'app/app')).text()).toBe('old fixture executable')
})
