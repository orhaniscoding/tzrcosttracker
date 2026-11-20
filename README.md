# TZR Cost Tracker

[Read in Turkish](README.tr.md)

TZR Cost Tracker is a self-hosted web app for tracking project costs, income, cash, bank accounts, and payments. It runs on your own computer or server. Open it in a browser after starting the app with Node.js or Docker Compose.

## Quick start

Install Node.js 24 LTS with npm. Install Docker and the Compose plugin if you prefer the Docker setup. Download the source archive or clone this repository, then open a terminal in the source directory.

```sh
git clone https://github.com/orhaniscoding/tzrcosttracker.git
cd tzrcosttracker
```

| Setup | Command | Open in your browser |
| --- | --- | --- |
| Without Docker | `node scripts/run-local.mjs` | http://127.0.0.1:3000 |
| With Docker | `node scripts/run-docker.mjs` | http://127.0.0.1:18080 |

The first run may take several minutes while it installs dependencies or builds images. The launcher creates independent server keys and tells you how to find your one-time setup token. Use it to create the first administrator in the setup wizard. Keep your keys when restarting or upgrading. [Installation, first run, and troubleshooting](docs/INSTALL.md)

## What you can do

- Track income, expenses, and payments by project, category, and currency.
- View cash and bank balances, record deposits and transfers, and manage counterparties.
- Invite users and assign project access. Use two-factor authentication and review the audit chain.
- View financial reports, export CSV files, and import supported spreadsheets.
- Export a password-protected V2 backup. Rehearse offline recovery with a separate test database. Attachment data is outside the V2 recovery scope.

Try it with synthetic data. Create a project, a category, and a cash account with an opening balance of 1,000 TRY. Record a paid expense of 125.25 TRY from that account. The resulting balance is 874.75 TRY. [User guide](docs/USER-GUIDE.md)

## Documentation

| Guide | English | Türkçe |
| --- | --- | --- |
| Installation and first run | [Install](docs/INSTALL.md) | [Kurulum](docs/tr/INSTALL.md) |
| Projects, expenses, and reports | [User guide](docs/USER-GUIDE.md) | [Kullanıcı kılavuzu](docs/tr/USER-GUIDE.md) |
| HTTP API and examples | [API](docs/API.md) | [API](docs/tr/API.md) |
| Architecture and data model | [Architecture](docs/ARCHITECTURE.md) | [Mimari](docs/tr/ARCHITECTURE.md) |
| Operations, backup, and restore | [Operations](docs/OPERATIONS.md) | [İşletim](docs/tr/OPERATIONS.md) |
| Docker and VPS pilot | [Docker](deploy/README.md) · [Pilot](deploy/VPS_PILOT_RUNBOOK.md) | [Docker](docs/tr/DOCKER.md) · [Pilot](docs/tr/VPS_PILOT_RUNBOOK.md) |
| Contributing, conduct, and security | [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md) | [Katkı](docs/tr/CONTRIBUTING.md) · [Davranış](docs/tr/CODE_OF_CONDUCT.md) · [Güvenlik](docs/tr/SECURITY.md) |

## Project status

This repository contains the V1 source candidate. The platform table in the installation guide records the tested operating systems and installation routes. Review the pilot procedure before storing company data on a publicly reachable server. The server encrypts selected sensitive fields. Protect the SQLite database, backups, and keys separately.

## License and credit

TZR Cost Tracker is licensed under [Apache-2.0](LICENSE). Preserve the attribution to `orhaniscoding` and TZR Cost Tracker in [NOTICE](NOTICE) when redistributing. See [third-party notices](THIRD_PARTY_NOTICES.md) for component licenses.
