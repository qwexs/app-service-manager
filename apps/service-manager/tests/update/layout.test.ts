import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getBackupPath,
  getComponentDir,
  getDownloadPath,
  getPrevBackupPath,
  getStagingPath,
  pathExists,
  pruneUpdateArtifacts,
  replacePath,
  rotateBackup,
} from '../../src/update/layout'

const TEST_DIR = join(import.meta.dir, '.tmp-layout-test')

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(TEST_DIR, { recursive: true, force: true })
})

describe('пути update', () => {
  test('бэкап и staging лежат в явном root', () => {
    const root = TEST_DIR
    // path.join в layout.ts ставит разделитель текущей ОС
    expect(getComponentDir(root, 'app')).toBe(join(root, 'app'))
    expect(getComponentDir(root, 'service-manager')).toBe(root)
    expect(getBackupPath(root, 'app')).toBe(join(root, '.app-backup'))
    expect(getPrevBackupPath(root, 'app')).toBe(join(root, '.app-backup.prev'))
    expect(getStagingPath(root, 'app', '0.0.96')).toBe(join(root, '.app-0.0.96-staging'))
    expect(getDownloadPath(root, 'app', '0.0.96')).toBe(join(root, '.app-0.0.96-download'))
  })
})

describe('replacePath — бэкап уже есть', () => {
  test('не падает ENOTEMPTY и ставит новую версию', async () => {
    const dest = join(TEST_DIR, 'app')
    const staging = join(TEST_DIR, '.app-1.0.0-staging')
    const backup = join(TEST_DIR, '.app-backup')
    const prev = join(TEST_DIR, '.app-backup.prev')

    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'app'), 'old')

    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'leftover'), 'from-august-13')

    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'app'), 'new')

    await replacePath(staging, dest, backup, prev)

    expect(await Bun.file(join(dest, 'app')).text()).toBe('new')
    expect(await Bun.file(join(backup, 'app')).text()).toBe('old')
    expect(await Bun.file(join(prev, 'leftover')).text()).toBe('from-august-13')
    expect(await pathExists(staging)).toBe(false)
  })

  test('ротирует существующий бэкап в .prev', async () => {
    const dest = join(TEST_DIR, 'service-manager')
    const staging = join(TEST_DIR, '.service-manager-0.2.0-staging')
    const backup = join(TEST_DIR, '.service-manager-backup')
    const prev = join(TEST_DIR, '.service-manager-backup.prev')

    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'bin'), 'current')
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'bin'), 'previous')
    await mkdir(prev, { recursive: true })
    await writeFile(join(prev, 'bin'), 'ancient')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'bin'), 'fresh')

    await replacePath(staging, dest, backup, prev)

    expect(await Bun.file(join(dest, 'bin')).text()).toBe('fresh')
    expect(await Bun.file(join(backup, 'bin')).text()).toBe('current')
    expect(await Bun.file(join(prev, 'bin')).text()).toBe('previous')
  })
})

describe('rotateBackup', () => {
  test('не создаёт dest каталог', async () => {
    const backup = join(TEST_DIR, '.app-backup')
    const prev = join(TEST_DIR, '.app-backup.prev')

    await rotateBackup(backup, prev)

    expect(await pathExists(backup)).toBe(false)
    expect(await pathExists(prev)).toBe(false)
  })
})

describe('pruneUpdateArtifacts', () => {
  test('удаляет leftover staging и .backup.old, не трогает текущий бэкап', async () => {
    await mkdir(join(TEST_DIR, '.app-0.0.96-staging'), { recursive: true })
    await mkdir(join(TEST_DIR, '.app-0.0.96-download'), { recursive: true })
    await mkdir(join(TEST_DIR, '.service-manager-0.1.47-staging'), { recursive: true })
    await mkdir(join(TEST_DIR, '.app-backup.old'), { recursive: true })
    await mkdir(join(TEST_DIR, '.app-backup'), { recursive: true })
    await writeFile(join(TEST_DIR, '.app-backup', 'keep'), 'yes')
    await mkdir(join(TEST_DIR, '.app-backup.prev'), { recursive: true })
    await writeFile(join(TEST_DIR, '.app-backup.prev', 'keep'), 'yes')

    const removed = await pruneUpdateArtifacts(TEST_DIR)

    expect(removed.some((p) => p.endsWith('.app-0.0.96-staging'))).toBe(true)
    expect(removed.some((p) => p.endsWith('.app-0.0.96-download'))).toBe(true)
    expect(removed.some((p) => p.endsWith('.service-manager-0.1.47-staging'))).toBe(true)
    expect(removed.some((p) => p.endsWith('.app-backup.old'))).toBe(true)
    expect(await pathExists(join(TEST_DIR, '.app-backup'))).toBe(true)
    expect(await pathExists(join(TEST_DIR, '.app-backup.prev'))).toBe(true)
    expect(await pathExists(join(TEST_DIR, '.app-0.0.96-staging'))).toBe(false)
    expect(await pathExists(join(TEST_DIR, '.app-0.0.96-download'))).toBe(false)
  })
})
