import type { SignalSource } from './server-lifecycle.js';
import { startServer } from './server-lifecycle.js';
import { loadConfig } from './config.js';

export async function main(signalSource?: SignalSource) {
  try {
    const config = loadConfig();
    const server = await startServer({ config, signalSource });
    if (!server.ready) return;
    console.log(`🚀 TZRCoster Server çalışıyor: http://${config.host}:${config.port}`);
  } catch (err) {
    console.error('Sunucu başlatılırken hata oluştu:', err);
    process.exitCode = 1;
  }
}

void main();
