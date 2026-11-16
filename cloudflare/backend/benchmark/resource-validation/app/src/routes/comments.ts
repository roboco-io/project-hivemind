import type { FastifyInstance } from 'fastify';
import { forbiddenError, notFoundError, validationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import {
  type CommentWithRelations,
  commentRelationsInclude,
  serializeComment,
} from '../serializers.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function commentRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/articles/:slug/comments - Get comments for an article (auth optional)
  fastify.get<{ Params: { slug: string } }>(
    '/api/articles/:slug/comments',
    { preHandler: [fastify.authenticateOptional] },
    async (request, reply) => {
      const { slug } = request.params;
      const currentUserId = request.currentUser?.id ?? null;

      const article = await prisma.article.findUnique({
        where: { slug },
        select: { id: true },
      });

      if (!article) {
        throw notFoundError('article');
      }

      const comments = await prisma.comment.findMany({
        where: { articleId: article.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: commentRelationsInclude(currentUserId),
      });

      return reply.status(200).send({
        comments: (comments as unknown as CommentWithRelations[]).map((comment) =>
          serializeComment(comment, currentUserId),
        ),
      });
    },
  );

  // POST /api/articles/:slug/comments - Add a comment to an article (auth required)
  fastify.post<{ Params: { slug: string } }>(
    '/api/articles/:slug/comments',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const { slug } = request.params;
      const currentUser = request.currentUser!;

      const article = await prisma.article.findUnique({
        where: { slug },
        select: { id: true },
      });

      if (!article) {
        throw notFoundError('article');
      }

      if (!isRecord(request.body) || !isRecord(request.body.comment)) {
        throw validationError({ body: ["can't be blank"] });
      }

      const { body } = request.body.comment;
      if (typeof body !== 'string' || body.trim() === '') {
        throw validationError({ body: ["can't be blank"] });
      }

      const now = new Date();
      const comment = await prisma.comment.create({
        data: {
          body,
          createdAt: now,
          updatedAt: now,
          articleId: article.id,
          authorId: currentUser.id,
        },
        include: commentRelationsInclude(currentUser.id),
      });

      return reply.status(201).send({
        comment: serializeComment(
          comment as unknown as CommentWithRelations,
          currentUser.id,
        ),
      });
    },
  );

  // DELETE /api/articles/:slug/comments/:id - Delete a comment (auth required, author only)
  fastify.delete<{ Params: { slug: string; id: string } }>(
    '/api/articles/:slug/comments/:id',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const { slug, id } = request.params;
      const currentUser = request.currentUser!;

      const article = await prisma.article.findUnique({
        where: { slug },
        select: { id: true },
      });

      if (!article) {
        throw notFoundError('article');
      }

      const commentId = Number(id);
      if (!Number.isInteger(commentId) || commentId <= 0) {
        throw notFoundError('comment');
      }

      const comment = await prisma.comment.findFirst({
        where: {
          id: commentId,
          articleId: article.id,
        },
      });

      if (!comment) {
        throw notFoundError('comment');
      }

      if (comment.authorId !== currentUser.id) {
        throw forbiddenError('comment');
      }

      await prisma.comment.delete({
        where: { id: comment.id },
      });

      return reply.status(204).send();
    },
  );
}
