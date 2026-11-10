import { confinedPath } from './index'

export function validSelfUpdateTask(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const t = value as any
  const statuses = ['pending', 'in_progress', 'completed', 'failed', 'rolled_back', 'manual_recovery']
  if (t.schemaVersion !== 2 || typeof t.id !== 'string' || !t.id || typeof t.rootDir !== 'string'
    || !Array.isArray(t.components) || t.components.length !== 1 || !statuses.includes(t.status)
    || !validIdentity(t.daemon, t.rootDir)
    || typeof t.handoff?.requested !== 'boolean' || typeof t.handoff?.acknowledged !== 'boolean'
    || !['required', 'restarting', 'completed', 'failed'].includes(t.postUpdateApps?.status)
    || t.healthCheck?.enabled !== true || t.healthCheck?.endpoint !== 'ipc'
    || !Number.isFinite(t.healthCheck?.timeout) || t.healthCheck.timeout <= 0
    || typeof t.rollbackOnFailure !== 'boolean') return false
  const c = t.components[0]
  const binary = c?.targetPath
  if (!c || c.name !== 'service-manager' || !['asm', 'asm.exe'].includes(binary)
    || c.sourcePath !== `.update/${binary}.new` || c.backupPath !== `.update/${binary}.old`
    || !/^[a-f0-9]{64}$/i.test(c.sha256) || typeof c.targetVersion !== 'string' || typeof c.currentVersion !== 'string') return false
  if (t.replacement && (!Number.isInteger(t.replacement.pid) || t.replacement.pid <= 0
    || typeof t.replacement.gate !== 'string' || t.replacement.gate.length < 16
    || (t.replacement.identity && (!validIdentity(t.replacement.identity, t.rootDir) || t.replacement.identity.pid !== t.replacement.pid)))) return false
  return true
}
function validIdentity(v: any, rootDir: string): boolean {
  return v && Number.isInteger(v.pid) && v.pid > 0 && typeof v.instanceId === 'string' && v.instanceId.length >= 16
    && v.rootDir === rootDir && typeof v.version === 'string' && v.version.length > 0
}
export function validateTaskPaths(task: { rootDir: string; components: { sourcePath: string; targetPath: string; backupPath: string }[] }, rootDir: string): void {
  if (!validSelfUpdateTask(task) || task.rootDir !== rootDir) throw new Error('Некорректная self-update task/root')
  for (const c of task.components) for (const rel of [c.sourcePath, c.targetPath, c.backupPath]) confinedPath(rootDir, rel)
}
