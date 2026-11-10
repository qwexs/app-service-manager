# Verification and limits

App Service Manager 0.2.0 is experimental. Passing tests and a native build do not establish production readiness.

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

## Directory release coverage

Offline fixture coverage includes directory packaging with a custom executable and web assets, generated version markers, archive byte determinism, omission of root `.env`, rejection of extra source entries and symlinks, metadata/archive tampering, and CLI option exclusivity. The existing single-binary packaging tests remain part of the suite. These fixtures do not establish a live application update, rollback, S3 publication, Windows runtime, or Mascotte deployment result.

On November 10, 2026, the 0.2.0 Linux x64 tree passed all 203 tests (663 assertions), TypeScript checking, native builds, and the existing compiled CLI/offline pack smoke.

The consuming Mascotte integration additionally ran native `asm` and `asm-updater` with a compiled application, a disposable runtime and an owned loopback S3 protocol fixture. Real CLI publish/install/rollback went through IPC; all 17 release members matched, stale assets disappeared, runtime `.env` remained private and unchanged, and edits made after update survived rollback. The original HTML was served again after rollback. Children ran without Bun in PATH and fixture processes/files were cleaned up. This proves the local Linux integration, not an external S3 service, VM deployment, self-update, Windows runtime, or crash recovery.

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

Not established: live Caddy, Windows runtime, external S3 publication and concurrent publishers, external-service application updates, self-update, crash recovery, production isolation, VM deployment, or migration. Run any live tests separately, only with permission and disposable resources.
