import { confinedPath } from '../../../../packages/project/src'
// Управляем только дочерним процессом текущего daemon.

import type { Subprocess } from 'bun'
import { resolve } from 'path'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import type { BunServiceConfig } from '../types'
import { BaseService } from './base'
import { logger } from '../utils/logger'

export class BunService extends BaseService {
  declare readonly config: BunServiceConfig
  private process: Subprocess | null = null
  private rootDir: string
  private pidFile: string

  constructor(config: BunServiceConfig, rootDir: string) {
    super(config)
    this.rootDir = rootDir
    // PID-файл сохраняется в директории .pids
    const pidsDir = confinedPath(rootDir, '.pids')
    this.pidFile = resolve(pidsDir, `${config.name}.pid`)
  }

  private writePidFile(pid: number): void {
    mkdirSync(resolve(this.rootDir, '.pids'), { recursive: true })
    writeFileSync(this.pidFile, String(pid), 'utf-8')
  }

  private removePidFile(): void {
    if (existsSync(this.pidFile)) unlinkSync(this.pidFile)
  }

  override async waitForHealthy(timeoutMs?: number): Promise<boolean> {
    const child = this.process
    if (!child || child.exitCode !== null) return false
    const healthy = await super.waitForHealthy(timeoutMs)
    return healthy && this.process === child && child.exitCode === null
  }

  override async checkHealth(): Promise<boolean> {
    const child = this.process
    if (!child || child.exitCode !== null || !['running', 'starting'].includes(this.getStatus())) return false
    const healthy = await super.checkHealth()
    return healthy && this.process === child && child.exitCode === null
  }

  async refreshStatus(): Promise<void> {
    if (this.process && this.process.exitCode === null) return
    if (!this.process && existsSync(this.pidFile)) {
      this.setState({ status: 'unknown', error: 'PID без подтверждённого владения; требуется ручная проверка' })
      return
    }
    this.setState({ status: 'stopped', pid: undefined })
  }

  async start(): Promise<void> {
    if (this._state.status === 'running') {
      logger.warn(this.name, 'Сервис уже запущен')
      return
    }

    if (!this.process && existsSync(this.pidFile)) throw new Error(`${this.name}: неподтверждённый PID-файл; запуск запрещён`)
    this.setState({ status: 'starting', error: undefined })
    logger.info(this.name, 'Запуск...')

    try {
      const cwd = confinedPath(this.rootDir, this.config.cwd)
      const executable = confinedPath(this.rootDir, `${this.config.cwd}/${this.config.executable}`)

      // Проверяем существование исполняемого файла
      const file = Bun.file(executable)
      if (!(await file.exists())) {
        throw new Error(`Исполняемый файл не найден: ${executable}`)
      }

      const args = this.config.args || []

      logger.debug(this.name, `Запуск: ${executable} ${args.join(' ')}`)
      logger.debug(this.name, `CWD: ${cwd}`)

      this.process = Bun.spawn([executable, ...args], {
        cwd,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
        onExit: (proc, exitCode, signalCode) => {
          if (this.process?.pid === proc.pid) this.handleExit(exitCode, signalCode ? String(signalCode) : null)
        },
      })

      // Асинхронное чтение stdout
      if (this.process.stdout && typeof this.process.stdout !== 'number') {
        this.readStream(this.process.stdout, 'stdout')
      }
      // Асинхронное чтение stderr
      if (this.process.stderr && typeof this.process.stderr !== 'number') {
        this.readStream(this.process.stderr, 'stderr')
      }

      this.setState({
        status: 'running',
        pid: this.process.pid,
        startedAt: new Date(),
      })

      // Сохраняем PID в файл для отслеживания между сессиями
      this.writePidFile(this.process.pid)

      logger.success(this.name, `Запущен (PID: ${this.process.pid})`)
      this.emit('started', { pid: this.process.pid })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.setState({ status: 'failed', error: errorMessage })
      logger.error(this.name, `Ошибка запуска: ${errorMessage}`)
      this.emit('failed', { error: errorMessage })
      throw err
    }
  }

  async stop(): Promise<void> {
    if (!this.process) {
      if (existsSync(this.pidFile)) throw new Error(`${this.name}: PID не принадлежит текущему daemon; сигнал не отправлен`)
      this.setState({ status: 'stopped', pid: undefined })
      return
    }

    this.setState({ status: 'stopping' })
    logger.info(this.name, 'Остановка...')

    const child = this.process
    try {
      // Отправляем SIGTERM для graceful shutdown
      child.kill('SIGTERM')

      // Ждём завершения с таймаутом
      const exitPromise = child.exited
      const timeoutPromise = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10000))

      const result = await Promise.race([exitPromise, timeoutPromise])

      if (result === 'timeout') {
        logger.warn(this.name, 'Таймаут graceful shutdown, отправляем SIGKILL')
        child.kill('SIGKILL')
        await child.exited
      }

      this.process = null
      this.removePidFile()
      this.setState({ status: 'stopped', pid: undefined })
      logger.success(this.name, 'Остановлен')
      this.emit('stopped')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(this.name, `Ошибка остановки: ${errorMessage}`)
      this.setState({ status: 'failed', error: errorMessage })
      throw err
    }
  }

  private handleExit(exitCode: number | null, signalCode: string | null): void {
    const wasRunning = this._state.status === 'running'

    if (signalCode) {
      logger.info(this.name, `Завершён по сигналу: ${signalCode}`)
    } else if (exitCode !== null && exitCode !== 0) {
      logger.error(this.name, `Завершён с кодом: ${exitCode}`)
      this.setState({ status: 'failed', error: `Exit code: ${exitCode}` })
      if (wasRunning) {
        this.emit('failed', { exitCode })
      }
    } else {
      logger.info(this.name, 'Завершён успешно')
    }

    if (this._state.status !== 'stopping') {
      this.removePidFile()
      this.setState({ status: 'stopped', pid: undefined })
      this.emit('stopped')
    }

    this.process = null
  }

  private async readStream(stream: ReadableStream<Uint8Array> | null, type: 'stdout' | 'stderr'): Promise<void> {
    if (!stream) return

    const reader = stream.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        if (type === 'stdout') {
          logger.stdout(this.name, text)
        } else {
          logger.stderr(this.name, text)
        }
        this.emit('output', { type, data: text })
      }
    } catch {
      // Поток закрыт
    }
  }
}
