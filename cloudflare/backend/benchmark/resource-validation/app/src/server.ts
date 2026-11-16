import { buildApp } from './app.js';
import { config } from './config.js';
import { ensureDatabaseSchema } from './lib/bootstrapDb.js';
import { prisma } from './lib/prisma.js';

async function start(): Promise<void> {
  await ensureDatabaseSchema();
  const app = await buildApp();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const bindHost = process.env.BIND_HOST || '::';
    try {
      await app.listen({ port: config.port, host: bindHost });
    } catch (listenErr: unknown) {
      if (
        !process.env.BIND_HOST &&
        listenErr instanceof Error &&
        'code' in listenErr &&
        (listenErr.code === 'EAFNOSUPPORT' || listenErr.code === 'EADDRNOTAVAIL')
      ) {
        await app.listen({ port: config.port, host: '0.0.0.0' });
      } else {
        throw listenErr;
      }
    }
  } catch (err) {
    app.log.error(err);
    await prisma.$disconnect();
    process.exit(1);
  }
}

void start();
