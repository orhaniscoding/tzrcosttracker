import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dependencyRoots = ['apps', 'packages'];
const fixedDependencyInputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const fixedBuildInputs = ['turbo.json', 'tsconfig.base.json', 'apps/web/index.html', 'apps/web/vite.config.ts',
  'apps/web/postcss.config.js', 'apps/web/tailwind.config.js', 'scripts/run-local.mjs', 'scripts/build-fingerprint.mjs'];
const dependencyOutputs = ['node_modules/.modules.yaml', 'apps/web/node_modules/vite/bin/vite.js',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node'];
const localBuildOverrides = ['.env', '.env.local', '.env.production', '.env.production.local', 'apps/web/.env',
  'apps/web/.env.local', 'apps/web/.env.production', 'apps/web/.env.production.local'];
const localInstallOverrides = ['.npmrc'];

async function stat(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function workspacePaths(root) {
  const result = [];
  for (const group of dependencyRoots) {
    const directory = path.join(root, group);
    const info = await stat(directory);
    if (!info) continue;
    if (!info.isDirectory()) throw new Error(`Expected a workspace directory: ${group}`);
    for (const name of (await readdir(directory)).sort()) {
      const relative = `${group}/${name}`;
      const child = await stat(path.join(root, relative));
      if (!child?.isDirectory()) continue;
      if (await stat(path.join(root, relative, 'package.json'))) result.push(relative);
    }
  }
  return result;
}

async function inputFiles(root) {
  const workspaces = await workspacePaths(root);
  const dependency = [...fixedDependencyInputs, ...workspaces.map((p) => path.join(p, 'package.json'))];
  const build = [...fixedBuildInputs, ...workspaces.flatMap((p) => [path.join(p, 'tsconfig.json'), path.join(p, 'src')])];
  if (workspaces.includes('apps/web')) build.push('apps/web/public');
  return { dependency, build: [...dependency, ...build] };
}

async function digest(root, entries) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const file = path.join(root, relative);
    const info = await stat(file);
    hash.update(`${relative.replaceAll('\\', '/')}\0`);
    if (!info) { hash.update('missing\0'); return; }
    if (info.isSymbolicLink()) throw new Error(`Cannot fingerprint symbolic link: ${relative}`);
    if (info.isDirectory()) {
      hash.update('directory\0');
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
    } else if (info.isFile()) {
      const contents = await readFile(file);
      hash.update(`file:${contents.length}\0`);
      hash.update(contents);
    } else throw new Error(`Cannot fingerprint non-regular file: ${relative}`);
  }
  for (const entry of entries) await visit(entry);
  return hash.digest('hex');
}

async function allFilesExist(root, entries) {
  for (const entry of entries) {
    const info = await stat(path.join(root, entry));
    if (!info?.isFile()) return false;
  }
  return true;
}

async function allDirectoriesExist(root, entries) {
  for (const entry of entries) {
    const info = await stat(path.join(root, entry));
    if (!info?.isDirectory()) return false;
  }
  return true;
}

async function verifyNativeArtifacts(root) {
  let database;
  try {
    const requireFromDatabase = createRequire(path.join(root, 'packages/database/package.json'));
    const Database = requireFromDatabase('better-sqlite3');
    database = new Database(':memory:');
    database.prepare('SELECT 1').get();
    const requireFromVite = createRequire(path.join(root, 'apps/web/node_modules/vite/package.json'));
    const esbuild = requireFromVite('esbuild');
    if (typeof esbuild.transformSync('const localBuildArtifact = 1').code !== 'string') return false;
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

export async function prepare(root, run, { force = false, runtime = {
  node: process.versions.node, abi: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch,
}, verifyNative = verifyNativeArtifacts } = {}) {
  const marker = path.join(root, 'node_modules', '.costcore-local-preparation.json');
  let state;
  try { state = JSON.parse(await readFile(marker, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const { dependency: dependencyFiles, build: buildFiles } = await inputFiles(root);
  const hasBuildOverrides = (await Promise.all(localBuildOverrides.map((entry) => stat(path.join(root, entry))))).some(Boolean)
    || Object.keys(process.env).some((key) => key.toUpperCase().startsWith('VITE_'));
  const hasInstallOverrides = (await Promise.all(localInstallOverrides.map((entry) => stat(path.join(root, entry))))).some(Boolean);
  const input = await digest(root, dependencyFiles);
  const source = createHash('sha256').update(await digest(root, buildFiles)).update(process.env.NODE_ENV ?? '').digest('hex');
  const sameRuntime = state?.version === 1 && JSON.stringify(state?.runtime) === JSON.stringify(runtime);
  const dependenciesReady = !force && !hasInstallOverrides && sameRuntime && state?.input === input
    && await allFilesExist(root, dependencyOutputs) && await verifyNative(root);
  const outputRoots = (await workspacePaths(root)).map((p) => path.join(p, 'dist'));
  const outputFiles = ['apps/server/dist/index.js', 'apps/web/dist/index.html',
    ...['types', 'crypto', 'database'].map((name) => `packages/${name}/dist/index.js`)];
  const outputsReady = dependenciesReady && !hasBuildOverrides && state?.source === source
    && await allFilesExist(root, outputFiles) && await allDirectoriesExist(root, outputRoots)
    && state?.output === await digest(root, outputRoots);
  if (outputsReady) { console.log('Using existing local build.'); return; }

  await unlink(marker).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (!dependenciesReady) {
    await run(['install', '--frozen-lockfile']);
    await run(['-r', 'rebuild']);
    if (!await allFilesExist(root, dependencyOutputs) || !await verifyNative(root)) {
      throw new Error('The native dependencies are not ready for this Node.js runtime and host architecture.');
    }
  }
  await run(['build']);
  if (!await allFilesExist(root, [...dependencyOutputs, ...outputFiles]) || !await allDirectoriesExist(root, outputRoots)) {
    throw new Error('The local build did not produce all required outputs.');
  }
  const output = await digest(root, outputRoots);
  if (input !== await digest(root, (await inputFiles(root)).dependency)
    || source !== createHash('sha256').update(await digest(root, (await inputFiles(root)).build)).update(process.env.NODE_ENV ?? '').digest('hex')) {
    throw new Error('Build inputs changed during preparation. Run the launcher again.');
  }
  if (!hasInstallOverrides) {
    const temporary = `${marker}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, runtime, input, source, output: hasBuildOverrides ? null : output }), { flag: 'wx' });
      await rename(temporary, marker);
    } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
