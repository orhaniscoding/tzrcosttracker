import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const cfg = {
    port: 4317,
    host: '127.0.0.1',
    jwtSecret: 'synthetic-jwt',
    masterKey: 'synthetic-master',
    blindIndexPepper: 'synthetic-pepper',
    dbPath: ':memory:',
  };
  const app = {
    userRepo: { getUserByUsernameOrEmail: vi.fn(), createUser: vi.fn(), setUserPin: vi.fn() },
    categoryRepo: { createCategory: vi.fn() },
    transactionRepo: { createTransaction: vi.fn() },
    projectRepo: { createProject: vi.fn() },
    listen: vi.fn(),
  };
  return { cfg, app, loadConfig: vi.fn(), buildApp: vi.fn() };
});

vi.mock('../src/app.js', () => ({ buildApp: h.buildApp }));
vi.mock('../src/config.js', () => ({ loadConfig: h.loadConfig }));

const captureSignalListeners = () => new Map([
  ['SIGINT', new Set(process.listeners('SIGINT'))],
  ['SIGTERM', new Set(process.listeners('SIGTERM'))],
]);
let signalListenerBaseline = captureSignalListeners();

async function start(existing: any) {
  signalListenerBaseline = captureSignalListeners();
  vi.resetModules();
  h.loadConfig.mockReset().mockReturnValue(h.cfg);
  h.buildApp.mockReset().mockResolvedValue(h.app);
  h.app.listen.mockReset().mockResolvedValue(undefined);
  h.app.userRepo.getUserByUsernameOrEmail.mockReset().mockResolvedValue(existing);
  h.app.userRepo.createUser.mockReset().mockResolvedValue({ id: 'u1' });
  h.app.userRepo.setUserPin.mockReset().mockResolvedValue(undefined);
  h.app.categoryRepo.createCategory.mockReset().mockResolvedValue({ id: 'c1' });
  h.app.transactionRepo.createTransaction.mockReset().mockResolvedValue({ id: 't1' });
  h.app.projectRepo.createProject.mockReset().mockResolvedValue({ id: 'p1' });
  await import('../src/index.ts');
  await vi.waitFor(() => {
    expect(h.app.listen).toHaveBeenCalledWith({ port: h.cfg.port, host: h.cfg.host });
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function expectNoSeed() {
  expect(h.loadConfig).toHaveBeenCalledTimes(1);
  expect(h.buildApp).toHaveBeenCalledTimes(1);
  expect(h.buildApp).toHaveBeenCalledWith({ config: h.cfg });
  expect(h.app.listen).toHaveBeenCalledTimes(1);
  expect(h.app.userRepo.getUserByUsernameOrEmail).not.toHaveBeenCalled();
  expect(h.app.userRepo.createUser).not.toHaveBeenCalled();
  expect(h.app.userRepo.setUserPin).not.toHaveBeenCalled();
  expect(h.app.categoryRepo.createCategory).not.toHaveBeenCalled();
  expect(h.app.transactionRepo.createTransaction).not.toHaveBeenCalled();
  expect(h.app.projectRepo.createProject).not.toHaveBeenCalled();
}

describe('production startup does not seed', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const baseline = signalListenerBaseline.get(signal)!;
      for (const listener of process.listeners(signal)) {
        if (!baseline.has(listener)) process.removeListener(signal, listener);
      }
      expect(new Set(process.listeners(signal))).toEqual(baseline);
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });
  it('fresh install: listens without creating demo admin/categories/transactions', async () => {
    await start(null);
    expectNoSeed();
  });
  it('existing account without PIN: listens without lookup or PIN reassignment', async () => {
    await start({ id: 'existing-1', username: 'existing_user', hasPin: false });
    expectNoSeed();
  });
});
