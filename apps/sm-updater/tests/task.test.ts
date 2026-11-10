import { describe, expect, test } from 'bun:test'
import { parseTask } from '../src/task'

describe('updater task schema', () => {
  test('отвергает legacy task без daemon identity', () => {
    expect(parseTask({ daemonPid: 1, status: 'pending' })).toBeNull()
  })

  test('отвергает v2 task с чужим root или невалидным PID', () => {
    expect(parseTask({ schemaVersion: 2, id: 'task', rootDir: '/a', components: [{}], daemon: { pid: 0, instanceId: '1234567890abcdef', rootDir: '/b', version: '1.0.30' }, handoff: { requested: true, acknowledged: true }, postUpdateApps: { status: 'required' }, healthCheck: { enabled: true, endpoint: 'ipc', timeout: 1 }, status: 'pending' })).toBeNull()
  })
})


test('self-update accepts only asm targets and their matching staging paths', () => {
  for (const binary of ['asm', 'asm.exe']) {
    const task = {
      schemaVersion: 2, id: 'fixture', rootDir: '/fixture', status: 'pending',
      components: [{ name: 'service-manager', currentVersion: '0.1.0', targetVersion: '0.1.1',
        sourcePath: `.update/${binary}.new`, targetPath: binary,
        backupPath: `.update/${binary}.old`, sha256: 'a'.repeat(64) }],
      daemon: { pid: 42, instanceId: 'fixture-instance-123', rootDir: '/fixture', version: '0.1.0' },
      handoff: { requested: true, acknowledged: false }, postUpdateApps: { status: 'required' },
      healthCheck: { enabled: true, endpoint: 'ipc', timeout: 1000 }, rollbackOnFailure: true,
    }
    expect(parseTask(task)).not.toBeNull()
    for (const targetPath of ['service-manager', 'service-manager.exe', '../asm', 'other']) {
      expect(parseTask({ ...task, components: [{ ...task.components[0], targetPath }] })).toBeNull()
    }
    for (const field of ['sourcePath', 'backupPath']) {
      expect(parseTask({ ...task, components: [{ ...task.components[0], [field]: '.update/wrong' }] })).toBeNull()
    }
  }
})
