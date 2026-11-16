import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { prisma } from './prisma.js';

export async function ensureDatabaseSchema(): Promise<void> {
  try {
    await prisma.user.count();
    return;
  } catch {
    await prisma.$disconnect();
  }

  const prismaCli = path.resolve(process.cwd(), 'node_modules/prisma/build/index.js');
  if (!existsSync(prismaCli)) {
    throw new Error(`Prisma CLI not found at ${prismaCli}`);
  }

  const migrationsDir = path.resolve(process.cwd(), 'prisma/migrations');
  const args = existsSync(migrationsDir)
    ? [prismaCli, 'migrate', 'deploy']
    : [prismaCli, 'db', 'push', '--skip-generate'];

  execFileSync(process.execPath, args, {
    env: {
      ...process.env,
      DATABASE_URL: config.databaseUrl,
    },
    stdio: 'inherit',
  });

  await prisma.$connect();
}
