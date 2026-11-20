#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from './build-fingerprint.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = path.resolve(process.env.COSTCORE_DATA_DIR ?? path.join(homedir(), '.tzr-cost-tracker', 'local'));
const environmentFile = path.join(dataDir, '.env');
const dbPath = path.join(dataDir, 'cost-core.sqlite');
const keys = ['JWT_SECRET', 'MASTER_KEY', 'BLIND_INDEX_PEPPER', 'BOOTSTRAP_TOKEN'];
const windows = process.platform === 'win32';
const apiUrl = 'http://127.0.0.1:4000';
const webUrl = 'http://127.0.0.1:3000';

async function inspect(file) {
  try { return await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadServerKeys() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const dir = await lstat(dataDir);
  if (!dir.isDirectory() || (!windows && (dir.mode & 0o077) !== 0)) {
    throw new Error(`Use a private data directory: ${dataDir}`);
  }
  let info = await inspect(environmentFile);
  if (!info) {
    if (await inspect(dbPath)) throw new Error('The existing database has no key file. Restore its original keys before starting.');
    const entries = keys.map((key) => `${key}=${randomBytes(32).toString('base64url')}`);
    try { await writeFile(environmentFile, `${entries.join('\n')}\n`, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    info = await lstat(environmentFile);
  }
  if (!info.isFile() || (!windows && (info.mode & 0o077) !== 0)) {
    throw new Error(`Use a private regular file for the server keys: ${environmentFile}`);
  }
  const values = Object.create(null);
  for (const line of (await readFile(environmentFile, 'utf8')).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    if (index < 1 || !keys.includes(key) || key in values) throw new Error(`Unexpected entry in ${environmentFile}`);
    values[key] = line.slice(index + 1);
  }
  for (const key of keys.slice(0, 3)) {
    if (!values[key] || values[key].length < 32) throw new Error(`Missing or invalid ${key} in ${environmentFile}`);
  }
  if (values.BOOTSTRAP_TOKEN && values.BOOTSTRAP_TOKEN.length < 32) throw new Error(`Invalid setup token in ${environmentFile}`);
  if ((!values.BOOTSTRAP_TOKEN) && !(await inspect(dbPath))) throw new Error(`The setup token is required for a new database: ${environmentFile}`);
  return { ...values, BOOTSTRAP_TOKEN: values.BOOTSTRAP_TOKEN ?? '' };
}

function runPnpm(args, env) {
  return new Promise((resolve, reject) => {
    // The Windows shell receives only fixed build commands, with no user-supplied arguments.
    const child = spawn(windows ? 'npm.cmd' : 'npm', ['exec', '--yes', '--package=pnpm@12.16.1', '--', 'pnpm', ...args], {
      cwd: root, env, stdio: 'inherit', shell: windows,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(' ')} stopped (${signal ?? code})`));
    });
  });
}

function startNode(relative, args, env, cwd = root) {
  return spawn(process.execPath, [path.join(root, relative), ...args], { cwd, env, stdio: 'inherit' });
}

async function waitHealthy(url, signal) {
  const end = Date.now() + 45_000;
  while (Date.now() < end && !signal.aborted) {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) }).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!signal.aborted) throw new Error(`No response from ${url}. Check the server output and port availability.`);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Install Node.js 24 LTS and run this command again.');
  if (process.argv.slice(2).some((arg) => arg !== '--rebuild')) throw new Error('Usage: node scripts/run-local.mjs [--rebuild]');
  const buildEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !keys.includes(name.toUpperCase())));
  Object.assign(buildEnv, { CI: 'true', TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' });
  await prepare(root, (args) => runPnpm(args, buildEnv), { force: process.argv.includes('--rebuild') });

  const serverKeys = await loadServerKeys();
  const api = startNode('apps/server/dist/index.js', [], {
    ...buildEnv, ...serverKeys, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '4000', DB_PATH: dbPath,
  });
  const controller = new AbortController();
  let web;
  function stop() {
    if (controller.signal.aborted) return;
    controller.abort();
    api.kill();
    web?.kill();
  }
  function observe(child, label) {
    child.once('error', (error) => { console.error(`${label}: ${error.message}`); process.exitCode = 1; stop(); });
    child.once('exit', (code) => {
      if (!controller.signal.aborted) {
        console.error(`${label} exited (${code ?? 'signal'}).`);
        process.exitCode = 1;
        stop();
      }
    });
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  observe(api, 'API');
  try {
    await waitHealthy(`${apiUrl}/health`, controller.signal);
    if (controller.signal.aborted) return;
    web = startNode('apps/web/node_modules/vite/bin/vite.js', ['preview', '--host', '127.0.0.1', '--port', '3000', '--strictPort'], buildEnv, path.join(root, 'apps/web'));
    observe(web, 'Web');
    await waitHealthy(`${webUrl}/health`, controller.signal);
    if (!controller.signal.aborted) {
      console.log(`Open ${webUrl}`);
      console.log(`For first-time setup, read BOOTSTRAP_TOKEN from ${environmentFile} and enter it in the setup form.`);
      console.log('Press Ctrl+C to stop.');
    }
  } catch (error) {
    stop();
    throw error;
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
