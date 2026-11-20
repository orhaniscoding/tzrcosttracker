# Installation and first run

[Türkçe](tr/INSTALL.md) · [Project home](../README.md)

## Choose a setup

Use a local synthetic installation to try the app. Both methods run the interface in a browser and keep the data on the host. They use separate databases and keys. Install Node.js 24 LTS with npm, then extract the source distribution or clone the repository and open a terminal at its root.

| Host | Without Docker | With Docker |
| --- | --- | --- |
| Windows x64 | Run from PowerShell with native Node.js. | Use Docker Desktop in Linux container mode. |
| Linux x64 or WSL2 | Run from a Linux shell with Linux Node.js. | Use Docker Engine and Compose. |
| macOS | Node.js and npm are required. Physical macOS testing is pending. | Use Docker Desktop and Compose. Physical macOS testing is pending. |

Native dependencies must match the Node version and host architecture. Install separately when switching between Windows and WSL. If SQLite cannot find a compatible binary and compiles from source, follow the platform build requirements in the build output. Native macOS and physical ARM hardware are outside the verified platform matrix.

## Start without Docker

```sh
node scripts/run-local.mjs
```

The launcher installs pinned dependencies with pnpm through npm, rebuilds native dependencies, and builds the application. The first run needs network access for downloads. The Fastify API uses port `4000` and the browser interface uses port `3000`. Both bind to `127.0.0.1`. Wait for `Open http://127.0.0.1:3000`, then open that address.

The launcher keeps `cost-core.sqlite` and the `.env` key file under `.tzr-cost-tracker/local` in your home directory. Set `COSTCORE_DATA_DIR` to a private directory before launch for an independent test installation. For Windows, place the directory under your user profile and ensure only trusted accounts can read it. Leave the same data directory and keys in place on restart. Stop the launcher with Ctrl+C. This launch mode is for local use. For internet deployment, complete the [VPS pilot](../deploy/VPS_PILOT_RUNBOOK.md).

## Start with Docker

Confirm Docker is running and `docker compose version` responds. Run the launcher from the root:

```sh
node scripts/run-docker.mjs
```

Open `http://127.0.0.1:18080` after the containers are healthy. The API port stays internal. The launcher creates a separate Compose project for this checkout and uses `.cache/costcore-docker/local.env` for its keys and port. SQLite is stored in that project's named volume. Keep the key file with a secure backup and record the displayed Compose project name before moving the checkout. If port 18080 is busy, set `WEB_PORT` before the first launch or change the `WEB_PORT` setting in the key file. Reuse this checkout and the same Docker context on restart.

For a stopped environment, run `node scripts/run-docker.mjs` again. Ctrl+C stops the foreground Compose run. The following command removes its containers and retains the database volume.

```sh
node scripts/run-docker.mjs down
```

## Create the administrator

1. Open the setup page at the URL for your installation. Choose English or Turkish from the language selector.
2. Enter the organization and base currency. You can also name the first project.
3. Create the administrator with a strong password and personal four-digit screen unlock PIN. There are no preset sign-in credentials.
4. Enter the `BOOTSTRAP_TOKEN` from the key file named by the native launcher, or use `node scripts/run-docker.mjs setup-key` in a private terminal. Keep the token out of shared transcripts. Choose an industry template and finish setup.
5. Continue with the [user guide](USER-GUIDE.md). Verify `/health` on your web URL and exercise reports and backup with synthetic data before use.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `node` or `npm` missing | Verify Node.js 24 LTS and npm on the same shell `PATH`. |
| Dependency install or build stops | Read the first error. Check registry access and local disk space. Verify that the active Node and native packages match your host. Restart with the same lockfile. |
| Port already in use | Stop the process listening on the required loopback port or choose another Docker web port. |
| Setup token missing or rejected | Use the token generated for the running installation. The setup route closes once initialization succeeds. |
| Key file missing for existing data | Recover the original secrets from your secure copy before starting. |
| Database lease or recovery marker | Stop the other process or follow the [offline recovery instructions](OPERATIONS.md). Keep the database and SQLite sidecars together. |

See [Docker and operator configuration](../deploy/README.md) for manual Compose and additional administration options.
