import type { FastifyInstance } from 'fastify';
import { notFoundError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { serializeProfile } from '../serializers.js';

export async function profileRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/profiles/:username - Get a user profile (auth optional)
  fastify.get<{ Params: { username: string } }>(
    '/api/profiles/:username',
    { preHandler: [fastify.authenticateOptional] },
    async (request, reply) => {
      const { username } = request.params;
      const currentUserId = request.currentUser?.id ?? null;

      const targetUser = await prisma.user.findUnique({
        where: { username },
        include: {
          followers: currentUserId
            ? {
                where: { followerId: currentUserId },
                select: { followerId: true },
              }
            : false,
        },
      });

      if (!targetUser) {
        throw notFoundError('profile');
      }

      const isFollowing = Boolean(
        currentUserId && Array.isArray(targetUser.followers) && targetUser.followers.length > 0,
      );

      return reply.status(200).send({
        profile: serializeProfile(targetUser, isFollowing),
      });
    },
  );

  // POST /api/profiles/:username/follow - Follow a user
  fastify.post<{ Params: { username: string } }>(
    '/api/profiles/:username/follow',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const { username } = request.params;
      const currentUser = request.currentUser!;

      const targetUser = await prisma.user.findUnique({
        where: { username },
      });

      if (!targetUser) {
        throw notFoundError('profile');
      }

      await prisma.follow.upsert({
        where: {
          followerId_followingId: {
            followerId: currentUser.id,
            followingId: targetUser.id,
          },
        },
        create: {
          followerId: currentUser.id,
          followingId: targetUser.id,
        },
        update: {},
      });

      return reply.status(200).send({
        profile: serializeProfile(targetUser, true),
      });
    },
  );

  // DELETE /api/profiles/:username/follow - Unfollow a user
  fastify.delete<{ Params: { username: string } }>(
    '/api/profiles/:username/follow',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const { username } = request.params;
      const currentUser = request.currentUser!;

      const targetUser = await prisma.user.findUnique({
        where: { username },
      });

      if (!targetUser) {
        throw notFoundError('profile');
      }

      await prisma.follow.deleteMany({
        where: {
          followerId: currentUser.id,
          followingId: targetUser.id,
        },
      });

      return reply.status(200).send({
        profile: serializeProfile(targetUser, false),
      });
    },
  );
}
