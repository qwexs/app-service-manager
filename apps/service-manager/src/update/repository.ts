// UpdateRepository — S3-хранилище обновлений через нативный Bun.S3Client
// https://bun.com/docs/runtime/s3.md

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import type { S3Config } from './config'
import { compareVersions } from './types'
import type { Manifest, ChannelInfo, VersionMeta, LatestInfo, Platform, ComponentName, UpdateChannel } from './types'

export class RepositoryError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'NETWORK' | 'PARSE' | 'CHECKSUM' | 'UNKNOWN',
    public readonly cause?: Error,
  ) {
    super(message)
    this.name = 'RepositoryError'
  }
}

interface S3ListResult {
  files: Array<{
    key: string
    size: number
    lastModified: string
  }>
  isTruncated: boolean
  continuationToken?: string
}

export class UpdateRepository {
  private readonly client: Bun.S3Client

  constructor(config: S3Config) {
    this.client = new Bun.S3Client({
      endpoint: config.endpoint.replace(/\/$/, ''),
      bucket: config.bucket,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    })
  }

  async getManifest(): Promise<Manifest> {
    return this.readJSON<Manifest>('manifest.json')
  }

  async getChannel(channel: UpdateChannel): Promise<ChannelInfo> {
    return this.readJSON<ChannelInfo>(`channels/${channel}.json`)
  }

  async getLatest(component: ComponentName): Promise<LatestInfo> {
    return this.readJSON<LatestInfo>(`${component}/latest.json`)
  }

  async getVersionMeta(component: ComponentName, version: string): Promise<VersionMeta> {
    return this.readJSON<VersionMeta>(`${component}/${version}/meta.json`)
  }

  async listVersions(component: ComponentName): Promise<string[]> {
    const result = await this.list(`${component}/`)

    const versions = new Set<string>()
    for (const file of result.files) {
      const match = file.key.match(new RegExp(`^${component}/([^/]+)/meta\\.json$`))
      if (match) {
        versions.add(match[1])
      }
    }

    return Array.from(versions).sort((a, b) => compareVersions(b, a))
  }

  async downloadArchive(
    component: ComponentName,
    version: string,
    platform: Platform,
    destPath: string,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<{ path: string; sha256: string }> {
    const meta = await this.getVersionMeta(component, version)
    const platformInfo = meta.platforms[platform]

    if (!platformInfo) {
      throw new RepositoryError(`Платформа ${platform} не поддерживается для ${component} v${version}`, 'NOT_FOUND')
    }

    const key = `${component}/${version}/${platformInfo.archive}`
    const totalSize = platformInfo.archiveSize
    await mkdir(path.dirname(destPath), { recursive: true })
    await rm(destPath, { force: true }).catch(() => undefined)
    return this.downloadToFile(key, destPath, totalSize, onProgress)
  }

  async verifyChecksum(data: Uint8Array, expectedSha256: string): Promise<boolean> {
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(data)
    const actual = hasher.digest('hex')
    return actual.toLowerCase() === expectedSha256.toLowerCase()
  }

  private file(key: string) {
    return this.client.file(key)
  }

  private async readJSON<T>(key: string): Promise<T> {
    try {
      return (await this.file(key).json()) as T
    } catch (error) {
      throw this.mapError(error, key)
    }
  }

  private async downloadToFile(
    key: string,
    destPath: string,
    totalSize: number,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<{ path: string; sha256: string }> {
    const chunkSize = 1024 * 1024
    const hasher = new Bun.CryptoHasher('sha256')
    const writer = Bun.file(destPath).writer()
    const s3file = this.file(key)
    let downloaded = 0

    try {
      if (totalSize > 0) {
        while (downloaded < totalSize) {
          const end = Math.min(downloaded + chunkSize, totalSize)
          const buffer = await s3file.slice(downloaded, end).bytes()
          if (buffer.byteLength === 0) {
            break
          }
          hasher.update(buffer)
          writer.write(buffer)
          await writer.flush()
          downloaded += buffer.byteLength
          onProgress?.(downloaded, totalSize)
        }
      } else {
        const buffer = await s3file.bytes()
        hasher.update(buffer)
        writer.write(buffer)
        await writer.flush()
        downloaded = buffer.byteLength
        onProgress?.(downloaded, downloaded)
      }
      await writer.end()
    } catch (error) {
      try {
        await writer.end()
      } catch {
        // файл мог остаться частичным — вызывающий удалит dest
      }
      throw this.mapError(error, key)
    }

    return { path: destPath, sha256: hasher.digest('hex') }
  }

  private async list(prefix: string): Promise<S3ListResult> {
    const files: S3ListResult['files'] = []
    let startAfter: string | undefined

    try {
      for (;;) {
        const page = await this.client.list({
          prefix,
          maxKeys: 1000,
          startAfter,
        })

        for (const obj of page.contents ?? []) {
          if (!obj.key) continue
          files.push({
            key: obj.key,
            size: obj.size ?? 0,
            lastModified: obj.lastModified ? new Date(obj.lastModified).toISOString() : '',
          })
        }

        if (!page.isTruncated || !page.contents?.length) {
          break
        }
        startAfter = page.contents.at(-1)?.key
        if (!startAfter) break
      }
    } catch (error) {
      throw this.mapError(error, prefix)
    }

    return { files, isTruncated: false }
  }

  private mapError(error: unknown, key: string): RepositoryError {
    if (error instanceof RepositoryError) {
      return error
    }

    const err = error as { code?: string; name?: string; message?: string }
    const message = err.message ?? String(error)

    if (
      err.code === 'NoSuchKey' ||
      err.code === 'NotFound' ||
      err.code === 'ERR_S3_INVALID_PATH' ||
      /no such key|not found|404/i.test(message)
    ) {
      return new RepositoryError(`Файл не найден: ${key}`, 'NOT_FOUND', error instanceof Error ? error : undefined)
    }

    if (err.name === 'SyntaxError' || /json|parse/i.test(message)) {
      return new RepositoryError(`Не удалось распарсить JSON: ${key}`, 'PARSE', error instanceof Error ? error : undefined)
    }

    if (/network|econn|enotfound|fetch|timeout/i.test(message)) {
      return new RepositoryError(`Сетевая ошибка при запросе ${key}`, 'NETWORK', error instanceof Error ? error : undefined)
    }

    return new RepositoryError(`Ошибка S3 (${key}): ${message}`, 'UNKNOWN', error instanceof Error ? error : undefined)
  }
}

export function createUpdateRepository(config: S3Config): UpdateRepository {
  return new UpdateRepository(config)
}
