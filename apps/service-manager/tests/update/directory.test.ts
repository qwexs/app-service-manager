import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateService } from '../../src/update/service'
import { computeSha256 } from '../../src/update/archive'
import { getPlatform } from '../../src/update/types'
import { parseProject } from '../../src/config'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'asm-directory-update-'))
  await mkdir(join(root, 'app', 'web'), { recursive: true })
  await writeFile(join(root, 'app', 'server'), 'old')
  await writeFile(join(root, 'app', '.version'), '1.0.0\n')
  await writeFile(join(root, 'app', '.env'), 'SECRET=old')
  await writeFile(join(root, 'app', 'web', 'index.html'), 'old')
  await writeFile(join(root, 'app', 'web', 'stale.js'), 'stale')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function fixture(extra: Record<string, string> = {}) {
  const platform = getPlatform()
  const binary = platform.startsWith('windows-') ? 'server.exe' : 'server'
  const members: Record<string, string> = { [binary]: 'new', '.version': '2.0.0\n', 'web/index.html': 'new web', ...extra }
  const archive = await new Bun.Archive(members, { compress: 'gzip' }).bytes()
  const info = { binary, archive: `${platform}.tar.gz`, archiveSize: archive.length, extractedSize: Object.values(members).reduce((n, v) => n + Buffer.byteLength(v), 0), archiveSha256: computeSha256(archive), binarySha256: computeSha256(new TextEncoder().encode('new')) }
  const meta = { component: 'app', version: '2.0.0', channel: 'stable', layout: 'directory-v1', minServiceManagerVersion: '0.2.0', preservePaths: ['.env'], platforms: { [platform]: info }, postInstall: platform.startsWith('windows-') ? undefined : { chmod: [binary] } }
  const updater = new UpdateService({ rootDir: root, config: { channel: 'stable', checkInterval: 0, s3: { endpoint: 'http://localhost', region: 'local', bucket: 'test', accessKeyId: 'test', secretAccessKey: 'test' } }, currentVersions: { 'service-manager': '0.2.0' } })
  ;(updater as any).repo = { getVersionMeta: async () => meta, downloadArchive: async (_c: string, _v: string, _p: string, dest: string) => { await mkdir(join(dest, '..'), { recursive: true }); await writeFile(dest, archive); return { sha256: computeSha256(archive), path: dest } } }
  return { updater, binary }
}

test('directory swap preserves current config, removes stale assets, and rollback keeps later edits', async () => {
  const { updater, binary } = await fixture()
  if (binary !== 'server') await writeFile(join(root, 'app', binary), 'old')
  const staged = await updater.stageUpdate('app', '2.0.0')
  expect(staged.success).toBe(true)
  if (!staged.success) return
  await writeFile(join(root, 'app', '.env'), 'SECRET=after-staging')
  await updater.commitStaged(staged.staged)
  expect(await readFile(join(root, 'app', '.env'), 'utf8')).toBe('SECRET=after-staging')
  expect((await stat(join(root, 'app', '.env'))).mode & 0o777).toBe(0o600)
  expect(await Bun.file(join(root, 'app', 'web', 'stale.js')).exists()).toBe(false)
  await writeFile(join(root, 'app', '.env'), 'SECRET=after-update')
  expect((await updater.rollback('app', binary)).success).toBe(true)
  expect(await readFile(join(root, 'app', '.env'), 'utf8')).toBe('SECRET=after-update')
  expect(await readFile(join(root, 'app', binary), 'utf8')).toBe('old')
  expect(await readFile(join(root, 'app', 'web', 'stale.js'), 'utf8')).toBe('stale')
})

test('incoming config and wrong marker are rejected before installation', async () => {
  for (const extra of [{ '.env': 'incoming' }, { '.version': 'wrong' }] as Record<string, string>[]) {
    const { updater } = await fixture(extra)
    expect((await updater.stageUpdate('app', '2.0.0')).success).toBe(false)
    expect(await readFile(join(root, 'app', 'server'), 'utf8')).toBe('old')
  }
})

test('symlinked config fails closed and leaves live directory untouched', async () => {
  const { updater } = await fixture()
  const staged = await updater.stageUpdate('app', '2.0.0')
  if (!staged.success) throw new Error(staged.result.error)
  await rm(join(root, 'app', '.env'))
  await symlink(join(root, 'app', 'server'), join(root, 'app', '.env'))
  await expect(updater.commitStaged(staged.staged)).rejects.toThrow()
  expect(await readFile(join(root, 'app', 'server'), 'utf8')).toBe('old')
  await updater.discardStaged(staged.staged)
})

test('manifest permits a flat custom app executable and rejects traversal', () => {
  const manifest = (executable: string) => ({ schemaVersion: 1, id: 'test', services: [{ name: 'app', type: 'bun', cwd: 'app', executable }] })
  expect(parseProject(manifest('server'), root).services[0]!.name).toBe('app')
  expect(() => parseProject(manifest('../server'), root)).toThrow()
})

test('invalid rollback backup leaves the installed application intact', async () => {
  const { updater, binary } = await fixture()
  if (binary !== 'server') await writeFile(join(root, 'app', binary), 'old')
  const staged = await updater.stageUpdate('app', '2.0.0')
  if (!staged.success) throw new Error(staged.result.error)
  await updater.commitStaged(staged.staged)
  await rm(join(root, '.app-backup', 'web', 'index.html'))
  expect((await updater.rollback('app', binary)).success).toBe(false)
  expect(await readFile(join(root, 'app', binary), 'utf8')).toBe('new')
  expect(await readFile(join(root, 'app', '.env'), 'utf8')).toBe('SECRET=old')
})
