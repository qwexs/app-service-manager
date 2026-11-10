// File Logger
// Логирование в файлы с ротацией для daemon-режима
// UTF-8 encoding, ISO 8601 timestamps

import { stat, rename, unlink, mkdir, readdir } from 'node:fs/promises'
import { openSync, closeSync, constants } from 'node:fs'
import path from 'path'
import { LOGS_DIR } from './platform'
import type { LogLevel, LogEntry } from '../ipc/protocol'

// ─────────────────────────────────────────────────────────────────────────────
// Типы и конфигурация
// ─────────────────────────────────────────────────────────────────────────────

export interface LogConfig {
  // Директория для логов (.logs/)
  directory: string
  // Максимальный размер файла в байтах (default: 50MB)
  maxFileSize: number
  // Количество ротируемых файлов для обычных логов (default: 25)
  maxFiles: number
  // Писать ли общий лог (default: true)
  combinedLog: boolean
  // Сервисы с архивной ротацией (переименование с датой, 1 архив)
  archiveServices: string[]
}

export const DEFAULT_LOG_CONFIG: LogConfig = {
  directory: LOGS_DIR,
  maxFileSize: 50 * 1024 * 1024, // 50MB
  maxFiles: 25,
  combinedLog: true,
  archiveServices: ['app', 'worker'], // Эти сервисы используют архивную ротацию
}

// ─────────────────────────────────────────────────────────────────────────────
// FileLogger — основной класс логгера
// ─────────────────────────────────────────────────────────────────────────────

export class FileLogger {
  private readonly config: LogConfig
  private readonly rootDir: string
  private readonly logsDir: string

  // Числовой fd (openSync), не fs.promises.FileHandle: в bun 1.4 GC
  // незакрытого FileHandle — ERR_INVALID_STATE и падение процесса.
  // FileSink через writer() без append затирает файл, поэтому O_APPEND.
  private fds: Map<string, number> = new Map()
  private writers: Map<string, ReturnType<Bun.BunFile['writer']>> = new Map()

  // Текущие размеры файлов (для отслеживания ротации)
  private fileSizes: Map<string, number> = new Map()

  // Подписчики на логи (для streaming)
  private subscribers: Set<(entry: LogEntry) => void> = new Set()

  // Флаг инициализации
  private initialized = false

  constructor(rootDir: string, config: Partial<LogConfig> = {}) {
    this.rootDir = rootDir
    this.config = { ...DEFAULT_LOG_CONFIG, ...config }
    this.logsDir = path.join(rootDir, this.config.directory)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Инициализация и завершение
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return

    // Создаём директорию для логов
    await mkdir(this.logsDir, { recursive: true })

    // Инициализируем размеры существующих файлов
    await this.initializeFileSizes()

    this.initialized = true
  }

  async close(): Promise<void> {
    for (const filename of [...this.writers.keys()]) {
      await this.closeWriter(filename)
    }
    this.fileSizes.clear()
    this.subscribers.clear()
    this.initialized = false
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Запись логов
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Записать лог для сервиса.
   */
  async log(service: string, level: LogLevel, message: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize()
    }

    const timestamp = new Date().toISOString()
    const entry: LogEntry = { service, level, message, timestamp }

    // Форматируем строку для записи
    const line = this.formatLogLine(entry)

    // Записываем в файл сервиса
    await this.writeToFile(`${service}.log`, line)

    // Записываем в combined.log если включено
    if (this.config.combinedLog) {
      await this.writeToFile('combined.log', line)
    }

    // Уведомляем подписчиков
    this.notifySubscribers(entry)
  }

  /**
   * Записать stdout от сервиса (парсим на строки).
   */
  async stdout(service: string, data: string): Promise<void> {
    const lines = data.split('\n')
    for (const line of lines) {
      if (line.trim()) {
        await this.log(service, 'info', line)
      }
    }
  }

