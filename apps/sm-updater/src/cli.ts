#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { isAbsolute } from 'node:path'
import { version } from '../package.json'
import type { ComponentName, Platform, UpdateChannel } from './types'

function help(): void {
  console.log(`asm-updater v${version}
Usage:
  asm-updater --root <dir>                  Run the prepared self-update task
  asm-updater pack --component <name> --artifact <absolute-file> --version <semver> --platform <platform> --out <new-absolute-dir> [--channel <channel>] [--changelog <text>]
  asm-updater publish --release <absolute-packed-dir>
  asm-updater --help | --version

Components: app, service-manager
Platforms: linux-amd64, linux-arm64, windows-amd64, darwin-arm64, darwin-amd64
Channels: stable (default), beta, nightly
Pack is offline. It does not build or read .env files. Output must not exist.
Publish uploads a validated packed release; it never builds or overwrites a version.
S3 environment: UPDATE_S3_ENDPOINT, UPDATE_S3_BUCKET, UPDATE_S3_ACCESS_KEY_ID,
UPDATE_S3_SECRET_ACCESS_KEY, UPDATE_S3_REGION (default: us-east-1).
Publish requires one writer per version; uploads are not an atomic S3 transaction.
asm-updater is updated manually alongside asm as a matched pair.`)
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    help()
    return
  }
  if (args[0] === '--version' || args[0] === '-V' || args[0] === 'version') {
    if (args.length !== 1) throw new Error('Version takes no arguments')
    console.log(`asm-updater v${version}`)
    return
  }
  if (args[0] === 'pack') {
    const { values } = parseArgs({ args: args.slice(1), options: {
      component: { type: 'string' }, artifact: { type: 'string' }, version: { type: 'string' },
      platform: { type: 'string' }, out: { type: 'string' }, channel: { type: 'string' }, changelog: { type: 'string' },
    }, strict: true, allowPositionals: false })
    for (const key of ['component', 'artifact', 'version', 'platform', 'out'] as const) {
      if (!values[key]) throw new Error(`Missing --${key}`)
    }
    const { packArtifact } = await import('./publish')
    await packArtifact({ component: values.component as ComponentName, artifact: values.artifact!,
      version: values.version!, platform: values.platform as Platform, out: values.out!,
      channel: values.channel as UpdateChannel | undefined, changelog: values.changelog })
    console.log(`Packed release: ${values.out}`)
    return
  }
  if (args[0] === 'publish') {
    const { values } = parseArgs({ args: args.slice(1), options: { release: { type: 'string' } }, strict: true, allowPositionals: false })
    if (!values.release) throw new Error('Missing --release')
    const { publishRelease } = await import('./publish')
    await publishRelease(values.release)
    console.log(`Published release: ${values.release}`)
    return
  }
  const updateArgs = args[0] === 'update' || args[0] === 'self-update' ? args.slice(1) : args
  const { values } = parseArgs({ args: updateArgs, options: { root: { type: 'string' } }, strict: true, allowPositionals: false })
  if (!values.root || !isAbsolute(values.root) || values.root.includes('\0')) throw new Error('Self-update requires an absolute --root <dir>')
  const { main: update } = await import('./index')
  await update()
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
