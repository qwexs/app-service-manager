import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { nativePlatform } from './native-build'
import { readPackedRelease } from '../apps/sm-updater/src/publish'
const workspace = resolve(import.meta.dir, '..')
const platform = nativePlatform(process.platform, process.arch)
const suffix = process.platform === 'win32' ? '.exe' : ''
const binaries = ['asm', 'asm-updater', 'app/app'].map((name) => join(workspace, 'dist', platform, name + suffix))
const root = await mkdtemp(join(tmpdir(), 'sm-native-smoke-'))
const commands: { command: string[]; exit: number; stdout: string; stderr: string }[] = []
async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name)
    if (item.isDirectory()) {
      result[item.name + '/'] = 'directory'
      for (const [rel, hash] of Object.entries(await snapshot(full))) result[item.name + '/' + rel] = hash
    } else result[item.name] = new Bun.CryptoHasher('sha256').update(await readFile(full)).digest('hex')
  }
  return result
}
async function run(binary: string, args: string[], expected = 0) {
  const command = [binary, ...args]
  const child = Bun.spawn(command, { cwd: root, env: { PATH: process.env.PATH, BUN_OPTIONS: '--no-env-file' }, stdout: 'pipe', stderr: 'pipe', timeout: 5000 })
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  commands.push({ command, exit, stdout, stderr })
  if (exit !== expected) throw new Error(`Unexpected exit ${exit}: ${command.join(' ')}\n${stderr}`)
}
try {
  await mkdir(join(root, 'app'))
  await writeFile(join(root, 'sm.project.json'), await readFile(join(workspace, 'examples/hello-caddy/sm.project.json')))
  await writeFile(join(root, 'compose.yaml'), await readFile(join(workspace, 'examples/hello-caddy/compose.yaml')))
  // Снимок доказывает отсутствие изменений файлов, не аудит файловых чтений.
  await writeFile(join(root, '.env'), 'SM_SENTINEL=fixture-only\n')
  await writeFile(join(root, 'sentinel'), 'must remain unchanged')
  const before = await snapshot(root)
  for (const binary of binaries) { await run(binary, ['--help']); await run(binary, ['--version']) }
  await run(binaries[0]!, ['--root', root, 'config', 'validate'])
  await run(binaries[0]!, ['config', 'validate', '--root', 'relative'], 1)
  await run(binaries[0]!, ['start'], 1)
  await run(binaries[1]!, [], 1)
  await run(binaries[1]!, ['--root', 'relative'], 1)
  const after = await snapshot(root)
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Safe CLI mutated fixture filesystem')
  const safeCommands = commands.length
  const releases = []
  for (const [index, component] of [[2, 'app'], [0, 'service-manager']] as const) {
    const out = join(root, `${component}-release`)
    await run(binaries[1]!, ['pack', '--component', component, '--artifact', binaries[index]!, '--version', '0.1.0', '--platform', platform, '--out', out])
    const { meta, archive } = await readPackedRelease(out)
    const members = [...(await new Bun.Archive(archive).files()).keys()].sort()
    releases.push({ component, version: meta.version, members, archiveSize: archive.length })
  }
  console.log(JSON.stringify({ platform, safeCommands, offlinePackCommands: 2, unchangedFilesystemBeforePack: true, releases, commands }, null, 2))
} finally { await rm(root, { recursive: true, force: true }) }
