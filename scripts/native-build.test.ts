import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildNative, buildPlan, nativePlatform, parseTarget } from './native-build'

describe('native build', () => {
  test('maps native OS and architecture and rejects unsupported hosts', () => {
    expect(nativePlatform('darwin', 'arm64')).toBe('darwin-arm64')
    expect(nativePlatform('win32', 'x64')).toBe('windows-amd64')
    expect(() => nativePlatform('win32', 'arm64')).toThrow()
  })
  test('accepts only native or the matching known platform', () => {
    expect(parseTarget([], 'linux-amd64')).toBe('linux-amd64')
    expect(parseTarget(['--target', 'native'], 'linux-amd64')).toBe('linux-amd64')
    expect(parseTarget(['--target=linux-amd64'], 'linux-amd64')).toBe('linux-amd64')
    expect(() => parseTarget(['--target', 'linux-arm64'], 'linux-amd64')).toThrow()
    expect(() => parseTarget(['--target', 'unknown'], 'linux-amd64')).toThrow()
    expect(() => parseTarget(['--target'], 'linux-amd64')).toThrow()
    expect(() => parseTarget(['--target', 'native', '--extra'], 'linux-amd64')).toThrow()
  })
  test('plans distinct platform directories and Windows executable names', () => {
    const windows = buildPlan('/project', 'windows-amd64')
    const linux = buildPlan('/project', 'linux-amd64')
    expect(windows.map((x) => x.output.replaceAll('\\', '/'))).toEqual([
      '/project/dist/windows-amd64/asm.exe',
      '/project/dist/windows-amd64/asm-updater.exe',
      '/project/dist/windows-amd64/app/app.exe',
    ])
    expect(linux[2]!.output.replaceAll('\\', '/')).toBe('/project/dist/linux-amd64/app/app')
  })
  test('stops and fails when updater compilation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-build-test-'))
    const calls: string[] = []
    try {
      await expect(buildNative(root, 'linux-amd64', async (entry) => {
        calls.push(entry)
        return calls.length === 2 ? 1 : 0
      })).rejects.toThrow('Build failed')
      expect(calls.length).toBe(2)
      expect(calls[1]).toContain('sm-updater')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
