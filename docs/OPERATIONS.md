# Operations guide

[ Türkçe ](tr/OPERATIONS.md)

This guide covers an existing installation. Use synthetic data to rehearse backup, recovery, and upgrades before using the application for financial records. [Installation](INSTALL.md) · [VPS pilot](../deploy/VPS_PILOT_RUNBOOK.md)

## Data and secrets

- Docker Compose runs the API as `node` with UID `1000`. The named `cost-core-data` volume holds `/data/cost-core.sqlite`. Compose prefixes the actual volume name with the Compose project name. Record the project, volume, source revision, settings source, and the image you run.
- In a native installation, `DB_PATH` identifies the SQLite file. Use a dedicated private directory on local storage and run the API and recovery command as the same user. The API holds a lease on the data directory. Keep a single API process per data directory and leave SQLite sidecars under its control.
- Keep `MASTER_KEY` and `BLIND_INDEX_PEPPER` securely with the installation records. Preserve them across restarts and ordinary upgrades because they protect fields and preserve matching against existing blind indexes. Keep `JWT_SECRET` secure and stable for normal restarts. A change to the JWT key invalidates signed sessions. Remove the one-time `BOOTSTRAP_TOKEN` after onboarding and preserve the other secrets.
- Keep keys, vault files, passwords, rollback copies, reports, and the database out of version control and operational logs. Keep the V2 backup password separately from the vault. Prefer a secret store controlled by the operator. The application reads its process environment.

## Health and access checks

Use `/health` for a liveness check. With the default Compose mapping, the origin is `http://127.0.0.1:18080`. For a local API outside Compose, query the configured API port directly. Verify the main page loads and that an unauthenticated request to `/api/auth/me` returns `401`. Then sign in with a synthetic account, open a project, and compare the report totals with the known sample records.

If the API does not start, check the selected data path and directory ownership, configuration errors, lease errors, and the published port. An active lease can indicate another instance, an offline operation, or the wrong data path. Inspect the existing process and wait until it has stopped. A pending recovery marker calls for the rollback procedure below.

## Export a backup

1. Sign in as an administrator and open **Denetim & Güvenlik → Şifreli Yedek (.tzrvault)**.
2. Select the V2 export and choose a strong independent backup password. V2 expects 12 to 256 UTF-8 bytes. Download the `.tzrvault`, verify it is from the intended deployment, and store it and the password securely in separate locations.
3. Record the source revision, time, V2 version, approximate record counts, and the location of the vault. Verify the export with a recovery rehearsal before relying on it.

V2 covers the supported database schema and includes the financial operation receipts used to prevent duplicate effects. Recovery invalidates existing sessions. Attachment data is outside the supported V2 contract. An attachment reference can block export with `BACKUP_V2_ATTACHMENTS_UNAVAILABLE`, and unsupported relationships can block a vault operation. The browser's legacy V1 import only restores five tables and is unsuitable for a full database recovery. The backup UI contains automatic backup settings. Schedule and verify backups through an operator-managed process.

## Restore or roll back offline

The checked procedure uses the compiled recovery command on Linux or in the existing API image. Run the rehearsal with a disposable target. Before relying on a backup in production, restore it into a separate test installation with an existing synthetic target database and confirm the acceptance checks below.

1. Confirm the target data directory, existing target SQLite file, application revision, backup, and backup password. For the Compose deployment, use the same project name, Compose file, and secure process environment as the target installation. The recovery target directory must meet the command's ownership and privacy checks. `/data` is created with `0700` permissions in the API image.
2. Stop the API and any other process using the target directory. Leave the target database and its SQLite sidecars in place. The command acquires the data-directory lease, validates the vault, and stages a replacement. `DATABASE_IN_USE` means the target is still in use.
3. Supply the target installation's `MASTER_KEY`, `BLIND_INDEX_PEPPER`, and a valid `JWT_SECRET` through its environment. The target keys may differ from the original keys because V2 import rebuilds protected fields and indexes for the target. Supply the password as exact UTF-8 bytes through stdin, without adding a newline. Keep the password outside command arguments and output.
4. For a compiled native Linux installation, run the following example from the source root. Replace the absolute paths and database byte limit with the values for your installation.

   ```sh
   node apps/server/dist/recovery-cli.js restore /data/cost-core.sqlite 268435456 /recovery/backup.vault < /recovery/password
   ```

   For Docker, run the command inside the already-built API image while the API is stopped. The one-shot container must mount the original target volume and a separate, read-only directory holding the vault. Keep the operator password file on the host and feed its contents to stdin. Use the Compose command sequence in the Docker guide. [Compose recovery procedure](../deploy/README.md)

5. Check for `status: restored`, record the reported rollback path, and confirm `markerRemovalSync: confirmed` before resuming operation. If the marker sync is `unconfirmed`, inspect the result and the on-disk state before another restore. The command preserves a verified copy of the previous database, including its committed WAL data.
6. Restart the same API with the target keys and sign in again. Verify that old sessions are rejected, the expected project and totals are present, and **Mühür Doğrulama (SHA-256)** passes. Rehearse a repeated keyed API create using the original key and body, then confirm the balance remains unchanged. Retain the rollback copy until the operator accepts the restored application.

If a failed or interrupted activation leaves a recovery marker, keep the API stopped and run the rollback command against that same database. Use the matching launch context, target volume and limits. This example uses a native Linux shell.

```sh
node apps/server/dist/recovery-cli.js rollback /data/cost-core.sqlite 268435456
```

`rolled-back` confirms the previous database was restored. `no-pending-recovery` means there was no pending recovery marker the command could act on. For an invalid marker, an unknown active database, or sidecars that block recovery, preserve the files and investigate. Restart only after verifying the returned result. Preserve volumes and recovery artifacts until verification is complete.

## Upgrade

1. Record the current source revision or image, Compose project, volume, and secret references. Export and rehearse a V2 backup. Retain a secure pre-upgrade copy through the documented recovery or offline backup procedure.
2. Test the exact new revision on a separate synthetic installation. Check startup migrations, project access, reports, the audit chain, and offline recovery with that revision.
3. Stop the current API, update source or images, and start with the same data directory and keys. Verify health, authorization, balances, exports, and audit integrity.
4. If verification fails, stop the new API. A code rollback alone may leave a newer database schema behind. Use the verified pre-upgrade database and the matching prior application version when a schema rollback is necessary. Recheck the same acceptance signals before resuming use.
