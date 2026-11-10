import { describe, expect, test } from 'bun:test'
import { compareVersions, satisfiesVersion } from '../../src/update/types'
import { hoursToCron, UpdateConfigError } from '../../src/update/config'
import { UpdateRepository } from '../../src/update/repository'

describe('compareVersions (Bun.semver)', () => {
  test('равные версии, включая префикс v', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
  })

  test('порядок patch/minor/major', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1)
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
  })

  test('pre-release меньше релиза', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })

  test('невалидная версия бросает', () => {
    expect(() => compareVersions('invalid', '1.0.0')).toThrow()
  })
})

describe('satisfiesVersion', () => {
  test('поддерживает диапазоны node-semver', () => {
    expect(satisfiesVersion('1.2.3', '>=1.0.0')).toBe(true)
    expect(satisfiesVersion('1.2.3', '^1.0.0')).toBe(true)
    expect(satisfiesVersion('2.0.0', '^1.0.0')).toBe(false)
    expect(satisfiesVersion('1.0.0-beta', '>=1.0.0')).toBe(false)
  })
})

describe('hoursToCron', () => {
  test('мапит часы на cron', () => {
    expect(hoursToCron(1)).toBe('@hourly')
    expect(hoursToCron(24)).toBe('@daily')
    expect(hoursToCron(6)).toBe('0 */6 * * *')
    expect(hoursToCron(48)).toBe('0 0 */2 * *')
  })

  test('отклоняет 0 и отрицательные', () => {
    expect(() => hoursToCron(0)).toThrow(UpdateConfigError)
    expect(() => hoursToCron(-1)).toThrow(UpdateConfigError)
  })
})

describe('UpdateRepository.verifyChecksum', () => {
  test('сравнивает sha256 без учёта регистра', async () => {
    const repo = new UpdateRepository({
      endpoint: 'https://example.com',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
    })
    const data = new TextEncoder().encode('hello')
    const hash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    expect(await repo.verifyChecksum(data, hash)).toBe(true)
    expect(await repo.verifyChecksum(data, hash.toUpperCase())).toBe(true)
    expect(await repo.verifyChecksum(data, '0'.repeat(64))).toBe(false)
  })
})
