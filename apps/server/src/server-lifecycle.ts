import type { EventEmitter } from 'node:events';
import { buildApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import type { FastifyInstance } from 'fastify';

export type ServerApp = Pick<FastifyInstance, 'listen' | 'close'>;
export type SignalSource = Pick<EventEmitter, 'on' | 'removeListener'>;
type AppFactory = (options: { config: AppConfig }) => Promise<ServerApp>;

export interface StartServerOptions {
  config?: AppConfig;
  appFactory?: AppFactory;
  signalSource?: SignalSource;
  onShutdownError?: (error: unknown) => void;
}

export interface ServerHandle {
  app: ServerApp;
  ready: boolean;
  shutdown: () => Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const config = options.config ?? loadConfig();
  const appFactory = options.appFactory ?? buildApp;
  const signalSource = options.signalSource ?? process;
  const reportShutdownError = options.onShutdownError ?? ((error: unknown) => {
    console.error('Sunucu kapatılırken hata oluştu:', error);
    process.exitCode = 1;
  });
  const app = await appFactory({ config });

  let closePromise: Promise<void> | undefined;
  let shutdownRequested = false;
  let startupSettled = false;
  let shutdownErrorReported = false;
  let resolveShutdownSignal!: () => void;
  const shutdownSignal = new Promise<void>((resolve) => { resolveShutdownSignal = resolve; });
  const reportShutdownFailure = (error: unknown) => {
    if (shutdownErrorReported) return;
    shutdownErrorReported = true;
    try {
      reportShutdownError(error);
    } catch (reportError) {
      console.error('Sunucu kapatma hatası raporlanamadı:', error, reportError);
      process.exitCode = 1;
    }
  };
  const removeSignalHandlers = () => {
    signalSource.removeListener('SIGINT', onSignal);
    signalSource.removeListener('SIGTERM', onSignal);
  };
  const shutdown = (): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        try {
          await app.close();
        } finally {
          removeSignalHandlers();
        }
      })();
    }
    return closePromise;
  };
  const onSignal = () => {
    shutdownRequested = true;
    resolveShutdownSignal();
    void shutdown().catch((error) => {
      if (startupSettled) reportShutdownFailure(error);
    });
  };

  signalSource.on('SIGINT', onSignal);
  signalSource.on('SIGTERM', onSignal);
  const listenAttempt = Promise.resolve()
    .then(() => app.listen({ port: config.port, host: config.host }))
    .then(
      () => ({ kind: 'listening' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    );
  const outcome = await Promise.race([
    listenAttempt,
    shutdownSignal.then(() => ({ kind: 'shutdown' as const })),
  ]);

  if (outcome.kind === 'failed') {
    try {
      await shutdown();
    } catch (cleanupError) {
      startupSettled = true;
      throw new AggregateError([outcome.error, cleanupError], 'Could not close the server after failed startup.');
    }
    startupSettled = true;
    throw outcome.error;
  }

  if (shutdownRequested || outcome.kind === 'shutdown') {
    try {
      await shutdown();
    } catch (error) {
      reportShutdownFailure(error);
    }
    startupSettled = true;
    return { app, ready: false, shutdown };
  }

  startupSettled = true;
  return { app, ready: true, shutdown };
}
