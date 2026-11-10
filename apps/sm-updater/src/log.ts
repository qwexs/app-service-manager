// Логирование для asm-updater
// Пишет в .update/update.log и stdout через нативные Bun API

import { confinedPath } from '../../../packages/project/src'
import { getRootDir } from './task'

// Получаем корневую директорию (директория бинарника)

// Путь к лог-файлу
function getLogPath(): string {
  return confinedPath(getRootDir(), '.update/update.log')
}

/**
 * Записывает сообщение в лог через Bun.write (append)
 * @param message - сообщение для записи
 * @param level - уровень логирования (info, warn, error)
 */
export async function log(message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  const timestamp = new Date().toISOString()
  const levelStr = level.toUpperCase().padEnd(5)
  const line = `[${timestamp}] [${levelStr}] ${message}\n`

  // Выводим в консоль с цветами
  const colors: Record<string, string> = {
    info: '\x1b[36m', // cyan
    warn: '\x1b[33m', // yellow
    error: '\x1b[31m', // red
  }
  const reset = '\x1b[0m'
  console.log(`${colors[level]}[${levelStr}]${reset} ${message}`)

  // Пишем в файл через Bun API (append)
  try {
    const logPath = getLogPath()
    const file = Bun.file(logPath)

    // Читаем существующее содержимое или пустую строку
    const existing = (await file.exists()) ? await file.text() : ''

    // Записываем обратно с новой строкой
    await Bun.write(logPath, existing + line)
  } catch {
    // Игнорируем ошибки записи в лог
  }
}

/**
 * Логирует информационное сообщение
 */
export async function logInfo(message: string): Promise<void> {
  return log(message, 'info')
}

/**
 * Логирует предупреждение
 */
export async function logWarn(message: string): Promise<void> {
  return log(message, 'warn')
}

/**
 * Логирует ошибку
 */
export async function logError(message: string): Promise<void> {
  return log(message, 'error')
}
