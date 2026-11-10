import { validateTaskPaths } from '../../../packages/project/src/task'
import { confinedPath } from '../../../packages/project/src'
// Работа с файлами через нативные Bun API

import { join } from 'node:path'
import { chmod, rename } from 'node:fs/promises'
import { getRootDir } from './task'
import { logInfo, logError } from './log'
import type { UpdateTask, OperationResult } from './types'

/**
 * Вычисляет SHA256 хэш файла через Bun.CryptoHasher
 * @param filePath - путь к файлу
 * @returns hex-строка SHA256
 */
export async function computeSha256(filePath: string): Promise<string> {
  const file = Bun.file(filePath)
  const data = await file.arrayBuffer()
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

/**
 * Проверяет SHA256 файла
 * @param filePath - путь к файлу
 * @param expectedHash - ожидаемый хэш
 * @returns true если хэш совпадает
 */
export async function verifySha256(filePath: string, expectedHash: string): Promise<boolean> {
  const actual = await computeSha256(filePath)
  return actual.toLowerCase() === expectedHash.toLowerCase()
}

/**
 * Копирует файл (через чтение/запись, так как Bun не имеет нативного copy)
 * @param src - исходный путь
 * @param dest - целевой путь
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  const srcFile = Bun.file(src)
  const data = await srcFile.arrayBuffer()
  await Bun.write(dest, data)
}

/**
 * Перемещает файл (rename, с fallback на copy+delete)
 * @param src - исходный путь
 * @param dest - целевой путь
 */
export async function moveFile(src: string, dest: string): Promise<void> {
  try {
    // Пробуем атомарный rename
    await rename(src, dest)
  } catch {
    // Если не получилось (разные файловые системы) — копируем и удаляем
    await copyFile(src, dest)
    await Bun.file(src).delete()
  }
}

/**
 * Удаляет файл если существует
 * Использует нативный Bun.file().delete()
 * @param filePath - путь к файлу
 */
export async function removeFile(filePath: string): Promise<void> {
  const file = Bun.file(filePath)

  if (await file.exists()) {
    await file.delete()
  }
}

/**
 * Устанавливает права на выполнение (только Unix)
 * @param filePath - путь к файлу
 * @param mode - режим (по умолчанию 0o755)
 */
export async function setExecutable(filePath: string, mode: number = 0o755): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(filePath, mode)
}

/**
 * Заменяет файлы компонентов согласно заданию
 * 1. Проверяет SHA256 нового файла
 * 2. Бэкапит текущий файл
 * 3. Перемещает новый файл на место текущего
 * 4. Устанавливает права на выполнение
 *
 * @param task - задание на обновление
 * @returns результат операции
 */
export async function replaceFiles(task: UpdateTask): Promise<OperationResult> {
  const rootDir = getRootDir()
  validateTaskPaths(task, rootDir)

  for (const component of task.components) {
    const sourcePath = confinedPath(rootDir, component.sourcePath)
    const targetPath = confinedPath(rootDir, component.targetPath)
    const backupPath = confinedPath(rootDir, component.backupPath)

    await logInfo(`Обработка компонента: ${component.name}`)
    await logInfo(`  Источник: ${sourcePath}`)
    await logInfo(`  Цель: ${targetPath}`)
    await logInfo(`  Бэкап: ${backupPath}`)

    // 1. Проверяем существование нового файла
    const sourceFile = Bun.file(sourcePath)
    if (!(await sourceFile.exists())) {
      return { success: false, error: `Файл не найден: ${sourcePath}` }
    }

    // 2. Проверяем SHA256
    await logInfo('  Проверка SHA256...')
    const isValid = await verifySha256(sourcePath, component.sha256)
    if (!isValid) {
      const actualHash = await computeSha256(sourcePath)
      return {
        success: false,
        error: `SHA256 не совпадает для ${component.name}. Ожидалось: ${component.sha256}, получено: ${actualHash}`,
      }
    }
    await logInfo('  SHA256 OK')

    try {
      // 3. Бэкапим текущую версию
      const targetFile = Bun.file(targetPath)
      if (await targetFile.exists()) {
        await logInfo('  Создание бэкапа...')
        await removeFile(backupPath) // Удаляем старый бэкап если есть
        await moveFile(targetPath, backupPath)
        await logInfo('  Бэкап создан')
      }

      // 4. Перемещаем новую версию
      await logInfo('  Установка новой версии...')
      await moveFile(sourcePath, targetPath)

      // 5. Устанавливаем права на выполнение
      await setExecutable(targetPath)
      await logInfo('  Новая версия установлена')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await logError(`  Ошибка замены файлов: ${message}`)
      return { success: false, error: `Ошибка замены ${component.name}: ${message}` }
    }
  }

  return { success: true }
}

/**
 * Восстанавливает файлы из бэкапов (откат)
 * @param task - задание на обновление
 * @returns результат операции
 */
export async function restoreFromBackup(task: UpdateTask): Promise<OperationResult> {
  const rootDir = getRootDir()
  validateTaskPaths(task, rootDir)

  for (const component of task.components) {
    const targetPath = confinedPath(rootDir, component.targetPath)
    const backupPath = confinedPath(rootDir, component.backupPath)

    await logInfo(`Восстановление компонента: ${component.name}`)

    const backupFile = Bun.file(backupPath)
    if (!(await backupFile.exists())) {
      await logError(`  Бэкап не найден: ${backupPath}`)
      return { success: false, error: `Бэкап не найден: ${backupPath}` }
    }

    try {
      // Удаляем текущий файл (неработающую версию)
      await removeFile(targetPath)

      // Восстанавливаем из бэкапа
      await moveFile(backupPath, targetPath)

      // Устанавливаем права
      await setExecutable(targetPath)

      await logInfo(`  Восстановлен из бэкапа`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await logError(`  Ошибка восстановления: ${message}`)
      return { success: false, error: `Ошибка восстановления ${component.name}: ${message}` }
    }
  }

  return { success: true }
}
