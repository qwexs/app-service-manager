import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { createDaemonClient } from '../../src/ipc/client'
import * as platform from '../../src/daemon/platform'
import { type IPCClient, type PlatformAdapter } from '../../src/daemon/platform'

const originalAdapter = platform.getPlatformAdapter()
let adapterSpy: ReturnType<typeof spyOn>
let clearTimeoutSpy: ReturnType<typeof spyOn>

afterEach(() => {
  adapterSpy?.mockRestore()
  clearTimeoutSpy?.mockRestore()
})

function setup(send: IPCClient['send']) {
  const client: IPCClient = {
    connect: mock(async () => {}),
    disconnect: mock(async () => {}),
    isConnected: () => true,
    send,
    onNotification: mock(() => {}),
    onError: mock(() => {}),
    onDisconnect: mock(() => {}),
  }
  const adapter = {
    ...originalAdapter,
    getSocketPath: () => '/test/socket',
    exists: async () => true,
    createIPCClient: () => client,
  } as PlatformAdapter
  adapterSpy = spyOn(platform, 'getPlatformAdapter').mockReturnValue(adapter)
  return client
}

const handshake = (compatible = true) => JSON.stringify({
  jsonrpc: '2.0', id: '1', result: {
    version: '1.0.0', compatible, daemonUptime: 1, servicesCount: 0, instanceId: 'test',
  },
})

describe('DaemonClient timer cleanup', () => {
  test('clears the connect timeout after successful connect and handshake', async () => {
    setup(async () => handshake())
    clearTimeoutSpy = spyOn(globalThis, 'clearTimeout')
    const client = createDaemonClient({ rootDir: '/test', connectTimeout: 60_000 })

    await client.connect()

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2)
    await client.disconnect()
  })

  test('disconnects the transport when handshake fails', async () => {
    const transport = setup(async () => handshake(false))
    const client = createDaemonClient({ rootDir: '/test', connectTimeout: 60_000 })

    await expect(client.connect()).rejects.toThrow()

    expect(transport.disconnect).toHaveBeenCalledTimes(1)
  })

  test('clears the connect timeout and disconnects when transport connect fails', async () => {
    const transport = setup(async () => handshake())
    transport.connect = mock(async () => { throw new Error('connect failed') })
    clearTimeoutSpy = spyOn(globalThis, 'clearTimeout')
    const client = createDaemonClient({ rootDir: '/test', connectTimeout: 60_000 })

    await expect(client.connect()).rejects.toThrow()

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
  })
})
