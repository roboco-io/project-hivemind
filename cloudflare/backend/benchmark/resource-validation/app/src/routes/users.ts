import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import {
  type ErrorMap,
  conflictError,
  isValidEmail,
  unauthorizedError,
  validationError,
} from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';
import { serializeUser } from '../serializers.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/users - Register a new user
  fastify.post('/api/users', async (request, reply) => {
    if (!isRecord(request.body) || !isRecord(request.body.user)) {
      throw validationError({ user: ["can't be blank"] });
    }

    const { username, email, password } = request.body.user;
    const errors: ErrorMap = {};

    if (typeof username !== 'string' || username.trim() === '') {
      errors.username = ["can't be blank"];
    }

    if (typeof email !== 'string' || email.trim() === '') {
      errors.email = ["can't be blank"];
    } else if (!isValidEmail(email.trim())) {
      errors.email = ['is invalid'];
    }

    if (typeof password !== 'string' || password === '') {
      errors.password = ["can't be blank"];
    }

    if (Object.keys(errors).length > 0) {
      throw validationError(errors);
    }

    const normalizedUsername = (username as string).trim();
    const normalizedEmail = (email as string).trim();
    const rawPassword = password as string;

    const [existingByUsername, existingByEmail] = await Promise.all([
      prisma.user.findUnique({ where: { username: normalizedUsername }, select: { id: true } }),
      prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } }),
    ]);

    const conflicts: ErrorMap = {};
    if (existingByUsername) {
      conflicts.username = ['has already been taken'];
    }
    if (existingByEmail) {
      conflicts.email = ['has already been taken'];
    }
    if (Object.keys(conflicts).length > 0) {
      throw conflictError(conflicts);
    }

    const passwordHash = await hashPassword(rawPassword);

    try {
      const user = await prisma.user.create({
        data: {
          username: normalizedUsername,
          email: normalizedEmail,
          passwordHash,
        },
      });

      const token = fastify.signUserToken(user.id);
      return reply.status(201).send({
        user: serializeUser(user, token),
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = Array.isArray(err.meta?.target) ? err.meta.target : [];
        const raceConflicts: ErrorMap = {};
        if (target.includes('username')) {
          raceConflicts.username = ['has already been taken'];
        }
        if (target.includes('email')) {
          raceConflicts.email = ['has already been taken'];
        }
        throw conflictError(
          Object.keys(raceConflicts).length > 0
            ? raceConflicts
            : { user: ['has already been taken'] },
        );
      }
      throw err;
    }
  });

  // POST /api/users/login - Authenticate existing user
  fastify.post('/api/users/login', async (request, reply) => {
    if (!isRecord(request.body) || !isRecord(request.body.user)) {
      throw validationError({ user: ["can't be blank"] });
    }

    const { email, password } = request.body.user;
    const errors: ErrorMap = {};

    if (typeof email !== 'string' || email.trim() === '') {
      errors.email = ["can't be blank"];
    } else if (!isValidEmail(email.trim())) {
      errors.email = ['is invalid'];
    }

    if (typeof password !== 'string' || password === '') {
      errors.password = ["can't be blank"];
    }

    if (Object.keys(errors).length > 0) {
      throw validationError(errors);
    }

    const normalizedEmail = (email as string).trim();
    const rawPassword = password as string;

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user || !(await verifyPassword(rawPassword, user.passwordHash))) {
      throw unauthorizedError('credentials', 'invalid');
    }

    const token = fastify.signUserToken(user.id);
    return reply.status(200).send({
      user: serializeUser(user, token),
    });
  });

  // GET /api/user - Get current user
  fastify.get(
    '/api/user',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const currentUser = request.currentUser!;
      const token = fastify.signUserToken(currentUser.id);
      return reply.status(200).send({
        user: serializeUser(currentUser, token),
      });
    },
  );

  // PUT /api/user - Update current user
  fastify.put(
    '/api/user',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const currentUser = request.currentUser!;

      if (!isRecord(request.body) || !isRecord(request.body.user)) {
        throw validationError({ user: ["can't be blank"] });
      }

      const input = request.body.user;
      const errors: ErrorMap = {};
      const updateData: Prisma.UserUpdateInput = {};

      if ('email' in input) {
        if (input.email === null || typeof input.email !== 'string' || input.email.trim() === '') {
          errors.email = ["can't be blank"];
        } else if (!isValidEmail(input.email.trim())) {
          errors.email = ['is invalid'];
        } else {
          updateData.email = input.email.trim();
        }
      }

      if ('username' in input) {
        if (
          input.username === null ||
          typeof input.username !== 'string' ||
          input.username.trim() === ''
        ) {
          errors.username = ["can't be blank"];
        } else {
          updateData.username = input.username.trim();
        }
      }

      if ('password' in input) {
        if (
          input.password === null ||
          typeof input.password !== 'string' ||
          input.password === ''
        ) {
          errors.password = ["can't be blank"];
        } else if (input.password.length < 8) {
          errors.password = ['is too short (minimum is 8 characters)'];
        } else {
          updateData.passwordHash = await hashPassword(input.password);
        }
      }

      if ('bio' in input) {
        if (input.bio === null) {
          updateData.bio = null;
        } else if (typeof input.bio === 'string') {
          updateData.bio = input.bio === '' ? null : input.bio;
        } else if (input.bio !== undefined) {
          errors.bio = ['is invalid'];
        }
      }

      if ('image' in input) {
        if (input.image === null) {
          updateData.image = null;
        } else if (typeof input.image === 'string') {
          updateData.image = input.image === '' ? null : input.image;
        } else if (input.image !== undefined) {
          errors.image = ['is invalid'];
        }
      }

      if (Object.keys(errors).length > 0) {
        throw validationError(errors);
      }

      const conflicts: ErrorMap = {};
      if (typeof updateData.username === 'string' && updateData.username !== currentUser.username) {
        const existing = await prisma.user.findUnique({
          where: { username: updateData.username },
          select: { id: true },
        });
        if (existing && existing.id !== currentUser.id) {
          conflicts.username = ['has already been taken'];
        }
      }

      if (typeof updateData.email === 'string' && updateData.email !== currentUser.email) {
        const existing = await prisma.user.findUnique({
          where: { email: updateData.email },
          select: { id: true },
        });
        if (existing && existing.id !== currentUser.id) {
          conflicts.email = ['has already been taken'];
        }
      }

      if (Object.keys(conflicts).length > 0) {
        throw conflictError(conflicts);
      }

      const updatedUser = await prisma.user.update({
        where: { id: currentUser.id },
        data: updateData,
      });

      const token = fastify.signUserToken(updatedUser.id);
      return reply.status(200).send({
        user: serializeUser(updatedUser, token),
      });
    },
  );
}
