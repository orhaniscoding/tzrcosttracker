import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepare } from './build-fingerprint.mjs';

test('reuses preparation and invalidates it for changes, missing outputs, and explicit rebuild', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'costcore-launch-'));
  const put = async (name, value = name) => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  };
  const commands = [];
  const runtime = { node: '24.0.0', platform: 'test', arch: 'test' };
  try {
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json', 'tsconfig.base.json',
      'apps/server/package.json', 'apps/server/tsconfig.json', 'apps/server/src/index.ts',
      'apps/web/package.json', 'apps/web/tsconfig.json', 'apps/web/index.html', 'apps/web/src/main.tsx',
      'packages/types/package.json', 'packages/types/tsconfig.json', 'packages/types/src/index.ts',
      'packages/crypto/package.json', 'packages/crypto/tsconfig.json', 'packages/crypto/src/index.ts',
      'packages/database/package.json', 'packages/database/tsconfig.json', 'packages/database/src/index.ts']) await put(name);
    const run = async (args) => {
      commands.push(args.join(' '));
      if (args[0] === 'install') {
        for (const name of ['node_modules/.modules.yaml', 'apps/web/node_modules/vite/bin/vite.js',
          'node_modules/better-sqlite3/build/Release/better_sqlite3.node']) await put(name);
      }
      if (args[0] === 'build') {
        for (const name of ['apps/server/dist/index.js', 'apps/web/dist/index.html',
          'packages/types/dist/index.js', 'packages/crypto/dist/index.js', 'packages/database/dist/index.js']) await put(name);
      }
    };
    await prepare(root, run, { runtime, verifyNative: async () => true });
    assert.deepEqual(commands, ['install --frozen-lockfile', '-r rebuild', 'build']);
    commands.length = 0;
    await prepare(root, run, { runtime, verifyNative: async () => true });
    assert.deepEqual(commands, []);
    await put('apps/server/src/index.ts', 'changed');
    await prepare(root, run, { runtime, verifyNative: async () => true });
    assert.deepEqual(commands, ['build']);
    commands.length = 0;
    await unlink(path.join(root, 'apps/web/dist/index.html'));
    await prepare(root, run, { runtime, verifyNative: async () => true });
    assert.deepEqual(commands, ['build']);
    commands.length = 0;
    await put('pnpm-lock.yaml', 'changed');
    await prepare(root, run, { runtime, verifyNative: async () => true });
    assert.deepEqual(commands, ['install --frozen-lockfile', '-r rebuild', 'build']);
    commands.length = 0;
    await prepare(root, run, { runtime, force: true, verifyNative: async () => true });
    assert.deepEqual(commands, ['install --frozen-lockfile', '-r rebuild', 'build']);
    commands.length = 0;
    await prepare(root, run, { runtime: { ...runtime, arch: 'other' }, verifyNative: async () => true });
    assert.deepEqual(commands, ['install --frozen-lockfile', '-r rebuild', 'build']);
    commands.length = 0;
    await assert.rejects(prepare(root, async () => { throw new Error('synthetic failure'); }, {
      runtime, force: true, verifyNative: async () => true,
    }), /synthetic failure/);
    await prepare(root, run, { runtime, verifyNative: async () => true });
    assert.deepEqual(commands, ['install --frozen-lockfile', '-r rebuild', 'build']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
