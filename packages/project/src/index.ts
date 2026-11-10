import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export interface ProjectIdentity { rootDir: string; id: string; namespace: string }

export function canonicalRoot(rootDir: string): string {
  if (!path.isAbsolute(rootDir)) throw new Error('--root должен быть абсолютным путём')
  return realpathSync(rootDir)
}

export function projectIdentity(rootDir: string, id: string): ProjectIdentity {
  const canonical = canonicalRoot(rootDir)
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error('id: нужны 1–32 строчных символа a-z, 0-9, -')
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12)
  return { rootDir: canonical, id, namespace: `${id}-${hash}` }
}

export function readIdentity(rootDir: string): ProjectIdentity {
  const canonical = canonicalRoot(rootDir)
  const value = JSON.parse(readFileSync(confinedPath(canonical, 'sm.project.json'), 'utf8'))
  const identity = projectIdentity(canonical, value.id)
  checkPinnedIdentity(identity)
  return identity
}

export function socketPath(rootDir: string, platform = process.platform): string {
  const identity = readIdentity(rootDir)
  return platform === 'win32'
    ? `\\\\.\\pipe\\sm-${identity.namespace}`
    : confinedPath(identity.rootDir, '.sock/service-manager.sock')
}

// Проверяем существующих предков: отсутствие файла не разрешает выход через symlink.
export function confinedPath(rootDir: string, relative: string): string {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0')
    || path.posix.isAbsolute(relative) || /^[a-z]:/i.test(relative)
    || relative.split('/').includes('..')) throw new Error(`Путь вне проекта: ${relative}`)
  const root = canonicalRoot(rootDir)
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Путь вне проекта: ${relative}`)
  let parent = resolved
  while (true) {
    try {
      const entry = lstatSync(parent)
      // Bun/macOS realpath не поддерживает Unix socket; его родитель проверяется
      // так же, как предок ещё не созданного файла. Symlink здесь не пропускается.
      if (entry.isSocket()) parent = path.dirname(parent)
      break
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; parent = path.dirname(parent) }
  }
  const real = realpathSync(parent)
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`Symlink вне проекта: ${relative}`)
  return resolved
}

export function checkPinnedIdentity(identity: ProjectIdentity): void {
  const file = confinedPath(identity.rootDir, '.sm-identity.json')
  if (!existsSync(file)) return
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  if (saved.rootDir !== identity.rootDir || saved.id !== identity.id || saved.namespace !== identity.namespace) throw new Error('Runtime root/id изменён; требуется ручная проверка ресурсов')
}
