// Offline packaging accepts ready-built executables or the explicit directory release layout.
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { computeSha256 } from './archive'
import { releaseBinary, validateArchiveNames } from '../../../packages/project/src/release'
import type { ComponentName, Platform, UpdateChannel, VersionMeta, S3Config, LatestInfo, Manifest, ChannelInfo } from './types'

const platforms: Platform[] = ['linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-arm64', 'darwin-amd64']
const channels: UpdateChannel[] = ['stable', 'beta', 'nightly']
const components: ComponentName[] = ['app', 'service-manager']
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export interface PackArtifactOptions {
  component: ComponentName
  artifact: string
  version: string
  platform: Platform
  out: string
  channel?: UpdateChannel
  changelog?: string
}

export interface PackDirectoryOptions extends Omit<PackArtifactOptions, 'artifact'> {
  directory: string
  executable: string
}

export async function packDirectory(options: PackDirectoryOptions): Promise<VersionMeta> {
  const { component, version, platform, changelog } = options
  const channel = options.channel ?? 'stable'
  validateIdentity(component, version, platform, channel)
  if (component !== 'app') throw new Error('Directory releases support only the app component')
  const directory = absolutePath(options.directory, 'Directory')
  const out = absolutePath(options.out, 'Output')
  if (!(await lstat(directory)).isDirectory()) throw new Error('Directory must be a directory, not a symlink')
  const meta: VersionMeta = {
    component, version, channel, releasedAt: new Date().toISOString(), layout: 'directory-v1',
    minServiceManagerVersion: '0.2.0', preservePaths: ['.env'],
    ...(changelog === undefined ? {} : { changelog }),
    platforms: { [platform]: { binary: options.executable } as VersionMeta['platforms'][Platform] },
    ...(platform === 'windows-amd64' ? {} : { postInstall: { chmod: [options.executable] } }),
  }
  const binary = releaseBinary(meta, platform)
  const members: Record<string, Uint8Array> = {}
  async function visit(relative: string): Promise<void> {
    const path = join(directory, relative)
    const stat = await lstat(path)
    if (stat.isDirectory()) {
      if (relative !== 'web' && !relative.startsWith('web/')) throw new Error(`Unsupported source entry: ${relative}`)
      for (const name of (await readdir(path)).sort()) await visit(`${relative}/${name}`)
    } else if (stat.isFile()) {
      if (relative === '.env') return // Inspect the entry type, never its bytes.
      if (relative !== binary && !relative.startsWith('web/')) throw new Error(`Unsupported source entry: ${relative}`)
      members[relative] = await readFile(path)
    } else throw new Error(`Expected a regular source entry: ${relative}`)
  }
  for (const name of (await readdir(directory)).sort()) await visit(name)
  members['.version'] = new TextEncoder().encode(`${version}\n`)
  validateArchiveNames(meta, platform, Object.keys(members))
  if (!members[binary]?.length) throw new Error('Artifact must not be empty')
  const archive = await new Bun.Archive(members, { compress: 'gzip' }).bytes()
  const { readDirectoryArchive } = await import('../../service-manager/src/update/archive')
  const entries = await readDirectoryArchive(archive)
  validateArchiveNames(meta, platform, entries.map((entry) => entry.name))
  meta.platforms[platform] = {
    archive: `${platform}.tar.gz`, archiveSize: archive.length,
    archiveSha256: computeSha256(archive), binarySha256: computeSha256(members[binary]!),
    extractedSize: Object.values(members).reduce((sum, data) => sum + data.length, 0), binary,
  }
  await mkdir(out)
  try {
    await writeFile(join(out, `${platform}.tar.gz`), archive, { flag: 'wx' })
    await writeFile(join(out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    await rm(out, { recursive: true, force: true })
    throw error
  }
  return meta
}

function validateIdentity(component: unknown, version: unknown, platform: unknown, channel: unknown): void {
  if (!components.includes(component as ComponentName)) throw new Error('Unsupported component')
  if (typeof version !== 'string' || version.trim() !== version || !semver.test(version)) throw new Error('Version must be valid SemVer')
  if (!platforms.includes(platform as Platform)) throw new Error('Unsupported platform')
  if (!channels.includes(channel as UpdateChannel)) throw new Error('Unsupported channel')
}

function absolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute path`)
  }
  return resolve(value)
}

function binaryName(component: ComponentName, platform: Platform): string {
  return `${component === 'service-manager' ? 'asm' : 'app'}${platform === 'windows-amd64' ? '.exe' : ''}`
}

async function regularFile(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular file: ${path}`)
  return readFile(path)
}

