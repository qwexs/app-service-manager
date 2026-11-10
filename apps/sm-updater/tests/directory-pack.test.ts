import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { packDirectory, readPackedRelease, type PackDirectoryOptions } from '../src/publish'

let dir: string
let source: string
const input = (): PackDirectoryOptions => ({ component: 'app', directory: source, executable: 'server', version: '1.2.3-beta.1+build', platform: 'linux-amd64', out: join(dir, 'release') })
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asm-directory-pack-'))
  source = join(dir, 'dist')
  await mkdir(join(source, 'web', 'assets'), { recursive: true })
  await writeFile(join(source, 'server'), 'compiled fixture')
  await writeFile(join(source, 'web', 'index.html'), '<html>fixture</html>')
  await writeFile(join(source, 'web', 'assets', 'app.js'), 'fixture()')
  await writeFile(join(source, '.env'), 'SECRET=never-read-or-pack')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('directory release has exact layout and deterministic archive bytes, omitting environment bytes', async () => {
  const meta = await packDirectory(input())
  const { archive } = await readPackedRelease(input().out)
  expect(meta.layout).toBe('directory-v1')
  expect(meta.minServiceManagerVersion).toBe('0.2.0')
  expect(meta.preservePaths).toEqual(['.env'])
  expect(meta.postInstall).toEqual({ chmod: ['server'] })
  const files = await new Bun.Archive(archive).files()
  expect([...files.keys()].sort()).toEqual(['.version', 'server', 'web/assets/app.js', 'web/index.html'])
  expect(await files.get('.version')!.text()).toBe(input().version + '\n')
  await writeFile(join(source, '.env'), 'CHANGED=still-not-packed')
  await packDirectory({ ...input(), out: join(dir, 'second') })
  expect(new Uint8Array(await readFile(join(dir, 'second', 'linux-amd64.tar.gz')))).toEqual(new Uint8Array(archive))
})

test('directory source rejects extras, links, missing web index, invalid identity and unsafe executable', async () => {
  for (const override of [{ executable: '../server' }, { executable: '.env' }, { component: 'service-manager' as const }, { version: '1.2.3-01' }, { directory: 'relative' }]) {
    await expect(packDirectory({ ...input(), ...override })).rejects.toThrow()
  }
  await writeFile(join(source, 'config.json'), '{}')
  await expect(packDirectory(input())).rejects.toThrow('Unsupported source entry')
  await rm(join(source, 'config.json'))
  await symlink(join(source, 'server'), join(source, 'web', 'linked'))
  await expect(packDirectory(input())).rejects.toThrow('regular source entry')
  await rm(join(source, 'web', 'linked'))
  await rm(join(source, '.env'))
  await symlink(join(source, 'server'), join(source, '.env'))
  await expect(packDirectory(input())).rejects.toThrow('regular source entry')
  await rm(join(source, '.env'))
  await rm(join(source, 'web', 'index.html'))
  await expect(packDirectory(input())).rejects.toThrow()
})

test('unsupported extended tar paths fail before output creation', async () => {
  await writeFile(join(source, 'web', 'x'.repeat(120)), 'long-name fixture')
  await expect(packDirectory(input())).rejects.toThrow()
  expect(await Bun.file(join(input().out, 'meta.json')).exists()).toBe(false)
})

test('reader rejects tampered metadata, archive hashes, marker and incoming env even with updated hashes', async () => {
  const meta = await packDirectory(input())
  const metadata = join(input().out, 'meta.json')
  for (const patch of [{ preservePaths: [] }, { minServiceManagerVersion: '0.1.0' }, { layout: 'unknown' }, { postInstall: { chmod: ['web/index.html'] } }]) {
    await writeFile(metadata, JSON.stringify({ ...meta, ...patch }))
    await expect(readPackedRelease(input().out)).rejects.toThrow()
  }
  const variants: Record<string, string>[] = [
    { server: 'compiled fixture', '.version': 'wrong\n', 'web/index.html': 'fixture' },
    { server: 'compiled fixture', '.version': input().version + '\n', 'web/index.html': 'fixture', '.env': 'SECRET=incoming' },
  ]
  for (const members of variants) {
    const archive = await new Bun.Archive(members, { compress: 'gzip' }).bytes()
    const changed = structuredClone(meta)
    changed.platforms['linux-amd64']!.archiveSize = archive.length
    changed.platforms['linux-amd64']!.archiveSha256 = new Bun.CryptoHasher('sha256').update(archive).digest('hex')
    await writeFile(metadata, JSON.stringify(changed))
    await writeFile(join(input().out, 'linux-amd64.tar.gz'), archive)
    await expect(readPackedRelease(input().out)).rejects.toThrow()
  }
})

test('CLI enforces alternatives and packs Windows directory binary', async () => {
  const cli = resolve(import.meta.dir, '../src/cli.ts')
  const common = ['pack', '--component', 'app', '--version', '1.2.3', '--platform', 'windows-amd64', '--out', input().out]
  const command = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, '--no-env-file', cli, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    return child.exited
  }
  for (const args of [[], ['--directory', source], ['--artifact', join(source, 'server'), '--directory', source, '--executable', 'server'], ['--artifact', join(source, 'server'), '--executable', 'server']]) {
    expect(await command([...common, ...args])).not.toBe(0)
  }
  await rm(join(source, 'server'))
  await writeFile(join(source, 'server.exe'), 'windows fixture')
  expect(await command([...common, '--directory', source, '--executable', 'server.exe'])).toBe(0)
  const { meta } = await readPackedRelease(input().out)
  expect(meta.platforms['windows-amd64']?.binary).toBe('server.exe')
  expect(meta.postInstall).toBeUndefined()
})
