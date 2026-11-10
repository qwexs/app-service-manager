import { confinedPath } from '../../../../packages/project/src'
import { validateComponent, validateVersion } from './metadata'
// Пути и атомарная замена каталогов при update.
// Бэкап, staging и download лежат в корне (project root), не в /tmp.
// tar не кладётся в staging: staging переименовывается в dest.

import { readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import type { ComponentName } from './types'

export function getComponentDir(rootDir: string, component: ComponentName): string {
  validateComponent(component)
  switch (component) {
    case 'service-manager':
      return rootDir
    case 'app':
      return confinedPath(rootDir, 'app')
  }
}

export function getBackupPath(rootDir: string, component: ComponentName): string {
  validateComponent(component)
  return confinedPath(rootDir, `.${component}-backup`)
}

export function getPrevBackupPath(rootDir: string, component: ComponentName): string {
  validateComponent(component)
  return confinedPath(rootDir, `.${component}-backup.prev`)
}

export function getStagingPath(rootDir: string, component: ComponentName, version: string): string {
  validateComponent(component)
  validateVersion(version)
  return confinedPath(rootDir, `.${component}-${version}-staging`)
}

export function getDownloadPath(rootDir: string, component: ComponentName, version: string): string {
  validateComponent(component)
  validateVersion(version)
  return confinedPath(rootDir, `.${component}-${version}-download`)
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Ротация бэкапа: текущий → .prev, старый .prev удаляется.
 * Не создаёт dest — он появится через rename.
 */
export async function rotateBackup(backupPath: string, prevPath: string): Promise<void> {
  if (await pathExists(prevPath)) {
    await rm(prevPath, { recursive: true, force: true })
  }

  if (await pathExists(backupPath)) {
    await rename(backupPath, prevPath)
  }
}

/**
 * Атомарно подменяет dest содержимым source.
 * Существующий dest уезжает в backup (предыдущий backup — в .prev).
 */
export async function replacePath(
  sourcePath: string,
  destPath: string,
  backupPath: string,
  prevPath: string,
): Promise<void> {
  await rotateBackup(backupPath, prevPath)

  if (await pathExists(destPath)) {
    await rename(destPath, backupPath)
  }

  await rename(sourcePath, destPath)
}

const STAGING_NAME = /^\.(app|service-manager)-.+-staging$/
const DOWNLOAD_NAME = /^\.(app|service-manager)-.+-download$/
const OLD_BACKUP_NAME = /^\.(app|service-manager)-backup\.old$/

/**
 * Удаляет leftover staging/download и устаревшие бэкапы.
 * Текущий `.{component}-backup` и `.{component}-backup.prev` не трогает.
 */
export async function pruneUpdateArtifacts(rootDir: string): Promise<string[]> {
  const removed: string[] = []

  const rootEntries = await readdir(rootDir).catch(() => [] as string[])
  for (const name of rootEntries) {
    if (!STAGING_NAME.test(name) && !DOWNLOAD_NAME.test(name) && !OLD_BACKUP_NAME.test(name)) continue
    const full = confinedPath(rootDir, name)
    await rm(full, { recursive: true, force: true })
    removed.push(full)
  }


  return removed
}
