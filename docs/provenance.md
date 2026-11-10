# Provenance

App Service Manager was extracted from an application-specific predecessor. Selected runtime, updater and S3 client code and tests were adapted for an explicit project root and manifest. The manifest, shared confinement and identity code, native builder, offline pack command, examples and regression coverage were added or adapted for this standalone baseline. The predecessor's application data, credentials, runtime artifacts and Git history are not part of this repository.

The owner approved publication under the [MIT license](../LICENSE), copyright 2026 Sergey Pastukhov. This approval is not an independent audit of the rights or licenses of all dependencies.

Version 0.1.0 is an experimental baseline. The `service-manager` update component identifier remains part of the on-disk protocol, while the shipped manager binary is `asm`. The updater binary is `asm-updater`. Configuration continues to use `sm.project.json` and existing `SM_*` environment names. Manager artifacts and prepared self-update tasks using the old executable names are rejected; rebuild them for this baseline.
