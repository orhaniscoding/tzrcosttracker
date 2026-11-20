# Third-Party Notices

TZR Cost Tracker is distributed under Apache-2.0. Runtime and build dependencies
remain under their own licenses. The package manager installs the exact versions
recorded by `pnpm-lock.yaml`; this document records the upstream attribution that
was checked for the production dependency tree.

## Packages with upstream license files or notices

The installed production tree contains packages declared as MIT, ISC, BSD-3-Clause,
Apache-2.0, and the composite expression `MIT AND ISC AND BSD-3-Clause`. Their
package metadata and top-level license files remain in the package-manager cache and
installed dependency tree; this repository does not vendor `node_modules`.

## Checked upstream attribution

- `abstract-logging@2.0.1` — MIT. Upstream tag `v2.0.1`, commit
  `80dfaef91ee87008f4ed2b6e78921d383bccd406`. The upstream README identifies the
  MIT License at <http://jsumners.mit-license.org/>.
- `drizzle-orm@0.45.4` — Apache-2.0. Upstream tag `0.45.4`, commit
  `eab8bedbb65d5429c54e612ddbd88aa23091d398`. The upstream `LICENSE` file is
  Apache License 2.0; its SHA-256 is recorded in the release QA inventory.

When publishing an object bundle that includes third-party package files, preserve
each package's own license and attribution files. This source release does not
include installed dependency files, package caches, or generated bundles.
