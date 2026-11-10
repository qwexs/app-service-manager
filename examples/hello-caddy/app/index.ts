const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('hello-caddy app: serves / and /health on port 18081; --help, --version')
} else if (args.includes('--version')) {
  console.log('hello-caddy app 0.1.0')
} else {
  Bun.serve({
    hostname: '0.0.0.0',
    port: 18081,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/health') return new Response('ok\n')
      if (path === '/') return new Response('Hello from Bun behind Caddy!\n')
      return new Response('Not found\n', { status: 404 })
    },
  })
  console.log('hello-caddy app listening on port 18081')
}
