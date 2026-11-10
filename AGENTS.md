# App Service Manager

- Public documentation is in English. Use Bun for TypeScript, tests and builds.
- Start with README.md, docs/provenance.md and docs/verification.md. Code defines implementation.
- CLI binaries: asm[.exe], asm-updater[.exe]. The internal release component remains service-manager.
- Configuration: sm.project.json, explicit absolute --root. Do not add production paths, secrets or hardcoded services.
- Shared identity and path confinement live in packages/project. Never adopt unknown PIDs, kill ports or signal unowned processes.
- Keep help, version and config validation independent of daemon, network and dotenv loading.
- Checks: bun test; bun run check:types; bun run build:native; bun run scripts/smoke.ts.
- Live daemon/Docker/updater/S3/deploy operations require explicit approval. Normal tests use mocks and disposable fixtures.
- Never commit runtime data, credentials, local evidence, dist or node_modules. Review the exact staged tree before publication.
- MIT applies to this project. Keep third-party notices; dependencies retain their licenses.
- Before commits, inspect git status and git diff; stage task files explicitly. Do not force-push. Include Prime-Session trailer when the real session ID is available.
