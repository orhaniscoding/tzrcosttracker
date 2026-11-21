import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;
process.umask(0o077);
const keyLines = [
  `JWT_SECRET=${'j'.repeat(32)}`,
  `MASTER_KEY=${'m'.repeat(32)}`,
  `BLIND_INDEX_PEPPER=${'p'.repeat(32)}`,
];

async function fixture({ volume = '', project = 'costcore-test' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'costcore-docker-test-'));
  const cache = join(dir, '.cache', 'costcore-docker');
  const log = join(dir, 'docker.log');
  const fakeBin = join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker');
  const fakeScript = [
    "const args = [process.argv[1], ...process.argv.slice(2)];",
    "require('node:fs').appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');",
    "if (require('node:path').basename(process.argv[1]) === 'volume' && process.env.FAKE_DOCKER_VOLUME) process.stdout.write(process.env.FAKE_DOCKER_VOLUME + '\\n');",
    "if (require('node:path').basename(process.argv[1]) === 'compose') process.exit(Number(process.env.FAKE_DOCKER_EXIT_CODE || 0));",
  ].join('\n');
  await mkdir(join(dir, 'scripts'));
  await copyFile(join(root, 'scripts', 'run-docker.mjs'), join(dir, 'scripts', 'run-docker.mjs'));
  await copyFile(join(root, 'compose.yaml'), join(dir, 'compose.yaml'));
  await copyFile(node, fakeBin);
  await writeFile(join(dir, 'volume'), fakeScript, 'utf8');
  await writeFile(join(dir, 'compose'), fakeScript, 'utf8');
  const childEnv = {
    ...process.env,
    ...(project === null ? {} : { COSTCORE_COMPOSE_PROJECT: project }),
    PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    FAKE_DOCKER_LOG: log,
    FAKE_DOCKER_VOLUME: volume,
  };
  if (project === null) delete childEnv.COSTCORE_COMPOSE_PROJECT;
  return {
    dir, cache, log, childEnv,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function run(fx, action = 'up') {
  return await new Promise((resolve) => {
    const child = spawn(node, [join(fx.dir, 'scripts', 'run-docker.mjs'), action], {
      cwd: fx.dir,
      env: fx.childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('new installation records explicit project identity and generated keys', async (t) => {
  const fx = await fixture({ project: 'costcore-portable' });
  t.after(fx.cleanup);
  const result = await run(fx);
  assert.equal(result.code, 0, result.stderr);
  const contents = await readFile(join(fx.cache, 'local.env'), 'utf8');
  assert.match(contents, /^COSTCORE_COMPOSE_PROJECT=costcore-portable$/m);
  assert.match(contents, /^BOOTSTRAP_TOKEN=.{32,}$/m);
});

test('clean first run needs no explicit identity and interrupted setup can retry', async (t) => {
  const fx = await fixture({ project: null });
  t.after(fx.cleanup);
  fx.childEnv.FAKE_DOCKER_EXIT_CODE = '23';
  const first = await run(fx);
  assert.equal(first.code, 23, first.stderr);
  const before = await readFile(join(fx.cache, 'local.env'), 'utf8');
  assert.match(before, /^INSTALL_STATE=initializing$/m);
  fx.childEnv.FAKE_DOCKER_EXIT_CODE = '0';
  const retry = await run(fx);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(await readFile(join(fx.cache, 'local.env'), 'utf8'), before);
});

test('a recorded installation follows its keys after moving the checkout', async (t) => {
  const fx = await fixture({ project: null, volume: 'costcore-original_cost-core-data' });
  t.after(fx.cleanup);
  await mkdir(fx.cache, { recursive: true });
  const contents = [...keyLines, 'WEB_PORT=18080', 'COSTCORE_COMPOSE_PROJECT=costcore-original', 'INSTALL_STATE=ready'].join('\n') + '\n';
  await writeFile(join(fx.cache, 'local.env'), contents, { mode: 0o600 });
  const result = await run(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Compose project: costcore-original/);
  assert.equal(await readFile(join(fx.cache, 'local.env'), 'utf8'), contents);
});

test('a ready installation cannot start without its recorded volume', async (t) => {
  const fx = await fixture({ project: 'costcore-original' });
  t.after(fx.cleanup);
  await mkdir(fx.cache, { recursive: true });
  const contents = [...keyLines, `BOOTSTRAP_TOKEN=${'b'.repeat(32)}`, 'WEB_PORT=18080', 'COSTCORE_COMPOSE_PROJECT=costcore-original', 'INSTALL_STATE=ready'].join('\n') + '\n';
  await writeFile(join(fx.cache, 'local.env'), contents, { mode: 0o600 });
  const result = await run(fx);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /expected data volume was not found/i);
});

test('existing installation may intentionally omit bootstrap token', async (t) => {
  const fx = await fixture({ project: 'costcore-existing', volume: 'costcore-existing_cost-core-data' });
  t.after(fx.cleanup);
  await mkdir(fx.cache, { recursive: true });
  await writeFile(join(fx.cache, 'local.env'), `${[...keyLines, 'WEB_PORT=18080', 'INSTALL_STATE=ready'].join('\n')}\nCOSTCORE_COMPOSE_PROJECT=costcore-existing\n`, 'utf8');
  const result = await run(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Compose project: costcore-existing/);
});

test('new installation without bootstrap token fails closed before compose', async (t) => {
  const fx = await fixture({ project: 'costcore-new' });
  t.after(fx.cleanup);
  await mkdir(fx.cache, { recursive: true });
  await writeFile(join(fx.cache, 'local.env'), `${[...keyLines, 'WEB_PORT=18080', 'INSTALL_STATE=ready'].join('\n')}\nCOSTCORE_COMPOSE_PROJECT=costcore-new\n`, 'utf8');
  const result = await run(fx);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /expected data volume was not found/i);
  const calls = (await readFile(fx.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.equal(basename(calls[0][0]), 'volume');
});

test('explicit project mismatch fails closed without touching docker', async (t) => {
  const fx = await fixture({ project: 'costcore-other' });
  t.after(fx.cleanup);
  await mkdir(fx.cache, { recursive: true });
  await writeFile(join(fx.cache, 'local.env'), `${keyLines.join('\n')}\nBOOTSTRAP_TOKEN=${'b'.repeat(32)}\nWEB_PORT=18080\nCOSTCORE_COMPOSE_PROJECT=costcore-recorded\n`, 'utf8');
  const result = await run(fx, 'down');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /project identity.*mismatch/i);
  assert.equal((await readFile(fx.log, 'utf8').catch(() => '')).trim(), '');
});

test('missing key file with matching volume does not generate keys', async (t) => {
  const fx = await fixture({ project: 'costcore-new', volume: 'costcore-new_cost-core-data' });
  t.after(fx.cleanup);
  const result = await run(fx);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /existing.*volume/i);
  await assert.rejects(readFile(join(fx.cache, 'local.env'), 'utf8'), { code: 'ENOENT' });
});

test('missing key file with another installation volume requires an explicit project', async (t) => {
  const fx = await fixture({ project: null, volume: 'costcore-original_cost-core-data' });
  t.after(fx.cleanup);
  const result = await run(fx);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Set COSTCORE_COMPOSE_PROJECT/);
  await assert.rejects(readFile(join(fx.cache, 'local.env'), 'utf8'), { code: 'ENOENT' });
});

test('legacy keys use the explicit original identity after a move', async (t) => {
  const fx = await fixture({ project: 'costcore-original', volume: 'costcore-original_cost-core-data' });
  t.after(fx.cleanup);
  await mkdir(fx.cache, { recursive: true });
  const original = [...keyLines, `BOOTSTRAP_TOKEN=${'b'.repeat(32)}`, 'WEB_PORT=18080'].join('\n') + '\n';
  await writeFile(join(fx.cache, 'local.env'), original, { mode: 0o600 });
  const result = await run(fx);
  assert.equal(result.code, 0, result.stderr);
  const upgraded = await readFile(join(fx.cache, 'local.env'), 'utf8');
  for (const line of original.trim().split('\n')) assert.ok(upgraded.split('\n').includes(line));
  assert.match(upgraded, /^COSTCORE_COMPOSE_PROJECT=costcore-original$/m);
  assert.match(result.stdout, /Compose project: costcore-original/);
});

test('setup-key fails clearly when a completed installation has no token', async (t) => {
  const fx = await fixture({ project: 'costcore-existing', volume: 'costcore-existing_cost-core-data' });
  t.after(fx.cleanup);
  await mkdir(fx.cache, { recursive: true });
  await writeFile(join(fx.cache, 'local.env'), `${[...keyLines, 'WEB_PORT=18080', 'COSTCORE_COMPOSE_PROJECT=costcore-existing', 'INSTALL_STATE=ready'].join('\n')}\n`, 'utf8');
  const result = await run(fx, 'setup-key');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /setup token is absent/i);
});