export async function packArtifact(options: PackArtifactOptions): Promise<VersionMeta> {
  const { component, version, platform, changelog } = options
  const channel = options.channel ?? 'stable'
  validateIdentity(component, version, platform, channel)
  const artifact = absolutePath(options.artifact, 'Artifact')
  const out = absolutePath(options.out, 'Output')
  const binary = binaryName(component, platform)
  const bytes = await regularFile(artifact)
  if (bytes.length === 0) throw new Error('Artifact must not be empty')
  const members: Record<string, Uint8Array> = { [binary]: bytes }
  if (component === 'app') members['.version'] = new TextEncoder().encode(`${version}\n`)
  const archive = await new Bun.Archive(members, { compress: 'gzip' }).bytes()
  const meta: VersionMeta = {
    component, version, channel, releasedAt: new Date().toISOString(),
    ...(changelog === undefined ? {} : { changelog }),
    platforms: {
      [platform]: {
        archive: `${platform}.tar.gz`, archiveSize: archive.length,
        archiveSha256: computeSha256(archive), binarySha256: computeSha256(bytes),
        extractedSize: Object.values(members).reduce((sum, data) => sum + data.length, 0), binary,
      },
    },
    preservePaths: [],
    ...(platform === 'windows-amd64' ? {} : { postInstall: { chmod: [binary] } }),
  }
  // Exclusive creation rejects existing files, directories and symlinks. Only
  // this invocation's new directory is removed if a write fails.
  await mkdir(out)
  try {
    await writeFile(join(out, `${platform}.tar.gz`), archive, { flag: 'wx' })
    await writeFile(join(out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    await rm(out, { recursive: true, force: true })
    throw error
  }
  return meta
}

export function getS3Config(): S3Config {
  const endpoint = process.env.UPDATE_S3_ENDPOINT
  const bucket = process.env.UPDATE_S3_BUCKET
  const accessKeyId = process.env.UPDATE_S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.UPDATE_S3_SECRET_ACCESS_KEY
  const region = process.env.UPDATE_S3_REGION || 'us-east-1'
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('Set UPDATE_S3_ENDPOINT, UPDATE_S3_BUCKET, UPDATE_S3_ACCESS_KEY_ID and UPDATE_S3_SECRET_ACCESS_KEY')
  }
  return { endpoint, bucket, accessKeyId, secretAccessKey, region }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unexpected release metadata field')
}

// Validate local content before loading credentials or the optional S3 dependency.
export async function readPackedRelease(release: string): Promise<{ meta: VersionMeta; archive: Buffer; platform: Platform }> {
  const dir = absolutePath(release, 'Release')
  if (!(await lstat(dir)).isDirectory()) throw new Error('Release must be a directory, not a symlink')
  const value: unknown = JSON.parse((await regularFile(join(dir, 'meta.json'))).toString())
  if (!record(value) || !record(value.platforms)) throw new Error('Invalid release metadata')
  onlyKeys(value, ['component', 'version', 'channel', 'releasedAt', 'changelog', 'platforms', 'preservePaths', 'postInstall', 'layout', 'minServiceManagerVersion'])
  const entries = Object.entries(value.platforms)
  if (entries.length !== 1) throw new Error('Packed release must contain exactly one platform')
  const [platform, info] = entries[0]!
  validateIdentity(value.component, value.version, platform, value.channel)
  if (!record(info)) throw new Error('Invalid platform metadata')
  onlyKeys(info, ['archive', 'archiveSize', 'archiveSha256', 'binarySha256', 'extractedSize', 'binary'])
  let binary: string
  try { binary = releaseBinary(value as unknown as VersionMeta, platform as Platform) }
  catch { throw new Error('Unsafe release metadata') }
  const directoryLayout = value.layout === 'directory-v1'
  if (info.archive !== `${platform}.tar.gz` || info.binary !== binary
    || JSON.stringify(value.preservePaths) !== JSON.stringify(directoryLayout ? ['.env'] : [])
    || (directoryLayout ? value.minServiceManagerVersion !== '0.2.0' : value.minServiceManagerVersion !== undefined)
    || (value.changelog !== undefined && typeof value.changelog !== 'string')
    || typeof value.releasedAt !== 'string' || !Number.isFinite(Date.parse(value.releasedAt))) {
    throw new Error('Unsafe release metadata')
  }
  const expectedPostInstall = platform === 'windows-amd64' ? undefined : { chmod: [binary] }
  if (JSON.stringify(value.postInstall) !== JSON.stringify(expectedPostInstall)) throw new Error('Unsafe postInstall paths')
  const names = (await readdir(dir)).sort()
  if (JSON.stringify(names) !== JSON.stringify(['meta.json', `${platform}.tar.gz`].sort())) {
    throw new Error('Unexpected files in packed release')
  }
  const archive = await regularFile(join(dir, info.archive as string))
  if (info.archiveSize !== archive.length || info.archiveSha256 !== computeSha256(archive)) throw new Error('Archive hash/size mismatch')
  if (directoryLayout) {
    // Bun's file map can normalize or omit non-file tar records. Inspect the
    // original records before trusting that map.
    const { readDirectoryArchive } = await import('../../service-manager/src/update/archive')
    const entries = await readDirectoryArchive(archive)
    validateArchiveNames(value as unknown as VersionMeta, platform as Platform, entries.map((entry) => entry.name))
  }
  const files = await new Bun.Archive(archive).files()
  validateArchiveNames(value as unknown as VersionMeta, platform as Platform, files.keys())
  const binaryBytes = new Uint8Array(await files.get(binary)!.arrayBuffer())
  if (!binaryBytes.length || info.binarySha256 !== computeSha256(binaryBytes)) throw new Error('Binary hash mismatch')
  const extractedSize = [...files.values()].reduce((sum, file) => sum + file.size, 0)
  if (value.component === 'app') {
    const marker = files.get('.version')!
    if (await marker.text() !== `${value.version}\n`) throw new Error('Version marker mismatch')
  }
  if (info.extractedSize !== extractedSize) throw new Error('Extracted size mismatch')
  return { meta: value as unknown as VersionMeta, archive, platform: platform as Platform }
}

export async function publishRelease(release: string): Promise<void> {
  const { meta, archive, platform } = await readPackedRelease(release)
  const config = getS3Config()
  const { S3Client } = await import('@sm/s3-client')
  const s3 = new S3Client(config)
  const base = `${meta.component}/${meta.version}`
  // list() propagates transport errors; exists() in the shared client does not.
  // Immutable preflight assumes one publisher per version, not concurrent writers.
  const existing = await s3.list({ prefix: `${base}/`, maxKeys: 1 })
  if (existing.files.length || existing.isTruncated) throw new Error('Release already exists; use a new version')
  async function readOptional<T>(key: string): Promise<T | undefined> {
    const listed = await s3.list({ prefix: key })
    if (!listed.files.some((file) => file.key === key)) return undefined
    return s3.readAsJSON<T>(key)
  }
  const manifest = await readOptional<Manifest>('manifest.json') ?? {
    schemaVersion: 1, generatedAt: meta.releasedAt, components: {}, defaultChannel: 'stable',
  }
  const channelKey = `channels/${meta.channel}.json`
  const channel = await readOptional<ChannelInfo>(channelKey) ?? {
    channel: meta.channel, updatedAt: meta.releasedAt, components: {},
  }
  if (manifest.schemaVersion !== 1 || !record(manifest.components) || !channels.includes(manifest.defaultChannel)
    || Object.keys(manifest.components).some((name) => !components.includes(name as ComponentName))
    || channel.channel !== meta.channel || !record(channel.components)
    || Object.keys(channel.components).some((name) => !components.includes(name as ComponentName))) {
    throw new Error('Incompatible remote manifest/channel')
  }
  async function writeJSON(key: string, value: unknown, overwrite: boolean): Promise<void> {
    const result = await s3.writeJSON(key, value, { overwrite })
    if (!result.success) throw new Error(`Upload failed: ${key}: ${result.error}`)
  }
  const archiveResult = await s3.writeFile({ key: `${base}/${platform}.tar.gz`, data: archive, contentType: 'application/gzip' }, { overwrite: false })
  if (!archiveResult.success) throw new Error(`Archive upload failed: ${archiveResult.error}`)
  await writeJSON(`${base}/meta.json`, meta, false)
  const latest: LatestInfo = { version: meta.version, channel: meta.channel, releasedAt: meta.releasedAt, metaPath: `${base}/meta.json` }
  await writeJSON(`${meta.component}/latest.json`, latest, true)
  channel.updatedAt = meta.releasedAt
  channel.components[meta.component] = meta.version
  await writeJSON(channelKey, channel, true)
  manifest.generatedAt = meta.releasedAt
  manifest.components[meta.component] = { name: meta.component, description: meta.component, latestVersion: meta.version, latestPath: base }
  await writeJSON('manifest.json', manifest, true)
}