  /**
   * Записать stderr от сервиса.
   */
  async stderr(service: string, data: string): Promise<void> {
    const lines = data.split('\n')
    for (const line of lines) {
      if (line.trim()) {
        await this.log(service, 'error', line)
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Чтение логов
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Получить последние N строк логов.
   * @param service - имя сервиса или undefined для combined.log
   * @param lines - количество строк (default: 100)
   */
  async getLogs(service?: string, lines = 100): Promise<LogEntry[]> {
    const filename = service ? `${service}.log` : 'combined.log'
    const filepath = path.join(this.logsDir, filename)

    try {
      const file = Bun.file(filepath)
      if (!(await file.exists())) {
        return []
      }
      const content = await file.text()
      const logLines = content.trim().split('\n').filter(Boolean)

      // Берём последние N строк
      const lastLines = logLines.slice(-lines)

      // Парсим строки в LogEntry
      return lastLines.map((line) => this.parseLogLine(line)).filter((entry): entry is LogEntry => entry !== null)
    } catch (error) {
      // Файл не существует — возвращаем пустой массив
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
  }

  /**
   * Получить список доступных лог-файлов (сервисов).
   * Исключает системные логи и архивные файлы.
   */
  async getAvailableServices(): Promise<string[]> {
    try {
      const files = await readdir(this.logsDir)
      // Паттерн для основных лог-файлов: name.log (не архивы с датой или номером)
      const mainLogPattern = /^([a-z][\w-]*?)\.log$/
      const excludeServices = ['combined', 'daemon', 'supervisor']

      return files
        .filter((f) => {
          const match = f.match(mainLogPattern)
          if (!match) return false
          const serviceName = match[1]
          return !excludeServices.includes(serviceName)
        })
        .map((f) => f.replace('.log', ''))
    } catch {
      return []
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Подписка на логи (для streaming)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Подписаться на новые логи.
   * @returns функция отписки
   */
  subscribe(callback: (entry: LogEntry) => void): () => void {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  /**
   * Подписаться на логи конкретного сервиса.
   * @returns функция отписки
   */
  subscribeToService(service: string, callback: (entry: LogEntry) => void): () => void {
    const filteredCallback = (entry: LogEntry) => {
      if (entry.service === service) {
        callback(entry)
      }
    }
    this.subscribers.add(filteredCallback)
    return () => {
      this.subscribers.delete(filteredCallback)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Приватные методы
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Форматирование строки лога.
   * Формат: [2025-12-12T10:30:00.000Z] [INFO] [app] Message text
   */
  private formatLogLine(entry: LogEntry): string {
    const levelUpper = entry.level.toUpperCase().padEnd(5)
    const service = entry.service.padEnd(10)
    return `[${entry.timestamp}] [${levelUpper}] [${service}] ${entry.message}`
  }

  /**
   * Парсинг строки лога обратно в LogEntry.
   */
  private parseLogLine(line: string): LogEntry | null {
    // Формат: [timestamp] [LEVEL] [service   ] message
    // Используем [\w-]+ для имени сервиса чтобы поддержать дефисы (worker, caddy-local)
    const match = line.match(/^\[([^\]]+)\]\s+\[(\w+)\s*\]\s+\[([\w-]+)\s*\]\s+(.*)$/)
    if (!match) {
      // Попробуем более простой формат (для совместимости)
      return null
    }

    const [, timestamp, level, service, message] = match
    return {
      timestamp,
      level: level.toLowerCase() as LogLevel,
      service: service.trim(),
      message,
    }
  }

  /**
   * Запись строки в файл с ротацией.
   */
  private async writeToFile(filename: string, line: string): Promise<void> {
    const filepath = path.join(this.logsDir, filename)
    const lineBytes = Buffer.byteLength(line + '\n', 'utf-8')

    // Проверяем, нужна ли ротация
    const currentSize = this.fileSizes.get(filename) || 0
    if (currentSize + lineBytes > this.config.maxFileSize) {
      await this.rotateFile(filename)
    }

    const writer = await this.getWriter(filename)
    writer.write(line + '\n')
    await writer.flush()

    this.fileSizes.set(filename, (this.fileSizes.get(filename) || 0) + lineBytes)
  }

  private async getWriter(filename: string): Promise<ReturnType<Bun.BunFile['writer']>> {
    const existing = this.writers.get(filename)
    if (existing) return existing

    const filepath = path.join(this.logsDir, filename)
    // openSync без await — нет гонки двух open() на combined.log
    const fd = openSync(filepath, constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT, 0o644)
    const writer = Bun.file(fd).writer()
    this.fds.set(filename, fd)
    this.writers.set(filename, writer)
    return writer
  }

  private async closeWriter(filename: string): Promise<void> {
    const writer = this.writers.get(filename)
    if (writer) {
      try {
        await writer.end()
      } catch {
        // ignore
      }
      this.writers.delete(filename)
    }
    const fd = this.fds.get(filename)
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // FileSink.end() мог уже закрыть fd
      }
      this.fds.delete(filename)
    }
  }

  /**
   * Ротация файла логов.
   * Для app/worker: file.log → file.2025-12-13T10-30-00.log (1 архив)
   * Для остальных: file.log → file.log.1 → file.log.2 → ... → удаление
   */
  private async rotateFile(filename: string): Promise<void> {
    const filepath = path.join(this.logsDir, filename)

    await this.closeWriter(filename)

    // Определяем имя сервиса из filename (например, "app.log" → "app")
    const serviceName = filename.replace('.log', '')

    // Для app и worker используем архивную ротацию с датой
    if (this.config.archiveServices.includes(serviceName)) {
      await this.rotateWithDate(filename, filepath)
    } else {
      await this.rotateWithNumbers(filename, filepath)
    }

    // Сбрасываем размер
    this.fileSizes.set(filename, 0)
  }

  /**
   * Архивная ротация: переименование с датой, хранится 1 архив.
   * app.log → app.2025-12-13T10-30-00.log
   */
  private async rotateWithDate(filename: string, filepath: string): Promise<void> {
    const baseName = filename.replace('.log', '')

    // Удаляем предыдущий архив (ищем файлы вида baseName.*.log)
    try {
      const files = await readdir(this.logsDir)
      const archivePattern = new RegExp(`^${baseName}\\.\\d{4}-\\d{2}-\\d{2}T[\\d-]+\\.log$`)
      for (const file of files) {
        if (archivePattern.test(file)) {
          await unlink(path.join(this.logsDir, file))
        }
      }
    } catch {
      // Игнорируем ошибки
    }

    // Переименовываем текущий файл с датой
    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, '-')
      .replace(/\.\d+Z$/, '')
    const archivePath = path.join(this.logsDir, `${baseName}.${timestamp}.log`)
    try {
      await rename(filepath, archivePath)
    } catch {
      // Игнорируем если файл не существует
    }
  }

  /**
   * Числовая ротация: file.log → file.log.1 → file.log.2 → ... → удаление
   */
  private async rotateWithNumbers(filename: string, filepath: string): Promise<void> {
    // Удаляем самый старый файл
    const oldestPath = `${filepath}.${this.config.maxFiles}`
    try {
      await unlink(oldestPath)
    } catch {
      // Игнорируем если файл не существует
    }

    // Сдвигаем номера файлов
    for (let i = this.config.maxFiles - 1; i >= 1; i--) {
      const from = `${filepath}.${i}`
      const to = `${filepath}.${i + 1}`
      try {
        await rename(from, to)
      } catch {
        // Игнорируем если файл не существует
      }
    }

    // Переименовываем текущий файл
    try {
      await rename(filepath, `${filepath}.1`)
    } catch {
      // Игнорируем если файл не существует
    }
  }

  /**
   * Инициализация размеров существующих файлов.
   */
  private async initializeFileSizes(): Promise<void> {
    try {
      const files = await readdir(this.logsDir)
      for (const file of files) {
        if (file.endsWith('.log') && !file.includes('.log.')) {
          const filepath = path.join(this.logsDir, file)
          try {
            const stats = await stat(filepath)
            this.fileSizes.set(file, stats.size)
          } catch {
            // Игнорируем ошибки
          }
        }
      }
    } catch {
      // Директория не существует — всё ok
    }
  }

  /**
   * Уведомление подписчиков о новом логе.
   */
  private notifySubscribers(entry: LogEntry): void {
    for (const callback of this.subscribers) {
      try {
        callback(entry)
      } catch {
        // Игнорируем ошибки в callbacks
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Фабричная функция
// ─────────────────────────────────────────────────────────────────────────────

export function createFileLogger(rootDir: string, config?: Partial<LogConfig>): FileLogger {
  return new FileLogger(rootDir, config)
}
