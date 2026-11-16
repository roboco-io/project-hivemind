import fastifyJwt from '@fastify/jwt';
import type { User } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { unauthorizedError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: User | null;
  }
  interface FastifyInstance {
    signUserToken: (userId: number) => string;
    authenticateRequired: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateOptional: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: number };
    user: { sub: number };
  }
}

function extractToken(authorizationHeader: string | undefined): {
  present: boolean;
  token: string | null;
} {
  if (!authorizationHeader || authorizationHeader.trim() === '') {
    return { present: false, token: null };
  }

  const trimmed = authorizationHeader.trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) {
    return { present: true, token: null };
  }

  const scheme = trimmed.slice(0, spaceIndex);
  const token = trimmed.slice(spaceIndex + 1).trim();

  if (scheme !== 'Token' && scheme !== 'Bearer') {
    return { present: true, token: null };
  }

  if (!token) {
    return { present: false, token: null };
  }

  return { present: true, token };
}

export async function registerAuth(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifyJwt, {
    secret: config.jwtSecret,
  });

  fastify.decorateRequest('currentUser', null);

  fastify.decorate('signUserToken', (userId: number): string => {
    return fastify.jwt.sign({ sub: userId }, { expiresIn: '7d' });
  });

  fastify.decorate(
    'authenticateRequired',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const { present, token } = extractToken(request.headers.authorization);
      if (!present) {
        throw unauthorizedError('token', 'is missing');
      }
      if (!token) {
        throw unauthorizedError('token', 'is invalid');
      }

      let decoded: { sub: number };
      try {
        decoded = fastify.jwt.verify<{ sub: number }>(token);
      } catch {
        throw unauthorizedError('token', 'is invalid');
      }

      if (typeof decoded.sub !== 'number') {
        throw unauthorizedError('token', 'is invalid');
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.sub },
      });
      if (!user) {
        throw unauthorizedError('token', 'is invalid');
      }

      request.currentUser = user;
    },
  );

  fastify.decorate(
    'authenticateOptional',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const authHeader = request.headers.authorization;
      if (!authHeader || authHeader.trim() === '') {
        request.currentUser = null;
        return;
      }

      const { present, token } = extractToken(authHeader);
      if (!present) {
        request.currentUser = null;
        return;
      }
      if (!token) {
        throw unauthorizedError('token', 'is invalid');
      }

      let decoded: { sub: number };
      try {
        decoded = fastify.jwt.verify<{ sub: number }>(token);
      } catch {
        throw unauthorizedError('token', 'is invalid');
      }

      if (typeof decoded.sub !== 'number') {
        throw unauthorizedError('token', 'is invalid');
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.sub },
      });
      if (!user) {
        throw unauthorizedError('token', 'is invalid');
      }

      request.currentUser = user;
    },
  );
}
