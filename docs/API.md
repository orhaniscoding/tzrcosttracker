# API reference

[Turkish version](tr/API.md)

This document describes the HTTP surface shipped in the source candidate. The API is a Fastify application. In the Docker stack, the browser and API share the web origin; the API is reached through `/api/*` and `/health`. In a no-Docker development run, the server listens on `127.0.0.1:4000` by default.

## Authentication and common rules

Most API routes require `Authorization: Bearer <jwt>`. A token is accepted only while its database session is active, unexpired, and attached to an active user. A pending two-factor token cannot call protected routes. The server re-reads the user role and project scope for protected mutations and sensitive reads, so a stale JWT does not grant continuing access after a role, membership, or session change.

The supported roles are `admin`, `manager`, `accountant`, `auditor`, and `viewer`.

- `admin` can manage users, projects, memberships, categories, parties, settings, audit verification, and backups, subject to fresh-session checks.
- `manager` and `accountant` can perform the financial mutations allowed by the route and their project scope.
- `auditor` and `viewer` are read-only. They may still manage their own permitted session, PIN, or two-factor actions, and may call the duplicate-check helper.
- Project membership limits reads and writes. An administrator may have consolidated access; other roles see the projects and records authorized for them.

## Error and status conventions

Successful reads normally return `200`. Creates return `201`; idempotent or membership changes commonly return `200`. The response body is JSON unless the endpoint is a CSV or vault download.

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, schema, path ID, date filter, import source, or other request data. |
| `401` | Missing, expired, revoked, malformed, or otherwise invalid session (`code: SESSION_INVALID` is used by the auth hook). |
| `403` | The authenticated role or project scope does not permit the operation. Registration and the retired legacy import path also return `403`. |
| `404` | A requested record is not found or is outside the caller's permitted scope. |
| `409` | A state conflict such as duplicate identity, duplicate idempotency key with a different body, category cycle, immutable currency, active database use during recovery, or already-enabled 2FA. |
| `413` | An import body or source exceeds the bounded request limit. |
| `429` | Login, PIN, or two-factor rate limit. Honor `Retry-After`. |
| `500` | Unexpected server or storage failure. Do not retry a financial mutation blindly; use its idempotency key and inspect the result. |

Error objects generally contain `error`; some include a stable `code` and validation `details`. Error text is currently localized to the Turkish product UI; clients should branch on status and stable codes where available.

## Public system routes

| Method and path | Auth | Purpose and response |
| --- | --- | --- |
| `GET /health` | None | Liveness check. Returns `{ status: "ok", timestamp }`. |
| `GET /api/system/status` | None | Reports whether first-run setup is required and the current setup state. |
| `GET /api/system/templates` | None | Returns the built-in setup/import templates used by the web onboarding flow. |
| `POST /api/system/setup` | Setup token | Creates the first administrator during an uninitialized deployment. Send the bootstrap value in `X-Setup-Token`; normal login is disabled until setup completes. |
| `POST /api/auth/register` | Disabled | Public self-registration is intentionally disabled and returns `403`. Create later users as an administrator. |
| `GET /api/settings/white-label` | None | Reads public branding values used to render the shell. It does not expose secrets. |

The setup endpoint is a one-time bootstrap path. Keep `BOOTSTRAP_TOKEN` only in the server process environment, use it once, and remove it after the first administrator has been created.

## Authentication, users, sessions, and 2FA

