# Security policy

[Türkçe](docs/tr/SECURITY.md)

## Report a vulnerability privately

Sign in to GitHub and use **Security → Report a vulnerability** for TZR Cost Tracker. This opens a private report for the maintainer. [Open a private report](https://github.com/orhaniscoding/tzrcosttracker/security/advisories/new)

Include the affected version or commit, the deployment mode, a minimal description using synthetic data, and what changed across an access or data boundary. Include expected behavior, observed behavior, and estimated impact. Test only systems you own or have explicit permission to test.

Keep vulnerability details private while the maintainer investigates. Redact credentials, tokens, private keys, personal or financial data, and live host details. Keep databases, backups, invoices, and reports out of the submission. If the reporting form is unavailable, open an issue requesting a private contact channel and leave the details for that channel.

## Scope and security properties

The source candidate covers the browser client, Fastify API, local SQLite storage, and offline vault restore. Report defects that affect session revocation, role enforcement, project access, financial mutation integrity, input bounds, protected fields, backup validation, or recovery. Sensitive server operations should enforce current user and project permissions. Restore should validate the vault and hold the target data-directory lease before activation.

The server encrypts selected fields and can decrypt them with its keys. Protect the server, keys, database, backups, and browser sessions according to the deployment. V2 recovery covers the documented database schema and its supported relationships. Rehearse recovery and validate the HTTPS deployment with synthetic data before importing real financial records. [Architecture](docs/ARCHITECTURE.md) · [Operations](docs/OPERATIONS.md)

## Supported releases

This repository currently publishes a source candidate. Identify the revision you tested. A security response time and supported release period have yet to be established.
