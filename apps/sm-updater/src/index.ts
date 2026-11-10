#!/usr/bin/env bun
// asm-updater — автономный бинарник для self-update service-manager
// Выполняет:
// 1. Ожидание завершения daemon
// 2. Замену файлов
// 3. Запуск нового daemon
// 4. Health check
// 5. Откат при ошибке

import { readTask, writeTask, getRootDir } from './task'
import { waitForProcessExit, startDaemon } from './process'
import { replaceFiles } from './files'
import { performHealthCheck } from './health'
import { performRollback } from './rollback'
import { acquireExecutionLock, type ExecutionLock } from './execution'
import { logInfo, logWarn, logError } from './log'

async function waitForAppsRestart(taskId: string, timeout: number): Promise<Awaited<ReturnType<typeof readTask>>> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const current = await readTask()
    if (!current || current.id !== taskId) return null
    if (current.postUpdateApps.status === 'completed') return current
    if (current.postUpdateApps.status === 'failed') return null
    await Bun.sleep(200)
  }
  return null
}

/**
 * Основная логика asm-updater
 */
export async function main(): Promise<void> {
  const execution = await acquireExecutionLock()
  try {
    process.exitCode = await runTask(execution)
  } finally {
    await execution.release()
  }
}

async function runTask(execution: ExecutionLock): Promise<number> {
  await logInfo('═══════════════════════════════════════════════════════')
  await logInfo('asm-updater запущен')
  await logInfo(`Корневая директория: ${getRootDir()}`)
  await logInfo('═══════════════════════════════════════════════════════')

  // Читаем задание. Существующая legacy/битая task — ошибка, не no-op.
  let task
  try {
    task = await readTask()
  } catch (error) {
    await logError(error instanceof Error ? error.message : String(error))
    return 1
  }

  if (!task) {
    await logWarn('Файл update-task.json не найден, выход')
    return 0
  }

  if (task.rootDir !== getRootDir() || !task.handoff.acknowledged || !['pending', 'in_progress'].includes(task.status)) {
    await logError('Задача не подтверждена daemon или имеет несовместимый root/status; ручное восстановление')
    return 1
  }

  await logInfo(`ID задания: ${task.id}`)
  await logInfo(`Компоненты для обновления: ${task.components.map((c) => c.name).join(', ')}`)

  // Handoff уже мог установить in_progress. Только постоянный claim отличает
  // первый запуск от повторного; отказ не должен попадать в catch с rollback.
  await execution.claim(task.id)

  // Устанавливаем статус in_progress
  task.status = 'in_progress'
  await writeTask(task)

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 1: Ожидание завершения daemon
    // ─────────────────────────────────────────────────────────────────────────
    await logInfo('')
    await logInfo('Шаг 1/5: Ожидание завершения daemon...')
    await logInfo(`PID daemon: ${task.daemon.pid}`)

    const exited = await waitForProcessExit(task.daemon.pid, 30000)
    if (!exited) {
      // Handoff обязан завершить daemon самостоятельно и освободить ресурсы.
      // Никакого fallback signal: PID без live IPC identity нельзя доверять.
      throw new Error('Daemon не завершился после подтверждённого handoff; ручное восстановление')
    }
    await logInfo('Task-owned daemon завершился и сам освободил IPC/lock')

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 2: Замена файлов
    // ─────────────────────────────────────────────────────────────────────────
    await logInfo('')
    await logInfo('Шаг 2/5: Замена файлов...')

    const replaceResult = await replaceFiles(task)

    if (!replaceResult.success) {
      throw new Error(`Ошибка замены файлов: ${replaceResult.error}`)
    }

    await logInfo('Файлы успешно заменены')

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 3: Запуск нового daemon
    // ─────────────────────────────────────────────────────────────────────────
    await logInfo('')
    await logInfo('Шаг 3/5: Запуск нового daemon...')

    const startResult = await startDaemon(task)

    if (!startResult.success) {
      throw new Error(`Ошибка запуска daemon: ${startResult.error}`)
    }

    await writeTask(task)
    await logInfo(`Daemon запущен (PID: ${startResult.pid})`)

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 4: Health check
    // ─────────────────────────────────────────────────────────────────────────
    await logInfo('')
    await logInfo('Шаг 4/5: Health check...')

    {
      const targetVersion = task.components[0]?.targetVersion || '0.0.0'
      const healthy = await performHealthCheck(targetVersion, task.healthCheck.timeout, task)

      if (!healthy) {
        const current = await readTask()
        if (!current || current.id !== task.id) {
          throw new Error('Health check не подтвердил daemon, а task больше не принадлежит updater')
        }
        if (current.rollbackOnFailure) {
          await logError('Health check провален, выполняем откат...')
          await performRollback(current, 'Health check failed')
        } else {
          await logError('Health check провален, но откат отключён; требуется ручное восстановление')
          current.status = 'manual_recovery'
          current.error = 'Health check failed (rollback disabled)'
          delete current.completedAt
          await writeTask(current)
        }
        return 1
      }

      await logInfo('Health check пройден')
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Шаг 5: Завершение
    // ─────────────────────────────────────────────────────────────────────────
    await logInfo('')
    await logInfo('Шаг 5/5: Завершение...')

    const finalTask = await waitForAppsRestart(task.id, task.healthCheck.timeout)
    if (!finalTask) throw new Error('Приложения не подтвердили restart после self-update')
    finalTask.status = 'completed'
    finalTask.completedAt = new Date().toISOString()
    await writeTask(finalTask)
    task.status = finalTask.status
    task.completedAt = finalTask.completedAt

    await logInfo('')
    await logInfo('═══════════════════════════════════════════════════════')
    await logInfo('Обновление успешно завершено!')
    await logInfo('═══════════════════════════════════════════════════════')

    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logError('')
    await logError('═══════════════════════════════════════════════════════')
    await logError(`ОШИБКА: ${message}`)
    await logError('═══════════════════════════════════════════════════════')

    // Сначала используем свежую identity для cooperative rollback. Terminal
    // status записывается только после исхода rollback, иначе handoff нового
    // daemon уже невозможно безопасно подтвердить.
    const latest = await readTask()
    if (latest && latest.id === task.id && latest.status === 'in_progress'
      && latest.replacement?.identity && latest.rollbackOnFailure) {
      await logWarn('Выполняем откат...')
      const rollbackResult = await performRollback(latest, message)
      if (rollbackResult.success) await logInfo('Откат выполнен успешно')
      else await logError(`Откат не удался: ${rollbackResult.error}`)
    } else if (latest && latest.id === task.id) {
      latest.status = 'manual_recovery'
      latest.error = `Автовосстановление заблокировано: нет подтверждённой replacement identity (${message})`
      delete latest.completedAt
      await writeTask(latest)
    }

    return 1
  }
}

// Запуск
if (import.meta.main) main().catch(async (err) => {
  await logError(`Критическая ошибка: ${err}`)
  process.exitCode = 1
})
