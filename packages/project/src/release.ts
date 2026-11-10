/** Shared archive policy for publisher validation and the application installer. */
export interface ReleaseDescriptor {
  component: string
  version: string
  layout?: string
  preservePaths?: string[]
  postInstall?: { chmod?: string[] }
  platforms: object
}

export function releaseBinary(meta: ReleaseDescriptor, platform: string): string {
  if (!['linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-arm64', 'darwin-amd64'].includes(platform)) {
    throw new Error('Unsupported release platform')
  }
  if (!['app', 'service-manager'].includes(meta.component)) throw new Error('Unsupported release component')
  const info = (meta.platforms as Record<string, { binary?: unknown } | undefined>)[platform]
  if (!info || typeof info.binary !== 'string') throw new Error('Release binary is missing')
  const binary = info.binary
  const windows = platform === 'windows-amd64'
  if (meta.layout === undefined) {
    const expected = `${meta.component === 'app' ? 'app' : 'asm'}${windows ? '.exe' : ''}`
    if (binary !== expected) throw new Error('Неверный artifact contract')
  } else if (meta.layout === 'directory-v1' && meta.component === 'app') {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\.exe)?$/.test(binary)
      || binary.endsWith('.exe') !== windows) throw new Error('Unsafe directory executable name')
  } else throw new Error('Unsupported release layout')
  return binary
}

/** Validate all members before extracting anything into the staging directory. */
export function validateArchiveNames(meta: ReleaseDescriptor, platform: string, entries: Iterable<string>): string {
  const binary = releaseBinary(meta, platform)
  const names = [...entries]
  if (new Set(names).size !== names.length) throw new Error('Duplicate archive member')
  if (meta.layout === undefined) {
    const expected = meta.component === 'app' ? [binary, '.version'] : [binary]
    if (names.length !== expected.length || expected.some(name => !names.includes(name))) {
      throw new Error('Unexpected legacy archive members')
    }
    return binary
  }
  if (!names.includes(binary) || !names.includes('.version') || !names.includes('web/index.html')) {
    throw new Error('Incomplete directory release')
  }
  for (const name of names) {
    if (name === binary || name === '.version') continue
    if (!name.startsWith('web/') || name.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(name)
      || name.split('/').some(part => !part || part.startsWith('.') || /[. ]$/.test(part))) {
      throw new Error('Unsafe or unexpected directory archive member')
    }
  }
  return binary
}
