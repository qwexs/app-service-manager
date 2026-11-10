import { socketPath } from '../../../packages/project/src'
// Health check через IPC
// Проверяет, что daemon запустился и отвечает на handshake с правильной версией

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { Socket } from 'node:net'
import { getRootDir, readTask } from './task'
import type { UpdateTask } from './types'
import { logInfo, logWarn, logError } from './log'

// Константы IPC протокола
const PROTOCOL_VERSION = '1.0.0'
const JSONRPC_VERSION = '2.0'

function getSocketPath(): string {
  return socketPath(getRootDir())
}

/**
 * Создаёт JSON-RPC запрос
 */
function createHandshakeRequest(): string {
  return JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id: `health_${Date.now()}`,
    method: 'handshake',
    params: { version: PROTOCOL_VERSION },
  })
}

/**
 * Парсит ответ handshake
 */
interface HandshakeResult {
  success: boolean
  version?: string
  compatible?: boolean
  instanceId?: string
  error?: string
}

function parseHandshakeResponse(data: string): HandshakeResult {
  try {
    const response = JSON.parse(data)

    if (response.error) {
      return { success: false, error: response.error.message }
    }

    if (response.result) {
      return {
        success: true,
        version: response.result.version,
        compatible: response.result.compatible,
        instanceId: response.result.instanceId,
      }
    }

    return { success: false, error: 'Неизвестный формат ответа' }
  } catch (err) {
    return { success: false, error: `Ошибка парсинга: ${err}` }
  }
}

/**
 * Выполняет IPC запрос с таймаутом
 */
async function ipcRequest(socketPath: string, request: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    let responseData = ''
    let completed = false

    // Таймаут
    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true
        socket.destroy()
        reject(new Error('Таймаут IPC запроса'))
      }
    }, timeout)

    socket.on('connect', () => {
      // Отправляем запрос с разделителем
      socket.write(request + '\n')
    })

    socket.on('data', (chunk) => {
      responseData += chunk.toString()

      // Проверяем наличие полного JSON ответа
      const newlineIndex = responseData.indexOf('\n')
      if (newlineIndex !== -1) {
        clearTimeout(timeoutId)
        completed = true
        socket.end()
        resolve(responseData.slice(0, newlineIndex))
      }
    })

    socket.on('error', (err) => {
      if (!completed) {
        clearTimeout(timeoutId)
        completed = true
        reject(err)
      }
    })

    socket.on('close', () => {
      if (!completed) {
        clearTimeout(timeoutId)
        completed = true
        // Если есть данные без newline, пробуем их использовать
        if (responseData.trim()) {
          resolve(responseData.trim())
        } else {
          reject(new Error('Соединение закрыто без ответа'))
        }
      }
    })

    // Подключаемся
    socket.connect(socketPath)
  })
}

/**
 * Проверяет работоспособность daemon через IPC handshake
 * @param expectedVersion - ожидаемая версия (для проверки что обновление применилось)
 * @param timeout - общий таймаут в мс
 * @param retryInterval - интервал между попытками в мс
 * @returns true если daemon работает и версия совпадает
 */
export async function performHealthCheck(
  expectedVersion: string,
  timeout: number = 30000,
  task?: UpdateTask,
  retryInterval: number = 1000,
): Promise<boolean> {
  const socketPath = getSocketPath()
  const startTime = Date.now()
  let lastError = ''

  await logInfo(`Health check: ожидаем daemon версии ${expectedVersion}`)
  await logInfo(`Socket: ${socketPath}`)

  while (Date.now() - startTime < timeout) {
    try {
      // Проверяем существование socket (используем fs.existsSync, т.к. Bun.file не работает с Unix сокетами)
      if (!existsSync(socketPath) && process.platform !== 'win32') {
        lastError = 'Socket не существует'
        await Bun.sleep(retryInterval)
        continue
      }

      // Отправляем handshake запрос
      const request = createHandshakeRequest()
      const response = await ipcRequest(socketPath, request, 5000)

      // Парсим ответ
      const result = parseHandshakeResponse(response)

      if (!result.success) {
        lastError = result.error || 'Ошибка handshake'
        await Bun.sleep(retryInterval)
        continue
      }

      await logInfo(`Daemon отвечает: версия ${result.version}, совместимость: ${result.compatible}`)

      // Проверяем версию
      if (result.version === expectedVersion) {
        const currentTask = task ? await readTask() : null
        const replacement = currentTask && task && currentTask.id === task.id ? currentTask.replacement : undefined
        if (!replacement || !replacement.identity || result.instanceId !== replacement.identity.instanceId) {
          lastError = 'Daemon ответил без ожидаемой replacement identity'
          await Bun.sleep(retryInterval)
          continue
        }
        await logInfo('Health check пройден успешно!')
        return true
      }

      // Версия не совпадает — возможно, старый daemon ещё не перезапустился
      lastError = `Версия не совпадает: ожидалось ${expectedVersion}, получено ${result.version}`
      await logWarn(lastError)
      await Bun.sleep(retryInterval)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      await Bun.sleep(retryInterval)
    }
  }

  await logError(`Health check провален: ${lastError}`)
  return false
}

/**
 * Проверяет только доступность daemon (без проверки версии)
 * @param timeout - таймаут в мс
 * @returns true если daemon отвечает
 */
export async function isDaemonResponding(timeout: number = 5000): Promise<boolean> {
  const socketPath = getSocketPath()

  try {
    const request = createHandshakeRequest()
    const response = await ipcRequest(socketPath, request, timeout)
    const result = parseHandshakeResponse(response)
    return result.success
  } catch {
    return false
  }
}


/** Запрашивает daemon-only handoff у уже проверенного replacement. */
export async function requestDaemonHandoff(task: UpdateTask, instanceId: string): Promise<boolean> {
  try {
    const response = JSON.parse(await ipcRequest(getSocketPath(), JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id: `rollback_${Date.now()}`,
      method: 'update.handoff',
      params: { taskId: task.id, instanceId },
    }) + '\n', 5000)) as { result?: { accepted?: boolean } }
    return response.result?.accepted === true
  } catch {
    return false
  }
}
