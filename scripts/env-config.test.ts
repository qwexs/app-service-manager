import { expect, test } from 'bun:test'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('repository Bun config disables dotenv while preserving process environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asm-env-test-'))
  try {
    await copyFile(resolve(import.meta.dir, '../bunfig.toml'), join(root, 'bunfig.toml'))
    await writeFile(join(root, '.env'), 'ASM_DOTENV_SENTINEL=dotenv\n')
    await writeFile(join(root, '.env.test'), 'ASM_DOTENV_SENTINEL=test-dotenv\n')
    const check = `
      if (process.env.ASM_DOTENV_SENTINEL !== undefined) throw new Error('dotenv loaded')
      if (process.env.ASM_EXPLICIT_ENV !== 'process-env') throw new Error('process environment lost')
    `
    await writeFile(join(root, 'fixture.ts'), check)
    await writeFile(join(root, 'fixture.test.ts'), `import { test } from 'bun:test'; test('env', () => { ${check} })`)
    for (const args of [['--eval', check], ['run', 'fixture.ts'], ['test', 'fixture.test.ts']]) {
      const child = Bun.spawn([process.execPath, ...args], {
        cwd: root, env: { PATH: process.env.PATH, ASM_EXPLICIT_ENV: 'process-env' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [exit, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect({ exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ exit: 0, output: '' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
