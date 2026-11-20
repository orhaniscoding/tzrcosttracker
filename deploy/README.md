# Local Docker deployment

[Türkçe](../docs/tr/DOCKER.md)

Try TZR Cost Tracker with synthetic data on a local machine. Install Docker Engine or Docker Desktop with the `docker compose` plugin, and install Node.js 24 to use the launcher. On Windows, use Docker Desktop in Linux container mode. Windows and WSL2/Linux have been tested. ARM64 validation used QEMU emulation. Physical macOS and ARM machines remain unverified. [Installation guide](../docs/INSTALL.md)

## Start and stop with the launcher

Run from the repository root. The launcher builds the images and runs Compose in the foreground.

```sh
node scripts/run-docker.mjs up
```

Open the loopback address printed by the launcher. The default is `http://127.0.0.1:18080`. Run the following in a separate private terminal and enter the displayed key in the first-run wizard. The command prints the bootstrap key, so avoid shared terminal logs and screen recordings.

```sh
node scripts/run-docker.mjs setup-key
```

The launcher prints a Compose project name derived from the checkout path. Record that name for recovery. It stores independent keys and the selected port in `.cache/costcore-docker/local.env` and reuses that file on later runs. If the file is missing and the matching volume exists, the launcher stops before generating keys. Keep the env file private and backed up alongside its installation records. Restrict access to its parent directory and file on Windows. Moving the checkout can change the project name, so check the data volume before starting from a different location.

Stop and remove the containers and network while keeping the named data volume:

```sh
node scripts/run-docker.mjs down
```

## Run Compose manually

The API runs as `node` (UID 1000), listens on the Compose network on port `4000`, and stores SQLite under `/data`. nginx serves the web app and forwards `/api/` and `/health` to the API. The web port binds to `127.0.0.1:${WEB_PORT:-18080}`. Compose normally names the persistent `cost-core-data` volume `<project>_cost-core-data`.

Use the manual path when an operator supplies secrets from an existing store. Provide independent, random values of at least 32 characters for `JWT_SECRET`, `MASTER_KEY`, `BLIND_INDEX_PEPPER`, and the first-run `BOOTSTRAP_TOKEN`. Preserve the first three when using the same volume. Keep the keys in the Compose process environment or its private env file, outside Git, build arguments, web configuration, and shared logs.

Choose the same `COSTCORE_COMPOSE_PROJECT` for installation, maintenance, and recovery. Use an explicit empty env file in the operator-managed setup to avoid Compose's implicit `.env` lookup. Create `.cache/compose-empty.env` without overwriting an existing file. Check that the file is regular and empty before proceeding. The following examples require you to put the keys in the current process environment first.

```sh
set -eu
umask 077
mkdir -p .cache
test ! -L .cache/compose-empty.env
touch .cache/compose-empty.env
test -f .cache/compose-empty.env && test ! -s .cache/compose-empty.env || exit 1
docker compose --env-file .cache/compose-empty.env -p "${COSTCORE_COMPOSE_PROJECT:?Set the Compose project name}" config --quiet
docker compose --env-file .cache/compose-empty.env -p "$COSTCORE_COMPOSE_PROJECT" up --build -d --wait
curl -fsS "http://127.0.0.1:${WEB_PORT:-18080}/health"
```

```powershell
New-Item -ItemType Directory -Force .cache | Out-Null
$composeEnvPath = '.cache/compose-empty.env'
if (-not (Test-Path -LiteralPath $composeEnvPath)) {
    New-Item -ItemType File -Path $composeEnvPath | Out-Null
}
$composeEnvFile = Get-Item -LiteralPath $composeEnvPath -Force
if ($composeEnvFile.PSIsContainer -or $composeEnvFile.LinkType -or $composeEnvFile.Length -ne 0) {
    throw 'Use an empty regular Compose environment file.'
}
if (-not $env:COSTCORE_COMPOSE_PROJECT) { throw 'Set the Compose project name.' }
docker compose --env-file $composeEnvPath -p $env:COSTCORE_COMPOSE_PROJECT config --quiet
if ($LASTEXITCODE) { throw 'Compose configuration failed.' }
docker compose --env-file $composeEnvPath -p $env:COSTCORE_COMPOSE_PROJECT up --build -d --wait
if ($LASTEXITCODE) { throw 'Compose startup failed.' }
$webPort = if ($env:WEB_PORT) { $env:WEB_PORT } else { '18080' }
Invoke-RestMethod "http://127.0.0.1:$webPort/health"
```

