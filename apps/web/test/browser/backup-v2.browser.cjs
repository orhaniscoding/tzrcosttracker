const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

// Uses an installed Playwright and browser. No application server or real data.
const [modules, executablePath, screenshot] = process.argv.slice(2);
const web = path.resolve(__dirname, '../..');
const webRequire = createRequire(path.join(web, 'package.json'));
const origin = 'http://tzrcosttracker-backup.test';
const filename = 'TZRCoster_Tam_Yedek_2026-01-01_v2.tzrvault';
const vaultData = 'TZRVAULT:v2:synthetic-browser-response';

async function run() {
  if (!modules || !executablePath || ![modules, executablePath, screenshot].filter(Boolean).every(path.isAbsolute)) {
    throw new Error('Usage: node backup-v2.browser.cjs ABS_PLAYWRIGHT_NODE_MODULES ABS_BROWSER_EXE [ABS_SCREENSHOT]');
  }
  const { chromium } = createRequire(path.join(modules, '__backup_browser__.cjs'))('playwright');
  const esbuild = createRequire(webRequire.resolve('vite'))('esbuild');
  const bundle = await esbuild.build({
    stdin: {
      contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { BackupCenterView } from './src/components/BackupCenterView.tsx';
        createRoot(document.getElementById('root')).render(
          <BackupCenterView onRestored={async () => {}} />
        );`,
      resolveDir: web,
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    write: false,
  });
  const html = '<!doctype html><html lang="tr"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Cost Tracker backup QA</title><link rel="icon" href="data:,">' +
    '<div id="root"></div><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>';
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const errors = [], unexpected = [], requests = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (request.url() === `${origin}/` && request.isNavigationRequest()) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      }
      if (request.url() === `${origin}/api/backup/export-v2`) {
        requests.push({ method: request.method(), body: request.postDataJSON() });
        return route.fulfill({ json: { success: true, filename, vaultData, manifest: { totalRows: 3 } } });
      }
      unexpected.push(request.url());
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) errors.push(message.text());
    });
    await page.goto(`${origin}/`);
    assert.equal(page.url(), `${origin}/`);
    assert.equal(await page.title(), 'Cost Tracker backup QA');
    const legacy = page.getByPlaceholder('En az 6 karakterli güçlü parola...', { exact: true });
    const v2 = page.getByLabel('V2 yedek parolası', { exact: true });
    const downloadButton = page.getByRole('button', { name: 'Tam Sistem Yedeği V2 İndir', exact: true });
    await page.getByText('V1 Biçimindeki Yedeği Kısmi Geri Yükle', { exact: true }).waitFor();
    await legacy.fill('synthetic-legacy-password');
    assert.equal(await downloadButton.isEnabled(), false, 'V1 input must not enable V2');
    await v2.fill('12345678901');
    assert.equal(await downloadButton.isEnabled(), false, '11 bytes must be rejected');
    await v2.fill('ç'.repeat(129));
    assert.equal(await downloadButton.isEnabled(), false, '258 bytes must be rejected');
    const password = 'ç'.repeat(6);
    await v2.fill(password);
    assert.equal(await downloadButton.isEnabled(), true, 'A 12-byte V2 password must enable the download');
    assert.equal(await legacy.inputValue(), 'synthetic-legacy-password');
    assert.equal(requests.length, 0);

    const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
    assert.equal(download.suggestedFilename(), filename);
    assert.equal(await fs.readFile(await download.path(), 'utf8'), vaultData);
    assert.deepEqual(requests, [{ method: 'POST', body: { backupPassword: password } }]);
    await page.getByText('Tam v2 sistem yedeği indirildi (3 kayıt, 11 tablo).', { exact: true }).waitFor();
    assert.equal(await v2.inputValue(), '');
    assert.equal(await legacy.inputValue(), 'synthetic-legacy-password');
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`PASS: V2 export interaction and downloaded bytes (${await browser.version()})`);
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
