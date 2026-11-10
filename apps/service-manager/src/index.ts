#!/usr/bin/env bun
import { APP_VERSION } from './version'
import { loadProject, selectServices } from './config'

const HELP = `App Service Manager ${APP_VERSION}
asm --root /absolute/project <command>
  config validate              Validate sm.project.json without starting services
  daemon start|stop            Start daemon / request cooperative shutdown
  start|stop|restart [names]    Service names or groups: apps, infrastructure, all
  status                       Show service state through IPC
  logs [name]                  Show recent log lines
  update check|app|self         S3: check / update app / prepare self-update
  update rollback              Roll back app files
--help, --version              No manifest, daemon or network required
`

export interface CLIArgs { root?: string; words: string[]; internal: string[]; help: boolean; version: boolean }
export function parseArgs(args: string[]): CLIArgs {
  const result: CLIArgs = { words: [], internal: [], help: args.includes('--help') || args.includes('-h'), version: args.includes('--version') }
  if (result.help || result.version) return result
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--root') {
      if (result.root || !args[i + 1] || args[i + 1]!.startsWith('-')) throw new Error('Нужен один --root <absolute-project-root>')
      result.root = args[++i]
    } else if (arg === '--daemon-mode') result.internal.push(arg)
    else if (arg === '--update-task' || arg === '--update-gate') {
      if (!args[i + 1] || args[i + 1]!.startsWith('-')) throw new Error(`Нет значения ${arg}`)
      result.internal.push(arg, args[++i]!)
    } else if (arg.startsWith('-')) throw new Error(`Неизвестный флаг: ${arg}`)
    else result.words.push(arg)
  }
  return result
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv)
  if (parsed.help || argv.length === 0) { console.log(HELP); return }
  if (parsed.version) { console.log(APP_VERSION); return }
  if (!parsed.root) throw new Error('Требуется --root <absolute-project-root>')
  const project = loadProject(parsed.root)
  const rootDir = project.rootDir
  const [command, sub, ...rest] = parsed.words
  if (command === 'config' && sub === 'validate' && rest.length === 0 && !parsed.internal.length) {
    console.log(JSON.stringify({ valid: true, id: project.id, rootDir, namespace: project.namespace, services: project.services.map((s) => s.name) }, null, 2)); return
  }
  if (parsed.internal.includes('--daemon-mode') && parsed.words.length === 0) {
    const { runDaemon } = await import('./daemon/runner')
    await runDaemon({ rootDir }); return
  }
  if (parsed.internal.length) throw new Error('Внутренние флаги допустимы только в daemon mode')
  if (command === 'daemon' && ['start', 'stop'].includes(sub ?? '') && rest.length === 0) {
    const { startDaemon, stopDaemon } = await import('./daemon/daemonize')
    const result = sub === 'start' ? await startDaemon({ rootDir }) : await stopDaemon({ rootDir })
    if (!result.success) throw new Error(result.message)
    console.log(result.message); return
  }
  if (!['start', 'stop', 'restart', 'status', 'logs', 'update'].includes(command ?? '')) throw new Error('Неизвестная команда. Используйте --help')
  const names = ['start', 'stop', 'restart'].includes(command!)
    ? selectServices(project, parsed.words.slice(1).length ? parsed.words.slice(1) : undefined) : undefined
  if (command === 'status' && parsed.words.length !== 1) throw new Error('status не принимает аргументы')
  if (command === 'logs' && (rest.length || (sub && !project.services.some((s) => s.name === sub)))) throw new Error('logs [service]')
  if (command === 'update' && (!['check', 'app', 'self', 'rollback'].includes(sub ?? '') || rest.length)) throw new Error('update check|app|self|rollback')
  const { createDaemonClient } = await import('./ipc/client')
  const client = createDaemonClient({ rootDir })
  try {
    await client.connect()
    if (command === 'start' || command === 'stop' || command === 'restart') {
      const result = await client[command](names)
      console.log(JSON.stringify(result, null, 2))
      if (!result.success) throw new Error('Операция сервиса не завершена; проверьте logs')
    } else if (command === 'status') console.log(JSON.stringify(await client.status(), null, 2))
    else if (command === 'logs') console.log(JSON.stringify(await client.logs(sub), null, 2))
    else if (command === 'update') {
      if (sub === 'check') console.log(JSON.stringify(await client.call('update.check', {}), null, 2))
      else if (sub === 'app') {
        const result = await client.call('update.install', { components: ['app'] })
        console.log(JSON.stringify(result, null, 2))
        if (!result.success) throw new Error('Обновление не завершено; проверьте logs')
      } else if (sub === 'rollback') {
        const result = await client.call('update.rollback', { component: 'app' })
        console.log(JSON.stringify(result, null, 2))
        if (!result.success) throw new Error(result.error ?? 'Откат не завершён')
      } else {
        const status = await client.status()
        const { initiateSelfUpdate, launchSelfUpdater } = await import('./update/self-update')
        const { parseUpdateConfig } = await import('./update/config')
        const result = await initiateSelfUpdate({ rootDir, config: parseUpdateConfig(), daemon: {
          pid: status.daemon.pid, instanceId: status.daemon.instanceId!, rootDir, version: status.daemon.version,
        } })
        if (!result.success || !result.taskId) throw new Error(result.error ?? 'Self-update не подготовлен')
        const accepted = await client.call('update.handoff', { taskId: result.taskId, instanceId: status.daemon.instanceId! })
        if (!accepted.accepted) throw new Error('Handoff не подтверждён; updater не запущен')
        await launchSelfUpdater(rootDir)
        console.log(`Self-update task: ${result.taskId}; результат в .update/update-task.json`)
      }
    }
  } finally { await client.disconnect() }
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