Enter the supplied `BOOTSTRAP_TOKEN` on first run. The operator can remove it and recreate the API after the first administrator exists. Keep `JWT_SECRET`, `MASTER_KEY`, and `BLIND_INDEX_PEPPER` unchanged. Use `config --quiet` for validation because the full Compose configuration shows secret values. [VPS pilot procedure for removing the bootstrap key](VPS_PILOT_RUNBOOK.md#first-start-with-operator-managed-secrets)

## Compose offline recovery

Rehearse recovery on synthetic data. V1 import restores only five tables. V2 covers 11 tables in the supported database schema. Attachment data is outside the V2 contract. Before changing an image or schema, verify a V2 export, its password, and the previous deployment's keys and image. [Operations guide](../docs/OPERATIONS.md)

Use a POSIX shell on the Docker host or in a WSL2 environment that accesses the same Docker context, checkout, and volume. The examples require an existing Compose project, an existing target database, and a previously built API image. Set `COSTCORE_COMPOSE_PROJECT` to the exact project name and `COSTCORE_COMPOSE_ENV_FILE` to that installation's env file. For a launcher installation, use its printed project name and `.cache/costcore-docker/local.env` in a clean shell without overriding key variables. For a manually managed installation, use its existing project name and explicit empty env file and supply the keys through the Compose process environment. Keep the same Docker context and Compose file throughout.

Before proceeding, confirm the target project and volume. Compose must mount the existing `/data` volume. The `/data` directory must be owned by UID 1000 and allow no group or other access. The image creates it with `0700`. An incompatible existing volume or bind mount causes recovery to stop. Keep the previous database and sidecars in place.

```sh
set -eu
: "${COSTCORE_COMPOSE_PROJECT:?Set the existing Compose project name}"
: "${COSTCORE_COMPOSE_ENV_FILE:?Set the existing Compose environment file}"
test -f "$COSTCORE_COMPOSE_ENV_FILE" || exit 1
costcore_compose() {
  docker compose --env-file "$COSTCORE_COMPOSE_ENV_FILE" -f compose.yaml -p "$COSTCORE_COMPOSE_PROJECT" "$@"
}
docker volume inspect "${COSTCORE_COMPOSE_PROJECT}_cost-core-data" --format '{{.Name}}'
costcore_compose stop api
costcore_compose ps --all api
```

Confirm the API has stopped and no other process uses the database. Set `RECOVERY_DIR` to the absolute host directory containing `backup.vault`. The API user must be able to read this file. Set `RECOVERY_PASSWORD_FILE` to an operator-only host file containing the exact UTF-8 password bytes, without an extra newline. The vault directory is mounted read-only and the password file stays on the host. The recovery command reads the password through stdin and uses the target installation's `MASTER_KEY`, `BLIND_INDEX_PEPPER`, and valid `JWT_SECRET`. The example byte limit also covers SQLite sidecars.

```sh
costcore_compose run --rm --no-deps --pull never -T \
  --volume "${RECOVERY_DIR:?Set the absolute recovery directory}:/recovery:ro" \
  api node apps/server/dist/recovery-cli.js restore \
  /data/cost-core.sqlite 268435456 /recovery/backup.vault \
  < "${RECOVERY_PASSWORD_FILE:?Set the path to the private backup password file}"
```

`DATABASE_IN_USE` means another process still holds the data directory lease. On `restored`, record the returned `rollback` path. The verified previous database copy includes the committed WAL data. If `markerRemovalSync` is `unconfirmed`, inspect the output and target state before retrying because a crash may make the marker reappear. Once the result is confirmed, start the same installation and restart web so nginx resolves any changed API address. Sign in again and verify projects, totals, and audit integrity.

An interrupted restore can leave a pending recovery marker. With the API stopped and the same Compose context, run:

```sh
costcore_compose run --rm --no-deps --pull never -T \
  api node apps/server/dist/recovery-cli.js rollback \
  /data/cost-core.sqlite 268435456 < /dev/null
```

`rolled-back` confirms the previous database was restored. `no-pending-recovery` means the command found no pending marker. If the marker is invalid, the active database is unknown, or a SQLite sidecar blocks recovery, preserve the files and inspect the installation. Keep the named volume and recovery files through verification. Keep `down -v`, volume deletion, and Docker pruning outside this procedure. [VPS pilot runbook](VPS_PILOT_RUNBOOK.md)
