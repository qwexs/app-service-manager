// Конфигурация модуля обновления
// Парсинг переменных окружения и валидация через Zod-подобную логику

import type { UpdateChannel } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Типы конфигурации
// ─────────────────────────────────────────────────────────────────────────────

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export interface UpdateConfig {
  s3: S3Config
  channel: UpdateChannel
  checkInterval: number // часы (0 = отключено)
}

// ─────────────────────────────────────────────────────────────────────────────
// Значения по умолчанию
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_REGION = 'us-east-1'
const DEFAULT_CHANNEL: UpdateChannel = 'stable'
const DEFAULT_CHECK_INTERVAL = 0 // часы

// ─────────────────────────────────────────────────────────────────────────────
// Валидация
// ─────────────────────────────────────────────────────────────────────────────

function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

function isValidChannel(channel: string): channel is UpdateChannel {
  return ['stable', 'beta', 'nightly'].includes(channel)
}

// ─────────────────────────────────────────────────────────────────────────────
// Ошибки конфигурации
// ─────────────────────────────────────────────────────────────────────────────

export class UpdateConfigError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message)
    this.name = 'UpdateConfigError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Парсинг конфигурации
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Парсит конфигурацию обновления из переменных окружения.
 * Выбрасывает UpdateConfigError если обязательные поля отсутствуют или невалидны.
 */
export function parseUpdateConfig(): UpdateConfig {
  const endpoint = process.env.UPDATE_S3_ENDPOINT
  const bucket = process.env.UPDATE_S3_BUCKET
  const accessKeyId = process.env.UPDATE_S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.UPDATE_S3_SECRET_ACCESS_KEY

  // Проверка обязательных полей
  if (!endpoint) {
    throw new UpdateConfigError('UPDATE_S3_ENDPOINT не указан', 'endpoint')
  }
  if (!isValidUrl(endpoint)) {
    throw new UpdateConfigError('UPDATE_S3_ENDPOINT должен быть валидным URL', 'endpoint')
  }
  if (!bucket) {
    throw new UpdateConfigError('UPDATE_S3_BUCKET не указан', 'bucket')
  }
  if (!accessKeyId) {
    throw new UpdateConfigError('UPDATE_S3_ACCESS_KEY_ID не указан', 'accessKeyId')
  }
  if (!secretAccessKey) {
    throw new UpdateConfigError('UPDATE_S3_SECRET_ACCESS_KEY не указан', 'secretAccessKey')
  }

  // Опциональные поля с валидацией
  const region = process.env.UPDATE_S3_REGION || DEFAULT_REGION

  const channelEnv = process.env.UPDATE_CHANNEL || DEFAULT_CHANNEL
  if (!isValidChannel(channelEnv)) {
    throw new UpdateConfigError(
      `UPDATE_CHANNEL должен быть одним из: stable, beta, nightly. Получено: ${channelEnv}`,
      'channel',
    )
  }
  const channel = channelEnv

  const checkIntervalEnv = process.env.UPDATE_CHECK_INTERVAL
  let checkInterval = DEFAULT_CHECK_INTERVAL
  if (checkIntervalEnv) {
    const parsed = parseInt(checkIntervalEnv, 10)
    if (isNaN(parsed) || parsed < 0) {
      throw new UpdateConfigError('UPDATE_CHECK_INTERVAL должен быть неотрицательным числом', 'checkInterval')
    }
    checkInterval = parsed
  }


  return {
    s3: {
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
    },
    channel,
    checkInterval,
  }
}

/**
 * Проверяет, настроена ли конфигурация обновления.
 * Возвращает true если все обязательные переменные окружения установлены.
 */
export function isUpdateConfigured(): boolean {
  return !!(
    process.env.UPDATE_S3_ENDPOINT &&
    process.env.UPDATE_S3_BUCKET &&
    process.env.UPDATE_S3_ACCESS_KEY_ID &&
    process.env.UPDATE_S3_SECRET_ACCESS_KEY
  )
}

/**
 * Безопасно пытается получить конфигурацию.
 * Возвращает null если конфигурация не настроена или невалидна.
 */
export function tryParseUpdateConfig(): UpdateConfig | null {
  if (!isUpdateConfigured()) {
    return null
  }

  try {
    return parseUpdateConfig()
  } catch {
    return null
  }
}

/**
 * Возвращает текущий канал обновлений из переменных окружения.
 * По умолчанию возвращает 'stable'.
 */
export function getUpdateChannel(): UpdateChannel {
  const channel = process.env.UPDATE_CHANNEL
  if (channel && isValidChannel(channel)) {
    return channel
  }
  return DEFAULT_CHANNEL
}

/**
 * Часы интервала → cron-выражение для in-process Bun.cron.
 * 0 не передавать (проверка выключена).
 */
export function hoursToCron(hours: number): string {
  if (hours <= 0) {
    throw new UpdateConfigError('Интервал проверки должен быть больше 0', 'checkInterval')
  }
  if (hours === 1) return '@hourly'
  if (hours === 24) return '@daily'
  if (hours < 24) return `0 */${hours} * * *`
  const days = Math.max(1, Math.round(hours / 24))
  return days === 1 ? '@daily' : `0 0 */${days} * *`
}