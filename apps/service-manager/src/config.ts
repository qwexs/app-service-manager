import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { BunServiceConfig, DockerComposeServiceConfig } from './types'
import { canonicalRoot, confinedPath, projectIdentity, checkPinnedIdentity, type ProjectIdentity } from '../../../packages/project/src'

export type ManagedServiceConfig = BunServiceConfig | DockerComposeServiceConfig
export interface ProjectConfig extends ProjectIdentity { schemaVersion: 1; services: ManagedServiceConfig[] }

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)
}

export function parseProject(value: unknown, rootDir: string): ProjectConfig {
  if (!value || typeof value !== 'object') throw new Error('Manifest должен быть объектом')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || typeof input.id !== 'string' || !Array.isArray(input.services) || !input.services.length) {
    throw new Error('Нужны schemaVersion: 1, id и непустой services')
  }
  const identity = projectIdentity(rootDir, input.id)
  checkPinnedIdentity(identity)
  for (const runtimePath of ['.pids', '.sock', '.logs', '.update', '.sm-identity.json']) confinedPath(identity.rootDir, runtimePath)
  const names = new Set<string>()
  const services: ManagedServiceConfig[] = input.services.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Невалидный service')
    const s = item as Record<string, unknown>
    if (typeof s.name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(s.name)
      || ['all', 'apps', 'infrastructure', 'daemon'].includes(s.name) || names.has(s.name)) throw new Error('Невалидное или повторное имя сервиса')
    names.add(s.name)
    if (typeof s.cwd !== 'string') throw new Error(`${s.name}: нужен cwd`)
    confinedPath(identity.rootDir, s.cwd)
    if (s.dependsOn !== undefined && !strings(s.dependsOn)) throw new Error(`${s.name}: неверный dependsOn`)
    if (s.port !== undefined && (!Number.isInteger(s.port) || Number(s.port) < 1 || Number(s.port) > 65535)) throw new Error(`${s.name}: неверный port`)
    if (s.healthCheck !== undefined) {
      const h = s.healthCheck as Record<string, unknown>
      if (!h || typeof h !== 'object' || !['http', 'tcp', 'command'].includes(String(h.type))) throw new Error('Неверный healthCheck')
      if (h.type === 'http' && (typeof h.url !== 'string' || !/^https?:\/\//.test(h.url))) throw new Error('Нужен HTTP URL')
      if (h.type === 'tcp' && (typeof h.host !== 'string' || !h.host || !Number.isInteger(h.port) || Number(h.port) < 1 || Number(h.port) > 65535)) throw new Error('Нужен TCP port')
      if (h.type === 'command' && (!strings(h.command) || !h.command.length)) throw new Error('Нужна command')
      for (const field of ['interval', 'timeout', 'retries', 'initialDelay']) {
        if (h[field] !== undefined && (!Number.isInteger(h[field]) || Number(h[field]) < 0)) throw new Error(`Неверный healthCheck.${field}`)
      }
    }
    if (s.type === 'bun') {
      if (typeof s.executable !== 'string' || !s.executable.length || (s.args !== undefined && !strings(s.args))) throw new Error(`${s.name}: неверный executable/args`)
      confinedPath(identity.rootDir, s.executable)
      const executable = process.platform === 'win32' && !s.executable.endsWith('.exe') ? `${s.executable}.exe` : s.executable
      confinedPath(identity.rootDir, `${s.cwd}/${executable}`)
      if (s.name === 'app' && (s.cwd !== 'app' || !['app', 'app.exe'].includes(executable))) throw new Error('Обновляемый app должен быть app/app[.exe]')
      return { ...s, executable } as unknown as BunServiceConfig
    }
    if (s.type === 'docker-compose') {
      if (typeof s.composeFile !== 'string' || !s.composeFile.length || !strings(s.services) || !s.services.length
        || s.services.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))) throw new Error(`${s.name}: нужны composeFile и services`)
      confinedPath(identity.rootDir, s.composeFile)
      confinedPath(identity.rootDir, `${s.cwd}/${s.composeFile}`)
      if (s.name === 'app') throw new Error('app должен быть Bun executable')
      return s as unknown as DockerComposeServiceConfig
    }
    throw new Error(`${s.name}: неподдерживаемый type`)
  })
  const project: ProjectConfig = { ...identity, schemaVersion: 1, services }
  startOrder(project, services.map((s) => s.name))
  return project
}

export function loadProject(rootDir: string): ProjectConfig {
  const root = canonicalRoot(rootDir)
  return parseProject(JSON.parse(readFileSync(confinedPath(root, 'sm.project.json'), 'utf8')), root)
}

export function selectServices(project: ProjectConfig, names: string[] = ['all']): string[] {
  const groups: Record<string, string[]> = {
    all: project.services.map((s) => s.name),
    apps: project.services.filter((s) => s.type === 'bun').map((s) => s.name),
    infrastructure: project.services.filter((s) => s.type === 'docker-compose').map((s) => s.name),
  }
  const selected = [...new Set(names.flatMap((name) => groups[name] ?? [name]))]
  for (const name of selected) if (!project.services.some((s) => s.name === name)) throw new Error(`Неизвестный сервис: ${name}`)
  return selected
}

export function startOrder(project: Pick<ProjectConfig, 'services'>, selected: string[]): string[] {
  const configs = new Map(project.services.map((s) => [s.name, s]))
  const active = new Set<string>(), done = new Set<string>(), result: string[] = []
  const visit = (name: string) => {
    if (active.has(name)) throw new Error(`Цикл зависимостей: ${name}`)
    const config = configs.get(name)
    if (!config) throw new Error(`Неизвестная зависимость: ${name}`)
    if (done.has(name)) return
    active.add(name)
    for (const dep of config.dependsOn ?? []) visit(dep)
    active.delete(name); done.add(name); result.push(name)
  }
  selected.forEach(visit)
  return result
}
