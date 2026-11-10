import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const platforms = ['linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-arm64', 'darwin-amd64'] as const
type Platform = typeof platforms[number]

export function nativePlatform(platform: string, arch: string): Platform {
  const os = platform === 'win32' ? 'windows' : platform
  const cpu = arch === 'x64' ? 'amd64' : arch
  const name = `${os}-${cpu}`
  if (!platforms.some((item) => item === name)) throw new Error(`Unsupported native platform: ${name}`)
  return name as Platform
}

export function parseTarget(args: string[], host: Platform): Platform {
  let target = 'native'
  if (args.length === 2 && args[0] === '--target') target = args[1]!
  else if (args.length === 1 && args[0]!.startsWith('--target=')) target = args[0]!.slice('--target='.length)
  else if (args.length !== 0) throw new Error('Usage: native-build.ts [--target native|<platform>]')
  if (target === 'native') return host
  if (!platforms.some((item) => item === target)) throw new Error(`Unsupported target: ${target}`)
  if (target !== host) throw new Error(`Cross-platform builds are not supported: ${target} (native: ${host})`)
  return host
}

export function buildPlan(root: string, platform: Platform) {
  const suffix = platform.startsWith('windows-') ? '.exe' : ''
  const output = resolve(root, 'dist', platform)
  return [
    { entry: resolve(root, 'apps/service-manager/src/index.ts'), output: resolve(output, `asm${suffix}`) },
    { entry: resolve(root, 'apps/sm-updater/src/cli.ts'), output: resolve(output, `asm-updater${suffix}`) },
    { entry: resolve(root, 'examples/hello-caddy/app/index.ts'), output: resolve(output, 'app', `app${suffix}`) },
  ]
}

export async function buildNative(root: string, platform: Platform, run: (entry: string, output: string) => Promise<number>) {
  for (const item of buildPlan(root, platform)) {
    await mkdir(dirname(item.output), { recursive: true })
    const code = await run(item.entry, item.output)
    if (code !== 0) throw new Error(`Build failed for ${item.entry} (exit ${code})`)
  }
}

if (import.meta.main) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const platform = parseTarget(process.argv.slice(2), nativePlatform(process.platform, process.arch))
    await buildNative(root, platform, async (entry, output) => {
      const child = Bun.spawn([process.execPath, 'build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', `--outfile=${output}`, entry], { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
      return await child.exited
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
