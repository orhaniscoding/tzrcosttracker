import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';

const lifecycleDependencies = vi.hoisted(() => ({ buildApp: vi.fn(), loadConfig: vi.fn() }));
vi.mock('../src/app.js', () => ({ buildApp: lifecycleDependencies.buildApp }));
vi.mock('../src/config.js', () => ({ loadConfig: lifecycleDependencies.loadConfig }));
import { startServer } from '../src/server-lifecycle.js';

const config: AppConfig = {
  port: 4000,
  host: '127.0.0.1',
  jwtSecret: 'synthetic-server-shutdown-jwt-secret-1234',
  masterKey: 'synthetic-server-shutdown-master-key-1234',
  blindIndexPepper: 'synthetic-server-shutdown-index-pepper-1234',
  dbPath: ':memory:',
};

type FakeApp = {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

describe('server shutdown lifecycle', () => {
  it('imports without starting the server', () => {
    expect(lifecycleDependencies.buildApp).not.toHaveBeenCalled();
    expect(lifecycleDependencies.loadConfig).not.toHaveBeenCalled();
  });

  it('waits for one graceful close when signals repeat', async () => {
    const signals = new EventEmitter();
    let releaseClose!: () => void;
    const closeFinished = new Promise<void>((resolve) => { releaseClose = resolve; });
    const app: FakeApp = {
      listen: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockReturnValue(closeFinished),
    };
    const server = await startServer({ config, appFactory: async () => app, signalSource: signals });

    expect(app.listen).toHaveBeenCalledWith({ port: 4000, host: '127.0.0.1' });
    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);

    releaseClose();
    await server.shutdown();
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('waits for close when a signal arrives during pending listen and never becomes ready', async () => {
    const signals = new EventEmitter();
    let releaseListen!: () => void;
    let releaseClose!: () => void;
    let markListenStarted!: () => void;
    const listenStarted = new Promise<void>((resolve) => { markListenStarted = resolve; });
    const listenFinished = new Promise<void>((resolve) => { releaseListen = resolve; });
    const closeFinished = new Promise<void>((resolve) => { releaseClose = resolve; });
    const app: FakeApp = {
      listen: vi.fn().mockImplementation(() => {
        markListenStarted();
        return listenFinished;
      }),
      close: vi.fn().mockReturnValue(closeFinished),
    };
    const startup = startServer({ config, appFactory: async () => app, signalSource: signals });
    let startupSettled = false;
    void startup.then(() => { startupSettled = true; }, () => { startupSettled = true; });

    await listenStarted;
    expect(app.listen).toHaveBeenCalledWith({ port: 4000, host: '127.0.0.1' });
    expect(startupSettled).toBe(false);
    signals.emit('SIGTERM');
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);

    releaseListen();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(startupSettled).toBe(false);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    releaseClose();
    const server = await startup;
    expect(server.ready).toBe(false);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('closes the app and preserves a listen error when startup fails', async () => {
    const listenError = new Error('listen failed');
    const app: FakeApp = {
      listen: vi.fn().mockRejectedValue(listenError),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(startServer({ config, appFactory: async () => app, signalSource: new EventEmitter() }))
      .rejects.toBe(listenError);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('preserves startup and cleanup errors when both fail', async () => {
    const listenError = new Error('listen failed');
    const cleanupError = new Error('cleanup failed');
    const app: FakeApp = {
      listen: vi.fn().mockRejectedValue(listenError),
      close: vi.fn().mockRejectedValue(cleanupError),
    };

    let observed: unknown;
    try {
      await startServer({ config, appFactory: async () => app, signalSource: new EventEmitter() });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([listenError, cleanupError]);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('keeps signal handlers until failed close settles and reports failure once', async () => {
    const signals = new EventEmitter();
    let rejectClose!: (error: Error) => void;
    const closeFinished = new Promise<void>((_resolve, reject) => { rejectClose = reject; });
    const cleanupError = new Error('shutdown failed');
    const onShutdownError = vi.fn();
    const app: FakeApp = {
      listen: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockReturnValue(closeFinished),
    };
    const server = await startServer({ config, appFactory: async () => app, signalSource: signals, onShutdownError });

    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);

    rejectClose(cleanupError);
    await expect(server.shutdown()).rejects.toBe(cleanupError);
    await Promise.resolve();
    expect(onShutdownError).toHaveBeenCalledTimes(1);
    expect(onShutdownError).toHaveBeenCalledWith(cleanupError);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
