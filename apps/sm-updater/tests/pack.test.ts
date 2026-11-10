import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { packArtifact, publishRelease, readPackedRelease, type PackArtifactOptions } from '../src/publish'
import type { Platform } from '../src/types'
import { validateMeta } from '../../service-manager/src/update/metadata'

let dir: string
let artifact: string
const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 255, 10, 42])
const platforms: Platform[] = ['linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-arm64', 'darwin-amd64']
const hash = (data: Uint8Array) => new Bun.CryptoHasher('sha256').update(data).digest('hex')
const options = (platform: Platform = 'linux-amd64'): PackArtifactOptions => ({
  component: 'app', artifact, version: '0.1.0-beta.1+fixture', platform, out: join(dir, 'release'),
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sm-pack-test-'))
  artifact = join(dir, 'input-executable')
  await writeFile(artifact, bytes)
  await chmod(artifact, 0o755)
  // These sibling files must not be included, regardless of their names.
  await writeFile(join(dir, '.env'), 'fixture-only=never-pack')
  await writeFile(join(dir, 'unrelated-data'), 'do not include')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('real offline archive fixtures', () => {
  for (const platform of platforms) {
    test(`app ${platform}: exact bytes, hashes, version and confined metadata`, async () => {
      const input = options(platform)
      const meta = await packArtifact(input)
      const binary = platform === 'windows-amd64' ? 'app.exe' : 'app'
      const archive = await readFile(join(input.out, `${platform}.tar.gz`))
      const members = await new Bun.Archive(archive).files()
      expect([...members.keys()].sort()).toEqual(['.version', binary].sort())
      expect(new Uint8Array(await members.get(binary)!.arrayBuffer())).toEqual(bytes)
      expect(await members.get('.version')!.text()).toBe(input.version + '\n')
      expect(Object.keys(meta.platforms)).toEqual([platform])
      expect(meta.platforms[platform]).toEqual({
        archive: `${platform}.tar.gz`, archiveSize: archive.length, archiveSha256: hash(archive),
        binarySha256: hash(bytes), extractedSize: bytes.length + new TextEncoder().encode(input.version + '\n').length,
        binary,
      })
      expect(meta.preservePaths).toEqual([])
      expect(meta.postInstall).toEqual(platform === 'windows-amd64' ? undefined : { chmod: [binary] })
      expect(await readdir(input.out)).toEqual(expect.arrayContaining(['meta.json', `${platform}.tar.gz`]))
      expect((await readPackedRelease(input.out)).meta).toEqual(meta)
    })
  }

  test('manager contains only its executable, not updater or application data', async () => {
    for (const platform of ['linux-arm64', 'windows-amd64'] as const) {
      const input = { ...options(platform), component: 'service-manager' as const, out: join(dir, platform) }
      await packArtifact(input)
      const { archive, meta } = await readPackedRelease(input.out)
      const members = await new Bun.Archive(archive).files()
      expect([...members.keys()]).toEqual([platform === 'windows-amd64' ? 'asm.exe' : 'asm'])
      validateMeta(meta, 'service-manager', input.version, platform, dir)
      const oldMeta = structuredClone(meta)
      oldMeta.platforms[platform]!.binary = platform === 'windows-amd64' ? 'service-manager.exe' : 'service-manager'
      expect(() => validateMeta(oldMeta, 'service-manager', input.version, platform, dir)).toThrow('artifact contract')
      await writeFile(join(input.out, 'meta.json'), JSON.stringify(oldMeta))
      await expect(readPackedRelease(input.out)).rejects.toThrow('Unsafe release metadata')
    }
  })
})

test('invalid identity and paths fail before output creation', async () => {
  const input = options()
  const invalid: Partial<PackArtifactOptions>[] = [
    { version: '../escape' }, { version: '01.2.3' }, { version: '1.2.3-01' }, { version: '1.2' },
    { version: '1.2.3/evil' }, { version: '1.2.3\n' }, { component: 'server' as never }, { platform: 'all' as never },
    { channel: '../nightly' as never }, { artifact: 'relative-file' }, { out: 'relative-dir' },
    { artifact: dir }, { artifact: join(dir, 'missing') },
  ]
  for (const override of invalid) {
    await expect(packArtifact({ ...input, ...override })).rejects.toThrow()
    expect(await Bun.file(join(input.out, 'meta.json')).exists()).toBe(false)
  }
  expect((await readdir(dir)).sort()).toEqual(['.env', 'input-executable', 'unrelated-data'])
})

test('an existing packed release is never partially overwritten', async () => {
  const input = options()
  await packArtifact(input)
  const beforeMeta = await readFile(join(input.out, 'meta.json'))
  const beforeArchive = await readFile(join(input.out, 'linux-amd64.tar.gz'))
  await writeFile(artifact, 'different bytes')
  await expect(packArtifact({ ...input, version: '9.9.9' })).rejects.toThrow()
  expect(await readFile(join(input.out, 'meta.json'))).toEqual(beforeMeta)
  expect(await readFile(join(input.out, 'linux-amd64.tar.gz'))).toEqual(beforeArchive)
})

test('symlink inputs and existing output links are rejected without modifying targets', async () => {
  const input = options()
  const link = join(dir, 'linked-artifact')
  await symlink(artifact, link)
  await expect(packArtifact({ ...input, artifact: link })).rejects.toThrow()
  await symlink(dir, input.out)
  await expect(packArtifact(input)).rejects.toThrow()
  expect(new Uint8Array(await readFile(artifact))).toEqual(bytes)
})

test('publisher rejects path traversal and corrupt bytes offline, before S3 loading', async () => {
  const input = options()
  const meta = await packArtifact(input)
  const metadataPath = join(input.out, 'meta.json')
  for (const bad of [
    { ...meta, preservePaths: ['../outside'] },
    { ...meta, postInstall: { chmod: ['../outside'] } },
    { ...meta, platforms: { 'linux-amd64': { ...meta.platforms['linux-amd64'], archive: '../input-executable' } } },
    { ...meta, platforms: { 'linux-amd64': { ...meta.platforms['linux-amd64'], binary: '../input-executable' } } },
    { ...meta, version: '../../outside' },
  ]) {
    await writeFile(metadataPath, JSON.stringify(bad))
    await expect(publishRelease(input.out)).rejects.toThrow()
  }
  await writeFile(metadataPath, JSON.stringify(meta))
  await writeFile(join(input.out, 'linux-amd64.tar.gz'), 'corrupt')
  await expect(publishRelease(input.out)).rejects.toThrow('Archive hash/size mismatch')
})

const cli = resolve(import.meta.dir, '../src/cli.ts')
async function command(args: string[]) {
  const child = Bun.spawn([process.execPath, '--no-env-file', cli, ...args], {
    cwd: dir, env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
  })
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { exit, stdout, stderr }
}

test('CLI help/version and invalid defaults have no runtime or environment side effects', async () => {
  const before = (await readdir(dir)).sort()
  for (const args of [['--help'], ['--version'], ['pack', '--help'], ['publish', '--help']]) {
    const result = await command(args)
    expect(result.exit).toBe(0)
    expect(result.stdout).toContain('asm-updater')
  }
  for (const args of [[], ['--bogus'], ['unexpected'], ['publish'], ['--root', 'relative'], ['--root', dir, '--bogus']]) {
    expect((await command(args)).exit).not.toBe(0)
  }
  expect((await readdir(dir)).sort()).toEqual(before)
})

test('CLI pack produces a verifiable archive and import does not execute main', async () => {
  const input = options('darwin-arm64')
  const result = await command(['pack', '--component', 'app', '--artifact', artifact, '--version', input.version,
    '--platform', input.platform, '--out', input.out])
  expect(result.exit).toBe(0)
  expect((await readPackedRelease(input.out)).meta.platforms['darwin-arm64']?.binary).toBe('app')
  const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', `await import(${JSON.stringify(cli)}); console.log('imported')`], {
    cwd: dir, env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stdout).text()).toBe('imported\n')
})
