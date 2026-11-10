import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confinedPath } from '../src'

test.skipIf(process.platform === 'win32')('confinedPath accepts live Unix sockets but rejects escaped socket parents', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sm-socket-')))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'sm-socket-outside-')))
  await mkdir(join(root, '.sock'))
  const socket = join(root, '.sock', 'service-manager.sock')
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
    expect(confinedPath(root, '.sock/service-manager.sock')).toBe(socket)
    await symlink(outside, join(root, 'escaped'))
    expect(() => confinedPath(root, 'escaped/service-manager.sock')).toThrow('Symlink вне проекта')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
