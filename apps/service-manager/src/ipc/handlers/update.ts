import path from 'node:path'
import type { RequestContext } from './dispatcher'
import type { UpdateCheckParams, UpdateCheckResult, UpdateInstallParams, UpdateInstallResult, UpdateRollbackParams, UpdateRollbackResult, UpdateStatusResult } from '../protocol'
import { UpdateService } from '../../update/service'
import { parseUpdateConfig } from '../../update/config'
import { APP_VERSION } from '../../version'
import { validateComponent } from '../../update/metadata'

let inProgress = false
async function service(rootDir: string) {
  const file = Bun.file(path.join(rootDir, 'app', '.version'))
  const app = await file.exists() ? (await file.text()).trim() : '0.0.0'
  return new UpdateService({ rootDir, config: parseUpdateConfig(), currentVersions: { app, 'service-manager': APP_VERSION } })
}

export async function handleUpdateCheck(params: UpdateCheckParams | undefined, context: RequestContext): Promise<UpdateCheckResult> {
  for (const component of params?.components ?? []) validateComponent(component)
  return { updates: await (await service(context.rootDir)).checkUpdates(params?.components ?? ['app', 'service-manager']) }
}

// Файлы заменяются только после подтверждённого stop; при неопределённости app остаётся остановлен.
export async function handleUpdateInstall(params: UpdateInstallParams | undefined, context: RequestContext): Promise<UpdateInstallResult> {
  if (params?.components && (params.components.length !== 1 || params.components[0] !== 'app')) throw new Error('Installer поддерживает только app; self-update — отдельная команда')
  if (!context.manager.getService('app')) throw new Error('В manifest нет обновляемого app')
  if (inProgress) throw new Error('Операция обновления уже выполняется')
  inProgress = true
  const { manager, supervisor } = context
  const updater = await service(context.rootDir).catch((error) => { inProgress = false; throw error })
  let staged: Awaited<ReturnType<UpdateService['stageUpdate']>> | undefined
  let committed = false
  try {
    staged = await updater.stageUpdate('app', params?.version)
    if (!staged.success) return { success: false, requiresRestart: false, components: [{ name: 'app', status: 'failed', error: staged.result.error }] }
    supervisor?.beginPending(['app'])
    await manager.stopStrict(['app'])
    const result = await updater.commitStaged(staged.staged)
    committed = true
    await manager.start(['app'])
    supervisor?.adoptService('app')
    return { success: true, requiresRestart: false, components: [{ name: 'app', status: 'updated', oldVersion: result.oldVersion, newVersion: result.newVersion }] }
  } catch (error) {
    // Не возобновляем мониторинг потенциально частично установленного app.
    await supervisor?.stopService('app').catch(() => undefined)
    return { success: false, requiresRestart: false, components: [{ name: 'app', status: 'failed', error: `${committed ? 'Файлы установлены, restart не подтверждён' : 'Обновление прервано'}: ${error}` }] }
  } finally {
    if (staged?.success) await updater.discardStaged(staged.staged)
    supervisor?.endPending(['app'])
    inProgress = false
  }
}

export async function handleUpdateRollback(params: UpdateRollbackParams, context: RequestContext): Promise<UpdateRollbackResult> {
  if (params?.component !== 'app') throw new Error('Rollback поддерживает только app')
  if (inProgress) throw new Error('Операция обновления уже выполняется')
  inProgress = true
  const { manager, supervisor } = context
  try {
    supervisor?.beginPending(['app'])
    const updater = await service(context.rootDir)
    await manager.stopStrict(['app'])
    const result = await updater.rollback('app')
    if (!result.success) throw new Error(result.error)
    await manager.start(['app'])
    supervisor?.adoptService('app')
    return { success: true, component: 'app' }
  } catch (error) {
    await supervisor?.stopService('app').catch(() => undefined)
    return { success: false, component: 'app', error: String(error) }
  } finally { supervisor?.endPending(['app']); inProgress = false }
}
export function handleUpdateStatus(): UpdateStatusResult { return { inProgress } }
