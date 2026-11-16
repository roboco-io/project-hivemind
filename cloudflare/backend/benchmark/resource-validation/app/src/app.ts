import fastifyCors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ApiError, validationError } from './lib/errors.js';
import { registerAuth } from './plugins/auth.js';
import { articleRoutes } from './routes/articles.js';
import { commentRoutes } from './routes/comments.js';
import { profileRoutes } from './routes/profiles.js';
import { tagRoutes } from './routes/tags.js';
import { userRoutes } from './routes/users.js';

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  await fastify.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Accept empty JSON request bodies (e.g., POST /follow or POST /favorite with Content-Type: application/json)
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const text = typeof body === 'string' ? body.trim() : '';
      if (text === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        done(validationError({ body: ['is invalid'] }), undefined);
      }
    },
  );

  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ errors: error.errors });
    }

    request.log.error(error);
    return reply.status(500).send({
      errors: {
        server: ['internal server error'],
      },
    });
  });

  fastify.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      errors: {
        route: ['not found'],
      },
    });
  });

  fastify.get('/api/health', async () => ({ status: 'ok' }));

  await registerAuth(fastify);
  await fastify.register(userRoutes);
  await fastify.register(profileRoutes);
  await fastify.register(articleRoutes);
  await fastify.register(commentRoutes);
  await fastify.register(tagRoutes);

  return fastify;
}
