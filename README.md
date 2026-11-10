# App Service Manager

App Service Manager (`asm`) manages compiled Bun applications and explicitly configured Docker Compose services. Version **0.1.0 is experimental**; it is not a production-ready installer or deployment system.

The compiled executables are `asm[.exe]` and `asm-updater[.exe]`. The internal update component key remains `service-manager`; it is not the executable name. Configuration remains `sm.project.json`, and existing `SM_*` environment names are unchanged.

## Build and check

Install Bun 1.4.4. Docker Compose v2 is needed only for Compose services. A compiled application does not require Bun at runtime. There are no GitHub release downloads yet.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check:types
bun test
bun run build:native
bun run scripts/smoke.ts
```

The native builder writes `asm`, `asm-updater` and `app/app` (with `.exe` on Windows) under `dist/<platform>/`. Supported platform labels are `linux-amd64`, `linux-arm64`, `windows-amd64`, `darwin-arm64`, and `darwin-amd64`; the builder builds for the current host, not by cross-compiling. Historical live runtime testing covered macOS arm64 only. See [verification](docs/verification.md) for the limits.

## Quick start

Build first, then prepare a **new, disposable** runtime directory as described in the [Bun + Caddy example](examples/hello-caddy/README.md). That example uses Docker; the [Bun + MinIO example](examples/hello-minio/README.md) is another manual test, not an automatic test. Add the absolute runtime directory containing `asm` and `asm-updater` to your `PATH` once (on Unix: `export PATH="/absolute/path/to/runtime:$PATH"`; on Windows, add it to the user Path). Keep both binaries in the runtime root for self-update. Then run:

```sh
asm --help
asm --version
asm --root /absolute/path/to/runtime config validate
asm --root /absolute/path/to/runtime daemon start
asm --root /absolute/path/to/runtime start all
asm --root /absolute/path/to/runtime status
asm --root /absolute/path/to/runtime logs app
asm --root /absolute/path/to/runtime stop all
asm --root /absolute/path/to/runtime daemon stop
```

Operational commands require an absolute `--root`. Help, version, and config validation do not start the daemon or services. The examples use Unix executable names; on Windows use `.exe`.

## Configuration and safety

`sm.project.json` uses `schemaVersion: 1`. See the example manifests for `id`, services, dependencies and health checks. A `bun` service specifies a relative `cwd` and `executable`, optionally arguments. The reserved `app` update target is `app/app[.exe]`. A `docker-compose` service specifies a Compose file and selected services. Groups are `all`, `apps`, and `infrastructure`. Start includes dependencies and waits for readiness; stop affects selected services in reverse order, not their unselected dependents or dependencies.

The canonical root and project id define the runtime and Compose namespace and are pinned on first daemon start. Separate roots do not allocate separate host ports: choose free ports yourself. Avoid shared Compose `container_name`, external volumes or networks when isolation is required. The manifest, executables, health commands, and Compose files are trusted local input, not a sandbox. Path confinement is not a defense against a malicious process racing filesystem changes.

The daemon owns its child handles; it does not adopt PIDs, free occupied ports or signal unknown processes. Stale PID, startup lock or updater lock/claim requires operator investigation. After a daemon crash an app may remain running. Never kill a process solely because a recorded PID says it belongs to this project. Compose containers and networks may remain after shutdown; clean up only the exact project namespace you own.

## Offline releases and updates

`pack` accepts one already-built executable and creates a new output directory; it does not compile or verify the artifact architecture. One release directory contains one platform.

```sh
asm-updater pack --component app --artifact /absolute/path/to/app --version 0.1.0 --platform darwin-arm64 --out /absolute/path/to/new-app-release
asm-updater pack --component service-manager --artifact /absolute/path/to/asm --version 0.1.0 --platform darwin-arm64 --out /absolute/path/to/new-manager-release
```

Each contains `meta.json` and `<platform>.tar.gz`. The app archive contains only `app[.exe]` and `.version`; the manager archive contains only `asm[.exe]`. Previously prepared manager artifacts and self-update tasks using the old executable names are rejected; rebuild them for this baseline.

To publish, configure `UPDATE_S3_ENDPOINT`, `UPDATE_S3_BUCKET`, `UPDATE_S3_ACCESS_KEY_ID`, and `UPDATE_S3_SECRET_ACCESS_KEY` in the environment. `UPDATE_S3_REGION` defaults to `us-east-1`; override it when your S3 provider requires another signing region. The default channel is `stable`. Automatic checks are off by default (`UPDATE_CHECK_INTERVAL=0`); the interval is in hours. Keep credentials out of the manifest and repository. `bunfig.toml` disables automatic `.env` loading for repository commands. The compiled executables disable it at build time; supply credentials through the process environment.

```sh
asm-updater publish --release /absolute/path/to/new-app-release
asm --root /absolute/path/to/runtime update check
asm --root /absolute/path/to/runtime update app
asm --root /absolute/path/to/runtime update rollback
asm --root /absolute/path/to/runtime update self
```

These are operational commands, not part of the safe checks above. S3 publication is not atomic across objects; use one publisher per version. SHA-256 from the same storage verifies integrity, not authenticity. Live S3 publishing, app update, self-update and rollback require separate validation in an isolated environment. Update `asm-updater` manually as a matched pair with `asm`.

**App update replaces the app directory.** Runtime data and configuration inside it are not preserved. Keep them outside that directory and supply their location through the app's own supported configuration or manifest arguments. Rollback does not roll back external data. On uncertain failure, investigate and recover manually; do not signal unverified PIDs.

There is no systemd installer, automatic credentials bootstrap, TLS provisioning, database migration, or production deployment workflow. See [provenance](docs/provenance.md), [verification](docs/verification.md), and [security](SECURITY.md).

## License

[MIT](LICENSE). Owner approval of this license is not an independent audit of third-party dependency rights.
