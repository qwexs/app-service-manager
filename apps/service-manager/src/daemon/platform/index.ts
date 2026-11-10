// Platform Abstraction Layer
// Абстракция для кроссплатформенной работы daemon (Unix/Windows)

import type { Server as NetServer, Socket } from 'net'

// ─────────────────────────────────────────────────────────────────────────────
// Типы для IPC
// ─────────────────────────────────────────────────────────────────────────────

// Обработчик входящих сообщений
export type MessageHandler = (message: string, reply: (response: string) => void) => void

// Интерфейс IPC сервера
export interface IPCServer {
  // Путь к socket/pipe
  readonly path: string
  // Запуск сервера
  start(): Promise<void>
  // Остановка сервера
  stop(): Promise<void>
  // Проверка, запущен ли сервер
  isRunning(): boolean
  // Установка обработчика сообщений
  onMessage(handler: MessageHandler): void
  // Подписка на ошибки
  onError(handler: (error: Error) => void): void
  // Получить низкоуровневый сервер (для тестов)
  getServer(): NetServer | null
}

// Интерфейс IPC клиента
export interface IPCClient {
  // Подключение к серверу
  connect(): Promise<void>
  // Отключение
  disconnect(): Promise<void>
  // Проверка подключения
  isConnected(): boolean
  // Отправка сообщения и ожидание ответа
  send(message: string): Promise<string>
  // Подписка на уведомления (без ответа)
  onNotification(handler: (notification: string) => void): void
  // Подписка на ошибки
  onError(handler: (error: Error) => void): void
  // Подписка на отключение
  onDisconnect(handler: () => void): void
}

// ─────────────────────────────────────────────────────────────────────────────
// Типы для Lock-файлов
// ─────────────────────────────────────────────────────────────────────────────

export interface LockHandle {
  // Путь к lock-файлу
  readonly path: string
  // Освобождение блокировки
  release(): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// Интерфейс платформенного адаптера
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformAdapter {
  // Имя платформы
  readonly platform: 'unix' | 'windows'

  // ───── IPC ─────

  // Получить путь к socket/pipe
  getSocketPath(rootDir: string): string

  // Создать IPC сервер
  createIPCServer(socketPath: string): IPCServer

  // Создать IPC клиент
  createIPCClient(socketPath: string): IPCClient

  // ───── Процессы ─────

  // Запустить процесс в фоновом режиме (daemonize)
  daemonize(execPath: string, args: string[], options?: DaemonizeOptions): Promise<number>

  // Проверить, запущен ли процесс
  isProcessRunning(pid: number): boolean


  // ───── Lock-файлы ─────

  // Попытка захватить exclusive lock
  acquireLock(path: string): Promise<LockHandle | null>

  // Проверить, заблокирован ли файл
  isLocked(path: string): Promise<boolean>

  // ───── Файловая система ─────

  // Проверить существование файла/socket
  exists(path: string): Promise<boolean>

  // Удалить файл/socket
  unlink(path: string): Promise<void>

  // Прочитать PID из файла
  readPidFile(path: string): Promise<number | null>

  // Записать PID в файл
  writePidFile(path: string, pid: number): Promise<void>
}

// Опции для daemonize
export interface DaemonizeOptions {
  // Рабочая директория
  cwd?: string
  // Переменные окружения
  env?: Record<string, string>
  // Путь для stdout логов
  stdout?: string
  // Путь для stderr логов
  stderr?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Фабрика для получения адаптера текущей платформы
// ─────────────────────────────────────────────────────────────────────────────

let cachedAdapter: PlatformAdapter | null = null

export function getPlatformAdapter(): PlatformAdapter {
  if (cachedAdapter) {
    return cachedAdapter
  }

  if (process.platform === 'win32') {
    // Динамический импорт для избежания загрузки ненужного кода
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WindowsPlatformAdapter } = require('./windows')
    cachedAdapter = new WindowsPlatformAdapter()
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { UnixPlatformAdapter } = require('./unix')
    cachedAdapter = new UnixPlatformAdapter()
  }

  return cachedAdapter!
}

// Сброс кэша адаптера (для тестов)
export function resetPlatformAdapter(): void {
  cachedAdapter = null
}

// ─────────────────────────────────────────────────────────────────────────────
// Константы
// ─────────────────────────────────────────────────────────────────────────────

// Имена директорий
export const SOCKET_DIR = '.sock'
export const PIDS_DIR = '.pids'
export const LOGS_DIR = '.logs'

// Имена файлов
export const DAEMON_SOCKET = 'service-manager.sock'
export const DAEMON_PID = 'daemon.pid'
export const DAEMON_LOCK = 'daemon.lock'

// Windows Named Pipe путь

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты
// ─────────────────────────────────────────────────────────────────────────────

// Определение текущей платформы
export function isWindows(): boolean {
  return process.platform === 'win32'
}

export function isUnix(): boolean {
  return process.platform !== 'win32'
}

// Получить путь к директории с socket/pid
export function getSocketDir(rootDir: string): string {
  return `${rootDir}/${SOCKET_DIR}`
}

export function getPidsDir(rootDir: string): string {
  return `${rootDir}/${PIDS_DIR}`
}

export function getLogsDir(rootDir: string): string {
  return `${rootDir}/${LOGS_DIR}`
}