| Method and path | Auth/role | Purpose |
| --- | --- | --- |
| `POST /api/auth/login` | None | Accepts `usernameOrEmail`, `password`, and an optional TOTP or recovery code. A TOTP-enabled account first receives a short-lived challenge response; submit the second factor to complete login. |
| `POST /api/auth/2fa/setup` | Authenticated | Starts a TOTP enrollment for the current user. Rate limited; the enrollment is bound to the active session. |
| `POST /api/auth/2fa/enable` | Authenticated | Confirms the enrollment code and atomically enables TOTP, returning one-time recovery codes. Store them offline. |
| `GET /api/auth/me` | Authenticated | Returns the current user's public identity, role, active state, PIN state, and 2FA state. |
| `GET /api/auth/users` | Fresh admin | Lists users for administration. |
| `POST /api/auth/users` | Fresh admin | Creates a managed user with a role and password/PIN policy. |
| `POST /api/auth/logout` | Authenticated | Revokes the current session. |
| `POST /api/auth/logout-all` | Authenticated | Revokes all sessions for the current user. |
| `POST /api/auth/users/:id/revoke-sessions` | Fresh admin | Revokes all sessions for the target user. |
| `POST /api/auth/switch-pin` | Authenticated | Enables or switches the current user's quick PIN, subject to the PIN rate limit and policy. |
| `POST /api/auth/set-pin` | Authenticated | Sets the current user's PIN after the required password/session checks. |

Passwords are verified server-side. Never put passwords, TOTP secrets, recovery codes, JWTs, or backup passwords in URLs, source control, client logs, or issue reports.

## Projects and memberships

| Method and path | Auth/role | Purpose |
| --- | --- | --- |
| `GET /api/projects` | Authenticated | Lists the projects visible to the caller, including the consolidated view where authorized. |
| `POST /api/projects` | Fresh admin | Creates a project. |
| `GET /api/projects/:id/members` | Fresh admin | Lists users assigned to a project. |
| `PUT /api/projects/:id/members/:userId` | Fresh admin | Adds or updates a project membership. |
| `DELETE /api/projects/:id/members/:userId` | Fresh admin | Removes a project membership. |

Membership changes are checked in a fresh transaction. A removed member may keep a signed JWT, but subsequent protected requests are re-evaluated against current membership and fail or lose scope.

## Parties, accounts, categories, and custom fields

| Method and path | Auth/role | Purpose |
| --- | --- | --- |
| `GET /api/parties` | Authenticated | Lists parties/counterparties within the caller's scope. |
| `POST /api/parties` | Fresh admin | Creates a party such as a supplier, subcontractor, partner, person, or client. |
| `DELETE /api/parties/:id` | Fresh admin | Deletes a party when domain constraints allow it. |
| `GET /api/accounts` | Authenticated | Lists cash, bank, POS, credit-card, and other accounts in scope. |
| `POST /api/accounts` | Fresh writable role | Creates an account. Account currency becomes immutable once financial records use it. |
| `POST /api/accounts/transfer` | Fresh writable role | Moves money between eligible accounts in one financial operation. |
| `GET /api/accounts/liquidity/summary` | Authenticated | Returns the scoped liquidity summary. |
| `GET /api/accounts/:id` | Authenticated | Reads one account when it is in scope. |
| `PUT /api/accounts/:id` | Fresh writable role; some changes admin-only | Updates permitted account metadata. Currency and fields used by existing records cannot be changed. |
| `DELETE /api/accounts/:id` | Fresh writable role | Deletes an account when no protected financial dependency prevents it. |
| `GET /api/categories` | Authenticated | Lists the category tree visible to the caller. |
| `GET /api/categories/:id` | Authenticated | Reads one category in scope. |
| `POST /api/categories` | Fresh admin | Creates a category. |
| `PUT /api/categories/:id` | Fresh admin | Updates a category. Cycles are rejected with `409`. |
| `DELETE /api/categories/:id` | Fresh admin | Deletes a category when references permit it. |
| `GET /api/custom-fields` | Authenticated | Lists custom-field definitions. |
| `POST /api/custom-fields` | Fresh admin | Adds a custom-field definition. |
| `GET /api/settings/white-label` | None | Reads public branding defaults. |
| `PUT /api/settings/white-label` | Fresh admin | Updates the allowed branding fields. It does not change security keys or account data. |

## Transactions and financial effects

