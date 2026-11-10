# Contributing

App Service Manager is experimental. Please describe the problem and intended scope before a substantial change. Keep manifests and examples generic; do not include real credentials, runtime data, logs or private paths.

Use Bun 1.4.4. From the repository root:

```sh
BUN_OPTIONS=--no-env-file bun install --frozen-lockfile --ignore-scripts
BUN_OPTIONS=--no-env-file bun run check:types
BUN_OPTIONS=--no-env-file bun test
BUN_OPTIONS=--no-env-file bun run build:native
BUN_OPTIONS=--no-env-file bun run scripts/smoke.ts
```

Tests should use temporary fixtures and mocks. Do not run live Docker, a daemon, S3 publishing or updates against existing resources as routine checks. For a manual test, use an isolated runtime and clean up only resources created for it. Keep help, version and config validation free of environment loading, network, IPC and process spawning. Preserve root confinement and never signal unknown processes.

Explain behavior changes and validation in the pull request. Contributions are provided under the repository's [MIT license](LICENSE).
