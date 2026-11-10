import { confinedPath } from '../../../../packages/project/src'
import { releaseBinary } from '../../../../packages/project/src/release'
import type { ComponentName, Platform, VersionMeta } from './types'

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export function validateVersion(version: string): void {
  if (typeof version !== 'string' || !semver.test(version)) throw new Error('Неверная версия релиза')
}
export function validateComponent(component: unknown): asserts component is ComponentName {
  if (component !== 'app' && component !== 'service-manager') throw new Error('Неизвестный компонент')
}
export function validateMeta(meta: VersionMeta, component: ComponentName, version: string, platform: Platform, rootDir: string): void {
  validateComponent(component); validateVersion(version)
  if (meta.component !== component || meta.version !== version) throw new Error('Метаданные не соответствуют запросу')
  const info = meta.platforms?.[platform]
  const binary = releaseBinary(meta, platform)
  if (!info || info.binary !== binary || info.archive !== `${platform}.tar.gz`
    || !/^[a-f0-9]{64}$/i.test(info.archiveSha256) || !info.binarySha256 || !/^[a-f0-9]{64}$/i.test(info.binarySha256)) throw new Error('Неверный artifact contract')
  if (meta.layout === 'directory-v1') {
    if (component !== 'app' || meta.minServiceManagerVersion !== '0.2.0' || JSON.stringify(meta.preservePaths) !== '[".env"]') throw new Error('Неверный directory contract')
  } else if (meta.layout !== undefined || JSON.stringify(meta.preservePaths) !== '[]') throw new Error('Неверный layout или preservePaths')
  if (meta.layout === 'directory-v1' && (!Number.isSafeInteger(info.archiveSize) || info.archiveSize <= 0 || !Number.isSafeInteger(info.extractedSize) || info.extractedSize <= 0)) throw new Error('Неверный размер artifact')
  const expected = platform.startsWith('windows-') ? undefined : { chmod: [binary] }
  if (JSON.stringify(meta.postInstall) !== JSON.stringify(expected)) throw new Error('Недопустимый postInstall')
  confinedPath(rootDir, component === 'app' ? 'app' : binary)
}
