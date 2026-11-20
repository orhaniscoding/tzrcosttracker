import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SW_PATH = resolve(here, '../public/sw.js');

type Handler = (event: any) => void;

interface CacheOp { type: string; cache?: string; }

function createFakeCaches(seed: Record<string, Record<string, string>> = {}) {
  const store = new Map<string, Map<string, string>>();
  for (const name of Object.keys(seed)) {
    store.set(name, new Map(Object.entries(seed[name])));
  }
  const ops: CacheOp[] = [];
  const deleted: string[] = [];

  const makeCache = (name: string) => {
    const entries = store.get(name) as Map<string, string>;
    const record = (type: string) => { ops.push({ type, cache: name }); };
    return {
      addAll: (requests: string[]) => { record('addAll'); for (const request of requests) { entries.set(request, 'precached'); } return Promise.resolve(); },
      put: (request: any, response: any) => { record('put'); entries.set(String(request), String(response)); return Promise.resolve(); },
      get: (request: any) => { record('get'); const key = String(request); return Promise.resolve(entries.has(key) ? entries.get(key) : undefined); },
      match: (request: any) => { record('match'); const key = String(request); return Promise.resolve(entries.has(key) ? entries.get(key) : undefined); },
      keys: () => Promise.resolve(Array.from(entries.keys())),
      delete: (request: any) => { record('delete'); return Promise.resolve(entries.delete(String(request))); },
    };
  };

  const fakeCaches = {
    keys: () => { ops.push({ type: 'keys' }); return Promise.resolve(Array.from(store.keys())); },
    delete: (name: string) => { ops.push({ type: 'delete', cache: name }); deleted.push(name); return Promise.resolve(store.delete(name)); },
    has: (name: string) => Promise.resolve(store.has(name)),
    open: (name: string) => { ops.push({ type: 'open', cache: name }); if (store.has(name) === false) { store.set(name, new Map()); } return Promise.resolve(makeCache(name)); },
    match: (request: any) => { ops.push({ type: 'match' }); const key = String(request); for (const entries of store.values()) { if (entries.has(key)) { return Promise.resolve(entries.get(key)); } } return Promise.resolve(undefined); },
  };

  return { caches: fakeCaches, ops, deleted, store };
}

interface Harness { handlers: Record<string, Handler[]>; skipWaitingCalls: number; claimCalls: number; ops: CacheOp[]; deleted: string[]; store: Map<string, Map<string, string>>; }

function loadWorker(seed?: Record<string, Record<string, string>>): Harness {
  const source = readFileSync(SW_PATH, 'utf8');
  const fake = createFakeCaches(seed);
  const handlers: Record<string, Handler[]> = {};
  const harness: Harness = { handlers, skipWaitingCalls: 0, claimCalls: 0, ops: fake.ops, deleted: fake.deleted, store: fake.store };
  const self = {
    addEventListener: (type: string, handler: Handler) => { const list = handlers[type] || (handlers[type] = []); list.push(handler); },
    skipWaiting: () => { harness.skipWaitingCalls += 1; return Promise.resolve(); },
    clients: { claim: () => { harness.claimCalls += 1; return Promise.resolve(); } },
  };
  const context = vm.createContext({ self, caches: fake.caches, console });
  vm.runInContext(source, context, { filename: 'sw.js' });
  return harness;
}

async function dispatch(harness: Harness, type: string, extra: Record<string, unknown> = {}): Promise<void> {
  const waits: Array<Promise<unknown>> = [];
  const event = Object.assign({ type, waitUntil: (promise: Promise<unknown>) => { waits.push(Promise.resolve(promise)); } }, extra);
  for (const handler of harness.handlers[type] || []) { handler(event); }
  await Promise.all(waits);
}

function attemptFetch(harness: Harness, url: string): { intercepted: boolean } {
  const handlers = harness.handlers.fetch || [];
  if (handlers.length === 0) { return { intercepted: false }; }
  let intercepted = false;
  const event = { request: { url, method: 'GET', mode: 'navigate' }, respondWith: () => { intercepted = true; }, waitUntil: () => {} };
  for (const handler of handlers) { handler(event); }
  return { intercepted };
}

