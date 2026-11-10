# Verification and limits

App Service Manager 0.1.0 is experimental. Passing tests and a native build do not establish production readiness.

## Public-name validation

Local validation after the `asm` / `asm-updater` rename on macOS arm64, Bun 1.4.4:

- 192 tests passed, 0 failed, 610 assertions across 15 files.
- Typecheck and frozen dependency installation passed.
- Native builds of `asm`, `asm-updater` and the example app passed.
- Compiled CLI checks and two offline release packs passed.
- Unix and Windows manager task/metadata names are covered offline, including rejection of the old executable names. This is not a Windows runtime test.

## Environment configuration validation

After moving the repository dotenv policy into `bunfig.toml`, local checks on macOS arm64 with Bun 1.4.4 passed without `BUN_OPTIONS`:

- 193 tests passed, including a subprocess check that `bun --eval`, `bun run` and `bun test` ignore fixture dotenv files while preserving explicit process environment variables.
- Typecheck, frozen dependency installation, native builds and compiled CLI / offline pack smoke passed.
- Compiled executables still disable dotenv loading at build time, independently of the repository config.

## Historical baseline

Before the public binary rename, the local suite had **191 passing tests**. A historical live test on macOS arm64 with Bun 1.4.4 exercised a compiled app and a disposable MinIO Compose dependency, including object write/read, app restart and shutdown. It did not verify live release publishing, app update, self-update or rollback. These results precede the public branding changes and are not results of a new run.

## Reproduce the local checks

With Bun 1.4.4, from the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check:types
bun test
bun run build:native
bun run scripts/smoke.ts
```

Tests use temporary fixtures and mocks. The native smoke checks compiled CLI exit codes and fixture filesystem nonmutation, and packs local artifacts offline. It is not a system-call audit and does not prove absence of file reads, network access or spawned processes. The early CLI's deferred-import boundary and instrumented unit tests provide separate coverage for no spawn/network on help, version and config validation.

Native build labels include Linux, macOS and Windows; a label is not proof of live operation on that platform. The public CI configuration builds and tests on Linux and macOS without a live daemon or Docker lifecycle. Consult the actual CI run for its result; a configured job is not a passed job.

Not established: live Caddy, Windows runtime, S3 publication and concurrent publishers, live app/self-update or rollback, crash recovery, production isolation, deployment, or migration. Run any live tests separately, only with permission and disposable resources.
