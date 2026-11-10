// Сервис для управления Docker Compose стеками

import { resolve } from 'path'
import type { DockerComposeServiceConfig } from '../types'
import { BaseService } from './base'
import { logger } from '../utils/logger'

export class DockerComposeService extends BaseService {
  declare readonly config: DockerComposeServiceConfig
  private rootDir: string

  constructor(config: DockerComposeServiceConfig, rootDir: string, private namespace: string) {
    super(config)
    this.rootDir = rootDir
  }

  private getComposeCommand(): string[] {
    // Используем полный путь к docker для работы в daemon режиме
    const dockerPath = Bun.which('docker') || '/usr/bin/docker'
    return [dockerPath, 'compose']
  }

  private getComposeArgs(): string[] {
    const composeFile = resolve(this.rootDir, this.config.cwd, this.config.composeFile)
    const args = ['--project-name', this.namespace, '-f', composeFile]

    return args
  }

  async start(): Promise<void> {
    if (this._state.status === 'running') {
      logger.warn(this.name, 'Сервис уже запущен')
      return
    }

    this.setState({ status: 'starting', error: undefined })
    logger.info(this.name, 'Запуск Docker Compose...')

    try {
      const cmd = this.getComposeCommand()
      const args = [...this.getComposeArgs(), 'up', '-d']

      // Добавляем конкретные сервисы, если указаны
      if (this.config.services && this.config.services.length > 0) {
        args.push(...this.config.services)
      }

      logger.debug(this.name, `Команда: ${cmd.join(' ')} ${args.join(' ')}`)

      const proc = Bun.spawn([...cmd, ...args], {
        cwd: resolve(this.rootDir, this.config.cwd),
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // Читаем вывод
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()

      const exitCode = await proc.exited

      if (stdout.trim()) {
        logger.stdout(this.name, stdout)
      }
      if (stderr.trim()) {
        // Docker compose часто пишет информационные сообщения в stderr
        logger.stdout(this.name, stderr)
      }

      if (exitCode !== 0) {
        throw new Error(`Docker Compose завершился с кодом: ${exitCode}`)
      }

      this.setState({ status: 'running', startedAt: new Date() })
      logger.success(this.name, 'Docker Compose запущен')
      this.emit('started')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.setState({ status: 'failed', error: errorMessage })
      logger.error(this.name, `Ошибка запуска: ${errorMessage}`)
      this.emit('failed', { error: errorMessage })
      throw err
    }
  }

  async stop(): Promise<void> {
    // Проверяем реальное состояние контейнеров
    await this.refreshStatus()

    if (this._state.status === 'stopped') {
      logger.warn(this.name, 'Сервис не запущен')
      return
    }

    this.setState({ status: 'stopping' })
    logger.info(this.name, 'Остановка Docker Compose...')

    try {
      const cmd = this.getComposeCommand()
      const args = [...this.getComposeArgs(), 'stop', ...this.config.services!]

      const proc = Bun.spawn([...cmd, ...args], {
        cwd: resolve(this.rootDir, this.config.cwd),
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()

      const code = await proc.exited
      if (code !== 0) throw new Error(`Docker Compose stop: ${code}: ${stderr}`)

      if (stdout.trim()) {
        logger.stdout(this.name, stdout)
      }
      if (stderr.trim()) {
        logger.stdout(this.name, stderr)
      }

      this.setState({ status: 'stopped' })
      logger.success(this.name, 'Docker Compose остановлен')
      this.emit('stopped')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(this.name, `Ошибка остановки: ${errorMessage}`)
      this.setState({ status: 'failed', error: errorMessage })
      throw err
    }
  }

  // Переопределяем getStatus для проверки реального состояния контейнеров
  override getStatus() {
    // Возвращаем кэшированный статус, реальная проверка в refreshStatus()
    return this._state.status
  }

  // Обновление статуса из Docker
  async refreshStatus(): Promise<void> {
    const containerStatus = await this.checkContainerStatus()
    if (containerStatus === 'running') {
      this.setState({ status: 'running' })
    } else if (containerStatus === 'partial') {
      this.setState({ status: 'failed', error: 'Частично запущенный Compose stack' })
    } else {
      this.setState({ status: 'stopped' })
    }
  }

  // Проверка статуса контейнеров
  async checkContainerStatus(): Promise<'running' | 'stopped' | 'partial'> {
    const proc = Bun.spawn([...this.getComposeCommand(), ...this.getComposeArgs(), 'ps', '--all', '--format', 'json', ...this.config.services!], {
      cwd: resolve(this.rootDir, this.config.cwd), stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    if (code !== 0) throw new Error(`Docker Compose ps: ${code}: ${stderr}`)
    if (!stdout.trim()) return 'stopped'
    const value = stdout.trim().startsWith('[') ? JSON.parse(stdout) : stdout.trim().split('\n').map((line) => JSON.parse(line))
    const rows = Array.isArray(value) ? value : [value]
    const states = this.config.services!.map((service) => rows.filter((row: any) => row.Service === service))
    if (states.every((group) => group.length && group.every((row: any) => row.State === 'running'))) return 'running'
    if (!rows.some((row: any) => row.State === 'running')) return 'stopped'
    return 'partial'
  }

  // Переопределяем health check для Docker
  protected override async performHealthCheck(): Promise<boolean> {
    // Сначала проверяем, что контейнеры запущены
    const containerStatus = await this.checkContainerStatus()
    if (containerStatus !== 'running') {
      return false
    }

    // Затем выполняем дополнительную проверку, если настроена
    const healthCheck = this.config.healthCheck
    if (!healthCheck) {
      return true
    }

    return super.performHealthCheck()
  }
}