const CACHE_READ_OR_WRITE = ['open', 'addAll', 'put', 'get', 'match'];

describe('service worker network-only compatibility worker', () => {
  it('registers an install and an activate handler and no fetch handler', () => {
    const harness = loadWorker();
    expect((harness.handlers.install || []).length).toBe(1);
    expect((harness.handlers.activate || []).length).toBe(1);
    expect(harness.handlers.fetch || []).toHaveLength(0);
  });

  it('calls skipWaiting when the install event is handled', async () => {
    const harness = loadWorker();
    expect(harness.skipWaitingCalls).toBe(0);
    await dispatch(harness, 'install');
    expect(harness.skipWaitingCalls).toBe(1);
  });

  it('deletes only legacy versioned costcore caches and preserves unrelated and nonlegacy costcore caches', async () => {
    const harness = loadWorker({
      'costcore-v1': { '/': 'legacy-html', '/index.html': 'legacy-html' },
      'costcore-v2': { '/assets/index-old.js': 'legacy-js' },
      'third-party-app-cache': { '/keep': 'unrelated' }, 'costcore-preferences': { '/keep': 'preferences' },
      'workbox-precache-v2-example': { '/keep': 'unrelated-too' },
    });
    await dispatch(harness, 'activate');
    expect(harness.deleted.slice().sort()).toEqual(['costcore-v1', 'costcore-v2']);
    expect(harness.store.has('costcore-v1')).toBe(false);
    expect(harness.store.has('costcore-v2')).toBe(false);
    expect(harness.store.has('third-party-app-cache')).toBe(true);
    expect(harness.store.has('workbox-precache-v2-example')).toBe(true); expect(harness.store.has('costcore-preferences')).toBe(true); expect(harness.deleted).not.toContain('costcore-preferences');
  });

  it('claims clients and resolves waitUntil after legacy cleanup', async () => {
    const harness = loadWorker({ 'costcore-v1': { '/index.html': 'legacy-html' } });
    await dispatch(harness, 'activate');
    expect(harness.claimCalls).toBe(1);
    expect(harness.store.size).toBe(0);
  });

  it('never opens, reads, matches or writes caches during install and activate', async () => {
    const harness = loadWorker({ 'costcore-v1': { '/index.html': 'legacy-html' }, unrelated: { '/a': 'b' } });
    await dispatch(harness, 'install');
    await dispatch(harness, 'activate');
    const unexpected = harness.ops.filter((op) => op.type === 'open' || op.type === 'addAll' || op.type === 'put' || op.type === 'get' || op.type === 'match');
    expect(unexpected).toHaveLength(0);
    expect(CACHE_READ_OR_WRITE.length).toBe(5);
  });

  it('leaves API, navigation and static asset fetches to the browser default network path', async () => {
    const harness = loadWorker({ 'costcore-v1': { '/': 'legacy-html', '/index.html': 'legacy-html' } });
    await dispatch(harness, 'install');
    await dispatch(harness, 'activate');
    const urls = [
      'http://127.0.0.1:18081/api/health',
      'http://127.0.0.1:18081/',
      'http://127.0.0.1:18081/index.html',
      'http://127.0.0.1:18081/assets/index-C8pnjw82.js',
      'http://127.0.0.1:18081/manifest.json',
    ];
    for (const url of urls) {
      expect(attemptFetch(harness, url)).toEqual({ intercepted: false });
    }
  });

  it('upgrades an installed legacy v1 worker that had cached the current page', async () => {
    const harness = loadWorker({
      'costcore-v1': { '/': 'stale-index-html', '/index.html': 'stale-index-html', '/manifest.json': 'stale-manifest' },
      'unrelated-pwa-cache': { '/frame': 'keep' },
    });
    await dispatch(harness, 'install');
    expect(harness.skipWaitingCalls).toBe(1);
    await dispatch(harness, 'activate');
    expect(harness.store.has('costcore-v1')).toBe(false);
    expect(harness.store.has('unrelated-pwa-cache')).toBe(true);
    expect(harness.claimCalls).toBe(1);
    expect(attemptFetch(harness, 'http://127.0.0.1:18081/')).toEqual({ intercepted: false });
  });

});