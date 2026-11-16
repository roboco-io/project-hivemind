import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

export async function tagRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/tags - List all active tags
  fastify.get('/api/tags', async (_request, reply) => {
    const tags = await prisma.tag.findMany({
      where: {
        articles: {
          some: {},
        },
      },
      orderBy: { name: 'asc' },
      select: { name: true },
    });

    return reply.status(200).send({
      tags: tags.map((tag) => tag.name),
    });
  });
}
