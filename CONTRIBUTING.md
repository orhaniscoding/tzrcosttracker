# Contributing to TZR Cost Tracker

[Türkçe](docs/tr/CONTRIBUTING.md)

Use a clean checkout and synthetic records to build and verify changes. See the [installation guide](docs/INSTALL.md) for native SQLite build prerequisites and the [Docker guide](deploy/README.md) for the container workflow.

## Run the checks

Use Node.js 24 and pnpm 12.16.1. Run these commands from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm -r rebuild
pnpm exec turbo run test build --force
```

The Linux CI job runs these checks. State the operating systems and runtimes you tested, including whether a Linux run used WSL. For financial calculations, authorization, migrations, or recovery, describe the negative cases and rollback checks you ran.

## Open a pull request

1. Fork the repository and create a focused branch. Describe the problem, the intended behavior, and the checks you ran. Update the English and Turkish documentation together when behavior changes.
2. Open a pull request against `main`. A maintainer must approve Actions runs from outside contributors on fork pull requests before CI starts.
3. Update the branch against `main`, wait for the required `build-test` check to pass, and resolve review conversations before merging. The [main ruleset](https://github.com/orhaniscoding/tzrcosttracker/rules/27718371) requires pull requests and squash merges and blocks force pushes and deletion. The current approval threshold is zero for the single-maintainer repository. The required check and conversation rule apply to maintainers as well.

Use synthetic, isolated databases and fixtures in tests. Keep company and customer data, invoices, reports, passwords, keys, environment files, SQLite files and sidecars, and agent logs out of contributions. Report vulnerabilities through the [security policy](SECURITY.md).

Submit only work you have the right to contribute under [Apache-2.0](LICENSE). Preserve the copyright and license of third-party code and explain new dependencies. See [NOTICE](NOTICE), [third-party notices](THIRD_PARTY_NOTICES.md), and the [code of conduct](CODE_OF_CONDUCT.md).
