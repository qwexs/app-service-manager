import { readFileSync } from 'node:fs'

if (process.argv.includes('--help')) {
  console.log('hello-minio: local compiled Bun + MinIO demo; runtime-config.json in app cwd')
} else if (process.argv.includes('--version')) {
  console.log('hello-minio 0.1.0')
} else {
  const config = JSON.parse(readFileSync('runtime-config.json', 'utf8')) as {
    port: number; endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string
  }
  const storage = new Bun.S3Client({ ...config, region: 'us-east-1' })
  const object = storage.file('demo.txt')
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: config.port,
    async fetch(request) {
      const path = new URL(request.url).pathname
      try {
        if (path === '/health') {
          const result = await fetch(`${config.endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(2000) })
          return Response.json({ ok: result.ok, storage: 'minio' }, { status: result.ok ? 200 : 503 })
        }
        if (path === '/object' && request.method === 'PUT') {
          await object.write(await request.text(), { type: 'text/plain' })
          return Response.json({ stored: true, key: 'demo.txt' })
        }
        if (path === '/object' && request.method === 'GET') return new Response(await object.text())
        if (path === '/object' && request.method === 'DELETE') {
          await object.delete()
          return new Response(null, { status: 204 })
        }
        if (path === '/') return Response.json({ app: 'hello-minio', pid: process.pid, storage: 'minio', object: '/object' })
        return new Response('Not found', { status: 404 })
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        return Response.json({ error: 'Storage request failed; check app logs' }, { status: 502 })
      }
    },
  })
  console.log(`hello-minio listening on ${server.url}`)
}
