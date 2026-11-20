# AddKasa component browser regression

Run from apps/web with Node.js, existing fixture dependencies including Vite/esbuild, built web CSS assets, and an existing Playwright installation and browser:

    node test/browser/add-kasa.browser.cjs --fixture-root ABS_REPO_ROOT --assets ABS_BUILT_WEB_ASSETS --output ABS_QA_OUTPUT [--playwright-modules ABS_NODE_MODULES] [--browser-executable ABS_BROWSER_EXE]

The output path is required, absolute, unique and must not exist; its parent must already exist. Use a directory outside source, dist, assets and test scripts. Bundle, screenshots, result or failure details are written only there. Fixture root defaults to the repository containing this script; assets default to its apps/web/dist/assets. All supplied paths must be absolute. The optional Playwright modules path is an existing node_modules directory containing Playwright; otherwise normal Node resolution is used. The optional browser executable selects an existing browser; otherwise Playwright uses its existing installed Chromium. Nothing is installed or downloaded.

The real AddKasaModal is bundled with only its theme hook shimmed. A route-only synthetic document uses no server, port, API or authentication. This is not full App, HTTP, installation, restore or pilot evidence.

Invalid textual numbers use a public DOM input-type seam because native number inputs sanitize them. Exact expected native parsing warnings are recorded separately only during that seam; other warnings and runtime errors fail the test. No React private internals are accessed.

## V2 backup browser regression

From `apps/web`, use the installed Playwright and browser to exercise the backup view and its API client.

    node test/browser/backup-v2.browser.cjs ABS_PLAYWRIGHT_NODE_MODULES ABS_BROWSER_EXE [ABS_SCREENSHOT]

The test serves a synthetic response within the browser session. It checks the V2-only interface and offline restore instructions, the UTF-8 limit, the outgoing JSON, the downloaded filename and bytes, and the success notice. The server suite in `apps/server/test/backup-access-api.test.ts` separately opens a real encrypted backup of an in-memory database.
