# Bun + MinIO

This manual example runs a compiled Bun app with MinIO as a separate Compose dependency. It is not a production configuration or an automatic test. A historical live run covered macOS arm64; it did not test the updater or S3 release publishing. The app offers `/health`, `/object` (PUT, GET, DELETE), and `/`. The health endpoint checks MinIO readiness, not credentials or bucket existence.

The app, S3 endpoint and console bind localhost ports **18181**, **19000** and **19001**. Ensure they are free; if changing them, update the manifest, Compose file and runtime config consistently. The example API has no production authentication or rate limiting. MinIO uses a **128 MiB tmpfs**: stopping it destroys its data. The pinned image is an example, not a recommendation for a current production version. `pull_policy: never` requires that exact image to be locally available.

## Prepare a disposable runtime

From the repository root, build the native binaries, then create an empty private runtime. Replace `<platform>` with the native build output directory; these commands use Unix names.

```sh
BUN_OPTIONS=--no-env-file bun run build:native
PLATFORM=darwin-arm64 # Replace with your native build label
TEST_ROOT=$(mktemp -d)
chmod 700 "$TEST_ROOT"
mkdir "$TEST_ROOT/app"
cp dist/"$PLATFORM"/asm "$TEST_ROOT/asm"
cp examples/hello-minio/sm.project.json examples/hello-minio/compose.yaml "$TEST_ROOT/"
cp examples/hello-minio/minio.env.example "$TEST_ROOT/minio.env"
cp examples/hello-minio/runtime-config.example.json "$TEST_ROOT/app/runtime-config.json"
chmod 600 "$TEST_ROOT/minio.env" "$TEST_ROOT/app/runtime-config.json"
BUN_OPTIONS=--no-env-file bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile="$TEST_ROOT/app/app" examples/hello-minio/app/index.ts
```

Replace the credential placeholders in both files with the same newly generated disposable credentials. Never reuse production credentials or commit the runtime. The app reads `runtime-config.json` relative to its process working directory; this manifest sets that directory to `app/`. **App update replaces `app/`**, including this config: this example is not update-safe. A real app should keep runtime data and configuration outside the replaceable directory and accept its location through its own supported configuration or manifest arguments.

## Run and clean up

Use only an authorized Docker context and the disposable root. Do not pass production update credentials to the daemon.

```sh
"$TEST_ROOT/asm" --root "$TEST_ROOT" config validate
"$TEST_ROOT/asm" --root "$TEST_ROOT" daemon start
"$TEST_ROOT/asm" --root "$TEST_ROOT" start app
"$TEST_ROOT/asm" --root "$TEST_ROOT" status
```

`start app` also starts MinIO and waits for readiness. Create bucket `sm-live-test` in this disposable MinIO using its console at `http://127.0.0.1:19001` and the disposable credentials. Then:

```sh
curl -f http://127.0.0.1:18181/health
curl -f -X PUT --data-binary 'Hello from compiled Bun' http://127.0.0.1:18181/object
curl -f http://127.0.0.1:18181/object
"$TEST_ROOT/asm" --root "$TEST_ROOT" restart app
curl -f http://127.0.0.1:18181/object
"$TEST_ROOT/asm" --root "$TEST_ROOT" daemon stop
```

The daemon stops its services but does not run `compose down`. After shutdown, obtain the exact namespace from `config validate` and set `PROJECT_NAMESPACE` to that exact value. Remove **only this disposable project**:

```sh
docker compose --project-name "$PROJECT_NAMESPACE" -f "$TEST_ROOT/compose.yaml" down
```

Use the same Docker context used to start the daemon. Do not prune or touch other projects. Once shutdown and project removal are confirmed, remove the disposable runtime and its credentials. Restarting the app preserves the object only while MinIO remains running; stopping MinIO loses tmpfs data.