| Method and path | Auth/role | Purpose |
| --- | --- | --- |
| `POST /api/transactions/check-duplicate` | Authenticated | Checks likely duplicate financial input before creation. It does not create or mutate a transaction. |
| `GET /api/transactions` | Authenticated | Lists scoped transactions; use the supported query filters from the shared schemas. |
| `POST /api/transactions` | Fresh writable role | Creates an expense, income, or transfer. Send a UUID v4 `Idempotency-Key` for retry-safe creation. |
| `GET /api/transactions/trash` | Authenticated | Lists deleted transactions visible to the caller. |
| `GET /api/transactions/:id` | Authenticated | Reads one transaction in scope. |
| `PUT /api/transactions/:id` | Fresh writable role | Updates mutable fields while preserving immutable identity, audit, and financial invariants. |
| `DELETE /api/transactions/:id` | Fresh writable role | Soft-deletes a transaction and records the financial effect/audit change. |
| `DELETE /api/transactions/:id/permanent` | Fresh admin | Permanently deletes a trash entry only when domain constraints allow it. |
| `POST /api/transactions/:id/restore` | Fresh writable role | Restores a soft-deleted transaction and its linked effects when valid. |
| `POST /api/transactions/:id/mark-paid` | Fresh writable role | Marks an eligible transaction paid and applies the guarded payment effect. |

For a retried create, reuse the same authenticated user, exact request body, and exact `Idempotency-Key`. Reusing a key with different content returns a conflict. A timeout is not proof that a debit failed; read the transaction and audit state before retrying.

## Reports and audit

| Method and path | Auth/role | Purpose |
| --- | --- | --- |
| `GET /api/reports/balance` | Authenticated | Returns scoped balance data. Supports the validated date and project filters. |
| `GET /api/reports/summary` | Authenticated | Returns scoped financial summary data. |
| `GET /api/reports/export/csv` | Authenticated | Streams a scoped CSV report. Treat the response as financial data and store it securely. |
| `GET /api/audit` | Fresh admin | Lists audit events. |
| `GET /api/audit/verify` | Fresh admin | Verifies the audit chain and reports whether the chain is intact. |

Report filters use ISO dates or timestamps accepted by the route validator. An invalid range, unknown project, or out-of-scope project is rejected rather than silently widened.

## Import

| Method and path | Auth/role | Purpose |
| --- | --- | --- |
| `POST /api/import/analyze` | Fresh admin | Reads a bounded workbook/source, validates sheet limits, and returns a preview/mapping result. |
| `POST /api/import/execute` | Fresh admin | Executes a validated import using bounded input and the selected mapping. |
| `POST /api/import/karaelmas` | Authenticated | Retired legacy path; returns `403` and directs clients to the file-upload flow. |

Import requests are size- and workbook-bounded. Use synthetic workbooks first and compare the preview with the source before executing. The API does not claim compatibility with every external spreadsheet provider.

## Backups and offline recovery

| Method and path | Auth/role | Purpose |
| --- | --- | --- |
| `POST /api/backup/export` | Authenticated; backup permission enforced | Exports the legacy partial backup format. Use V2 for a complete supported database export. |
| `POST /api/backup/import` | Authenticated; backup permission enforced | Imports the supported legacy format under its validation rules. |
| `POST /api/backup/export-v2` | Fresh admin | Creates a password-protected V2 vault. The password is sent in the request body; use HTTPS and do not log it. |

V2 restore is deliberately offline. Run the compiled `recovery-cli.js` with an absolute database path, a byte limit, and an absolute vault path. Provide the backup password through stdin. Stop the API first, verify the target volume and SQLite sidecars, and retain the rollback copy reported by the command. See [the operations guide](OPERATIONS.md) and [the install guide](INSTALL.md).

## Source of truth

Request and response shapes are defined by the shared Zod schemas in `packages/types/src/index.ts` and by the route implementations under `apps/server/src/routes/`. This reference documents the stable surface and security semantics; it is not a generated OpenAPI schema.
