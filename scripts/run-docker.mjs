#!/usr/bin/env node
/** Start CostCore with the repository's Docker Compose definition. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = join(ROOT, '.cache', 'costcore-docker');
const envFile = join(cacheRoot, 'local.env');
const composeFile = join(ROOT, 'compose.yaml');
const projectPath = process.platform === 'win32' ? ROOT.toLowerCase() : ROOT;
const projectHash = createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
const defaultProject = `costcore-local-${projectHash}`;
const explicitProject = process.env.COSTCORE_COMPOSE_PROJECT;
const webPort = process.env.WEB_PORT || '18080';
const requiredKeys = ['JWT_SECRET', 'MASTER_KEY', 'BLIND_INDEX_PEPPER', 'BOOTSTRAP_TOKEN'];
const persistentKeys = requiredKeys.slice(0, 3);

function validateProject(name) {
  if (!name || name.length > 63 || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error('Invalid Compose project identity. Use lowercase letters, digits, hyphens, or underscores.');
  }
  return name;
}

function makeSecret() {
  return randomBytes(32).toString('base64url');
}

function parseEnv(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=([^\r\n]*)$/.exec(line);
    if (!match || ![...requiredKeys, 'WEB_PORT', 'COSTCORE_COMPOSE_PROJECT', 'INSTALL_STATE'].includes(match[1]) || values.has(match[1])) throw new Error(`Invalid Compose key file: ${envFile}`);
    values.set(match[1], match[2]);
  }
  for (const key of persistentKeys) {
    const value = values.get(key);
    if (!value || value.length < 32 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error(`Missing or invalid ${key} in the Compose key file. The existing file was preserved.`);
    }
  }
  const token = values.get('BOOTSTRAP_TOKEN');
  if (token && (token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token))) {
    throw new Error('Invalid BOOTSTRAP_TOKEN in the Compose key file. The existing file was preserved.');
  }
  const presentKeys = requiredKeys.map((key) => values.get(key)).filter(Boolean);
  if (new Set(presentKeys).size !== presentKeys.length) {
    throw new Error('Compose keys must be independent. The existing file was preserved.');
  }
  const port = values.get('WEB_PORT');
  if (!port || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`Invalid WEB_PORT in the Compose key file. The existing file was preserved.`);
  }
  if (values.has('COSTCORE_COMPOSE_PROJECT')) validateProject(values.get('COSTCORE_COMPOSE_PROJECT'));
  if (values.has('INSTALL_STATE') && !['initializing', 'ready'].includes(values.get('INSTALL_STATE'))) {
    throw new Error('Invalid installation state in the Compose key file. The existing file was preserved.');
  }
  return values;
}

async function ensureEnv(action) {
  if (!existsSync(envFile)) {
    if (action !== 'up') throw new Error(`Compose key file not found: ${envFile}`);
    if (!/^\d{1,5}$/.test(webPort) || Number(webPort) < 1 || Number(webPort) > 65535) {
      throw new Error('WEB_PORT must be between 1 and 65535.');
    }
    const projectName = validateProject(explicitProject ?? defaultProject);
    const existingVolumes = await listDataVolumes();
    if (existingVolumes.length > 0 && explicitProject === undefined) {
      throw new Error('Existing CostCore volumes were found. Set COSTCORE_COMPOSE_PROJECT to the recorded installation identity before starting.');
    }
    const expectedVolume = `${projectName}_cost-core-data`;
    if (existingVolumes.includes(expectedVolume)) throw new Error('The existing volume has no key file. Restore its original keys before starting.');
    if (existingVolumes.length > 0) throw new Error('A different CostCore data volume exists. Verify the installation identity before creating keys.');
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const contents = [
      ...requiredKeys.map((key) => `${key}=${makeSecret()}`),
      `WEB_PORT=${webPort}`,
      `COSTCORE_COMPOSE_PROJECT=${projectName}`,
      'INSTALL_STATE=initializing',
      '',
    ].join('\n');
    try {
      await writeFile(envFile, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { values: parseEnv(contents), projectName, created: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const info = await lstat(envFile);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('The Compose key file must be a private regular file.');
  }
  const values = parseEnv(await readFile(envFile, 'utf8'));
  const recordedProject = values.get('COSTCORE_COMPOSE_PROJECT');
  if (explicitProject !== undefined) validateProject(explicitProject);
  if (recordedProject && explicitProject !== undefined && recordedProject !== explicitProject) {
    throw new Error('Compose project identity mismatch. The existing file was preserved.');
  }
  const projectName = validateProject(recordedProject ?? explicitProject ?? defaultProject);
  if (action !== 'setup-key' && (!recordedProject || !values.has('INSTALL_STATE'))) {
    const existingVolumes = await listDataVolumes();
    const expectedVolume = `${projectName}_cost-core-data`;
    if (!existingVolumes.includes(expectedVolume)) {
      throw new Error('The saved installation identity or data volume is missing. Verify the original project and Docker context before starting.');
    }
    values.set('COSTCORE_COMPOSE_PROJECT', projectName);
    values.set('INSTALL_STATE', 'ready');
    await persistEnv(values);
  }
  return { values, projectName, created: false };
}

async function persistEnv(values) {
  const tempFile = `${envFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const contents = `${[...values].map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  try {
    await writeFile(tempFile, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tempFile, envFile);
  } catch (error) {
    await unlink(tempFile).catch(() => {});
    throw new Error('Could not persist the Compose installation identity. The existing key file was preserved.');
  }
}

function dockerExecutable() {
  return process.platform === 'win32' ? 'docker.exe' : 'docker';
}

function cleanDockerEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (requiredKeys.includes(name) || name === 'WEB_PORT' || name === 'COSTCORE_COMPOSE_PROJECT' || name.startsWith('COMPOSE_')) delete env[key];
  }
  return env;
}

function listDataVolumes() {
  return new Promise((done, fail) => {
    const child = spawn(dockerExecutable(), ['volume', 'ls', '--filter', 'name=cost-core-data', '--format', '{{.Name}}'], {
      cwd: ROOT, env: cleanDockerEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part) => { output += part; });
    child.stderr.resume();
    child.on('error', (error) => fail(new Error(`Could not check Docker: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return fail(new Error('Could not check the Docker volume. The launcher stopped.'));
      done(output.split(/\r?\n/).filter((name) => name.endsWith('_cost-core-data')));
    });
  });
}

function composeArgs(action, projectName, wait) {
  const base = ['compose', '--env-file', envFile, '-f', composeFile, '-p', projectName];
  if (action === 'down') return [...base, 'down'];
  return [...base, 'up', '--build', ...(wait ? ['--detach', '--wait', '--wait-timeout', '120'] : [])];
}

async function main() {
  const action = process.argv[2] || 'up';
  const wait = action === 'up' && process.argv[3] === '--wait';
  if (!['up', 'down', 'setup-key'].includes(action) || process.argv.length > (wait ? 4 : 3)) {
    throw new Error('Usage: node scripts/run-docker.mjs [up [--wait]|down|setup-key]');
  }
  const { values, projectName, created } = await ensureEnv(action);
  if (action === 'setup-key') {
    if (!values.get('BOOTSTRAP_TOKEN')) throw new Error('The setup token is absent from this installation.');
    console.log(values.get('BOOTSTRAP_TOKEN'));
    return;
  }
  if (action === 'up' && !created) {
    const volumes = await listDataVolumes();
    const found = volumes.includes(`${projectName}_cost-core-data`);
    if (!found && (values.get('INSTALL_STATE') !== 'initializing' || !values.get('BOOTSTRAP_TOKEN') || volumes.length > 0)) {
      throw new Error('The expected data volume was not found. Verify the Compose project, Docker context, and original volume before starting.');
    }
    if (found && values.get('INSTALL_STATE') === 'initializing') {
      values.set('INSTALL_STATE', 'ready');
      await persistEnv(values);
    }
  }
  const childEnv = cleanDockerEnv();
  const child = spawn(dockerExecutable(), composeArgs(action, projectName, wait), {
    cwd: ROOT,
    env: childEnv,
    stdio: 'inherit',
    shell: false,
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('error', (error) => { console.error(`Could not start Docker Compose: ${error.message}`); process.exitCode = 1; });
  child.on('exit', async (code, signal) => {
    if (signal) return;
    process.exitCode = code ?? 1;
    if (action === 'up' && code === 0 && values.get('INSTALL_STATE') === 'initializing') {
      try {
        const volumes = await listDataVolumes();
        if (volumes.includes(`${projectName}_cost-core-data`)) {
          values.set('INSTALL_STATE', 'ready');
          await persistEnv(values);
        }
      } catch {
        console.error('Could not record the Compose installation state. The key file was preserved.');
        process.exitCode = 1;
      }
    }
  });
  if (action === 'up') {
    console.log(`CostCore: http://127.0.0.1:${values.get('WEB_PORT')}`);
    console.log(`Compose project: ${projectName}`);
    if (values.get('BOOTSTRAP_TOKEN')) console.log('Read the first-run setup token with node scripts/run-docker.mjs setup-key');
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
