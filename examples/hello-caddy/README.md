# Bun + Caddy

This manual example runs a compiled Bun app behind Caddy in Docker. It has no TLS and is not a production configuration. The app binds **0.0.0.0:18081**, potentially exposing it to other machines; use a firewall or isolated environment. Caddy binds `127.0.0.1:18080`. Docker must support `host.docker.internal` and `host-gateway`. The `caddy:2-alpine` image is a floating tag, not a production digest pin.

Build from the repository root with `BUN_OPTIONS=--no-env-file bun run build:native`. The build is native to the current host. Create a new runtime directory and copy `asm[.exe]`, `asm-updater[.exe]` and `app/` from `dist/<platform>/`. Copy this example's `sm.project.json` and `compose.yaml` to the runtime root. Create `app/.version` containing `0.1.0` followed by a newline. On Windows the configured executable name gains `.exe` automatically.

```text
runtime/
  asm[.exe]
  asm-updater[.exe]
  sm.project.json
  compose.yaml
  app/
    app[.exe]
    .version
```

With Docker available and the ports free, replace the root below with the absolute path to this disposable runtime. These are manual instructions; no live service is started by the test suite.

```sh
./asm --root /absolute/path/to/runtime config validate
./asm --root /absolute/path/to/runtime daemon start
./asm --root /absolute/path/to/runtime start all
curl -f http://127.0.0.1:18080/
./asm --root /absolute/path/to/runtime status
./asm --root /absolute/path/to/runtime stop all
./asm --root /absolute/path/to/runtime daemon stop
```

Run `asm` from the runtime directory, or use its absolute path. The daemon does not start services automatically. `start caddy` includes the app dependency and waits for its health check. A stop does not automatically stop unselected dependencies or dependents; use `stop all` for both. The first daemon start pins the canonical root and id. Do not move a running runtime.

The daemon does not run `compose down`. If needed, remove only this disposable Compose project using the exact namespace shown by `config validate` and its `compose.yaml`. Do not use a global prune. App updates replace the entire `app/` directory; do not keep persistent data or configuration there.
