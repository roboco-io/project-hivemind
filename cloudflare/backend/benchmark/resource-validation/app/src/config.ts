process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./dev.db';

export const config = {
  port: Number(process.env.PORT) || 3000,
  bindHost: process.env.BIND_HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'realworld-conduit-super-secret-jwt-key',
  databaseUrl: process.env.DATABASE_URL,
};
