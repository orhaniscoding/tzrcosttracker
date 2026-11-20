# VPS pilot runbook

[Türkçe](../docs/tr/VPS_PILOT_RUNBOOK.md)

Use this checklist to test the exact self-hosted deployment with synthetic records before moving company data. The operator manages the VPS, domain, firewall, TLS certificate, secret store, and recovery assets.

## Pilot prerequisites

1. Verify the Linux environment, Docker Engine, and Compose plugin on the target VPS. The pilot uses Linux containers.
2. Point the domain's A or AAAA records at the intended endpoint and verify DNS resolution. Allow HTTPS and the required management connections. Open port 80 if the certificate-validation or redirect setup needs it.
3. Bind Compose web to `127.0.0.1:${WEB_PORT:-18080}` and forward to it from the external HTTPS proxy. The API stays on the Compose network. nginx routes `/api/` and `/health` to the API. Keep the TLS certificate and key in the proxy's protected store.
4. Store `JWT_SECRET`, `MASTER_KEY`, `BLIND_INDEX_PEPPER`, and the first-run `BOOTSTRAP_TOKEN` in the operator's secret store. Pass them to the Compose process. Restrict Docker access and process inspection to the operators who need them. Keep the values out of Git, terminal history, logs, and image layers.
5. Record the tested source revision or image identifier, existing Compose project name, volume, and secret references. Reuse the project name and volume for maintenance and recovery. For a local rehearsal, the launcher prints a checkout-specific project name and uses `.cache/costcore-docker/local.env`. [Local Docker guide](README.md)

## First start with operator-managed secrets

Run the commands from the repository root. Set `COSTCORE_COMPOSE_PROJECT` to the project name selected for this deployment. Supply the secrets in the process environment and use an explicit empty env file to avoid Compose's implicit `.env` lookup. Use the first `up` in a new installation. Follow the upgrade procedure below before updating an existing installation.

```sh
set -eu
umask 077
mkdir -p .cache
test ! -L .cache/compose-empty.env
touch .cache/compose-empty.env
test -f .cache/compose-empty.env && test ! -s .cache/compose-empty.env || exit 1
: "${COSTCORE_COMPOSE_PROJECT:?Set the Compose project name}"
: "${JWT_SECRET:?Set JWT_SECRET in the process environment}"
: "${MASTER_KEY:?Set MASTER_KEY in the process environment}"
: "${BLIND_INDEX_PEPPER:?Set BLIND_INDEX_PEPPER in the process environment}"
: "${BOOTSTRAP_TOKEN:?Set BOOTSTRAP_TOKEN for first setup}"
costcore_compose() {
  docker compose --env-file .cache/compose-empty.env -f compose.yaml -p "$COSTCORE_COMPOSE_PROJECT" "$@"
}
costcore_compose config --quiet
costcore_compose build
costcore_compose up -d --wait
costcore_compose ps
curl -fsS "http://127.0.0.1:${WEB_PORT:-18080}/health"
```

Open the setup wizard and enter the bootstrap key to create the first administrator. Remove `BOOTSTRAP_TOKEN` from the secret provider after setup. In the same Compose context, remove it from the shell and recreate the API so the running container no longer carries it. Restart web so nginx resolves the API address again. Preserve the JWT and encryption keys and the data volume.

```sh
unset BOOTSTRAP_TOKEN
costcore_compose up -d --no-deps --force-recreate --wait api
costcore_compose restart web
curl -fsS "http://127.0.0.1:${WEB_PORT:-18080}/health"
```

Sign in again and confirm the expected project opens.

## HTTPS reverse proxy

- Route the HTTPS origin to the selected loopback port. Keep the application port off the public interface.
- Derive `Host` and forwarding information from the proxy's connection and configuration. Fastify does not use forwarded headers to trust the caller's identity. Check how several users behind the same proxy address share the login rate limit.
- Use TLS 1.2 or newer, certificate renewal, and restricted private-key permissions. Verify HTTP redirects to HTTPS.
- Align `/api/` body and timeout limits with the application, including the limits for import and backup. Use the HTTP proxying needed to serve the app.
- Expose only the necessary liveness information. Protected routes still require the expected authentication and authorization through the proxy.

## Pilot acceptance checklist

- [ ] DNS reaches the intended VPS. HTTPS validates and renewal is configured. HTTP redirects to HTTPS.
- [ ] The application port is unreachable from the public interface. The HTTPS origin serves the HTML and `/health`.
- [ ] An unauthenticated `/api/auth/me` request returns `401`.
- [ ] Synthetic onboarding, sign-in, a project read, and a known financial transaction succeed.
- [ ] The operator exports a V2 vault and stores its password separately.
- [ ] Recovery against an in-use disposable target returns `DATABASE_IN_USE`. Offline restore with the target keys succeeds and produces a verified rollback copy.
- [ ] After restore, the operator signs in again, verifies that old sessions are rejected, checks the audit chain, and reconciles the sample totals. Replaying the original keyed create leaves the debit unchanged.
- [ ] Access, backup, and restore logs are free of secrets and financial data. The operator verifies the rollback copy and key backup before accepting this deployment for real data.

## Upgrade and recovery

Before an upgrade, record the current image and volume and verify the V2 backup and its password. Test the exact new revision on a separate synthetic installation. Stop the API and verify the target volume before restoring. Supply the password through stdin and preserve the existing volume and all SQLite sidecars. [Compose offline recovery procedure](README.md#compose-offline-recovery) · [Operations guide](../docs/OPERATIONS.md)

After an interruption, run the recovery command against the same target and verify its result before restarting. Recheck sign-in, the audit chain, and totals after a rollback. If a schema changed, use the verified previous database with the matching earlier application revision.
