import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import {
  type ErrorMap,
  forbiddenError,
  notFoundError,
  validationError,
} from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { generateUniqueSlug, slugifyTitle } from '../lib/slug.js';
import {
  type ArticleWithRelations,
  articleRelationsInclude,
  serializeArticleListItem,
  serializeSingleArticle,
} from '../serializers.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePagination(query: { limit?: string; offset?: string }): {
  limit: number;
  offset: number;
} {
  let limit = 20;
  let offset = 0;
  const errors: ErrorMap = {};

  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.limit = ['is invalid'];
    } else {
      limit = parsed;
    }
  }

  if (query.offset !== undefined) {
    const parsed = Number(query.offset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      errors.offset = ['is invalid'];
    } else {
      offset = parsed;
    }
  }

  if (Object.keys(errors).length > 0) {
    throw validationError(errors);
  }

  return { limit, offset };
}

function validateAndNormalizeTagList(rawTagList: unknown): string[] {
  if (!Array.isArray(rawTagList)) {
    throw validationError({ tagList: ['is invalid'] });
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of rawTagList) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw validationError({ tagList: ['is invalid'] });
    }
    const trimmed = item.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }

  return normalized;
}

async function upsertTagsAndBuildLinks(
  tagNames: string[],
): Promise<Array<{ tagId: number; position: number }>> {
  const links: Array<{ tagId: number; position: number }> = [];
  for (let index = 0; index < tagNames.length; index++) {
    const name = tagNames[index]!;
    const tag = await prisma.tag.upsert({
      where: { name },
      create: { name },
      update: {},
    });
    links.push({ tagId: tag.id, position: index });
  }
  return links;
}

export async function articleRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/articles/feed - Feed of articles from followed users (auth required)
  fastify.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/api/articles/feed',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const currentUser = request.currentUser!;
      const { limit, offset } = parsePagination(request.query);

      const where: Prisma.ArticleWhereInput = {
        author: {
          followers: {
            some: {
              followerId: currentUser.id,
            },
          },
        },
      };

      const [articles, articlesCount] = await Promise.all([
        prisma.article.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
          include: articleRelationsInclude(currentUser.id),
        }),
        prisma.article.count({ where }),
      ]);

      return reply.status(200).send({
        articles: (articles as unknown as ArticleWithRelations[]).map((article) =>
          serializeArticleListItem(article, currentUser.id),
        ),
        articlesCount,
      });
    },
  );

  // GET /api/articles - List articles globally with optional filters (auth optional)
  fastify.get<{
    Querystring: {
      tag?: string;
      author?: string;
      favorited?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    '/api/articles',
    { preHandler: [fastify.authenticateOptional] },
    async (request, reply) => {
      const currentUserId = request.currentUser?.id ?? null;
      const { limit, offset } = parsePagination(request.query);
      const { tag, author, favorited } = request.query;

      const where: Prisma.ArticleWhereInput = {};

      if (tag !== undefined) {
        where.tags = {
          some: {
            tag: {
              name: tag,
            },
          },
        };
      }

      if (author !== undefined) {
        where.author = {
          username: author,
        };
      }

      if (favorited !== undefined) {
        where.favorites = {
          some: {
            user: {
              username: favorited,
            },
          },
        };
      }

      const [articles, articlesCount] = await Promise.all([
        prisma.article.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
          include: articleRelationsInclude(currentUserId),
        }),
        prisma.article.count({ where }),
      ]);

      return reply.status(200).send({
        articles: (articles as unknown as ArticleWithRelations[]).map((article) =>
          serializeArticleListItem(article, currentUserId),
        ),
        articlesCount,
      });
    },
  );

  // POST /api/articles - Create an article (auth required)
  fastify.post(
    '/api/articles',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const currentUser = request.currentUser!;

      if (!isRecord(request.body) || !isRecord(request.body.article)) {
        throw validationError({ article: ["can't be blank"] });
      }

      const input = request.body.article;
      const errors: ErrorMap = {};

      if (typeof input.title !== 'string' || input.title.trim() === '') {
        errors.title = ["can't be blank"];
      }
      if (typeof input.description !== 'string' || input.description.trim() === '') {
        errors.description = ["can't be blank"];
      }
      if (typeof input.body !== 'string' || input.body.trim() === '') {
        errors.body = ["can't be blank"];
      }

      let tagNames: string[] = [];
      if ('tagList' in input && input.tagList !== undefined) {
        tagNames = validateAndNormalizeTagList(input.tagList);
      }

      if (Object.keys(errors).length > 0) {
        throw validationError(errors);
      }

      const title = (input.title as string).trim();
      const description = input.description as string;
      const body = input.body as string;

      let slug = await generateUniqueSlug(prisma, title);
      const tagLinks = await upsertTagsAndBuildLinks(tagNames);
      const now = new Date();

      let article;
      try {
        article = await prisma.article.create({
          data: {
            slug,
            title,
            description,
            body,
            createdAt: now,
            updatedAt: now,
            authorId: currentUser.id,
            tags: {
              create: tagLinks,
            },
          },
          include: articleRelationsInclude(currentUser.id),
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          slug = `${slugifyTitle(title)}-${randomBytes(4).toString('hex')}`;
          article = await prisma.article.create({
            data: {
              slug,
              title,
              description,
              body,
              createdAt: now,
              updatedAt: now,
              authorId: currentUser.id,
              tags: {
                create: tagLinks,
              },
            },
            include: articleRelationsInclude(currentUser.id),
          });
        } else {
          throw err;
        }
      }

      return reply.status(201).send({
        article: serializeSingleArticle(
          article as unknown as ArticleWithRelations,
          currentUser.id,
        ),
      });
    },
  );

  // GET /api/articles/:slug - Get single article (auth optional)
  fastify.get<{ Params: { slug: string } }>(
    '/api/articles/:slug',
    { preHandler: [fastify.authenticateOptional] },
    async (request, reply) => {
      const { slug } = request.params;
      const currentUserId = request.currentUser?.id ?? null;

      const article = await prisma.article.findUnique({
        where: { slug },
        include: articleRelationsInclude(currentUserId),
      });

      if (!article) {
        throw notFoundError('article');
      }

      return reply.status(200).send({
        article: serializeSingleArticle(
          article as unknown as ArticleWithRelations,
          currentUserId,
        ),
      });
    },
  );

  // PUT /api/articles/:slug - Update an article (auth required, author only)
  fastify.put<{ Params: { slug: string } }>(
    '/api/articles/:slug',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const { slug } = request.params;
      const currentUser = request.currentUser!;

      const existing = await prisma.article.findUnique({
        where: { slug },
      });

      if (!existing) {
        throw notFoundError('article');
      }

      if (existing.authorId !== currentUser.id) {
        throw forbiddenError('article');
      }

      if (!isRecord(request.body) || !isRecord(request.body.article)) {
        throw validationError({ article: ["can't be blank"] });
      }

      const input = request.body.article;
      const errors: ErrorMap = {};
      const updateData: Prisma.ArticleUpdateInput = {};

      if ('title' in input && input.title !== undefined) {
        if (typeof input.title !== 'string' || input.title.trim() === '') {
          errors.title = ["can't be blank"];
        } else {
          const newTitle = input.title.trim();
          updateData.title = newTitle;
          if (newTitle !== existing.title) {
            updateData.slug = await generateUniqueSlug(prisma, newTitle, existing.id);
          }
        }
      }

      if ('description' in input && input.description !== undefined) {
        if (typeof input.description !== 'string' || input.description.trim() === '') {
          errors.description = ["can't be blank"];
        } else {
          updateData.description = input.description;
        }
      }

      if ('body' in input && input.body !== undefined) {
        if (typeof input.body !== 'string' || input.body.trim() === '') {
          errors.body = ["can't be blank"];
        } else {
          updateData.body = input.body;
        }
      }

      let newTagNames: string[] | undefined;
      if ('tagList' in input) {
        newTagNames = validateAndNormalizeTagList(input.tagList);
      }

      if (Object.keys(errors).length > 0) {
        throw validationError(errors);
      }

      if (newTagNames !== undefined) {
        const tagLinks = await upsertTagsAndBuildLinks(newTagNames);
        updateData.tags = {
          deleteMany: {},
          create: tagLinks,
        };
      }

      updateData.updatedAt = new Date(
        Math.max(Date.now(), existing.updatedAt.getTime() + 1),
      );

      const updated = await prisma.article.update({
        where: { id: existing.id },
        data: updateData,
        include: articleRelationsInclude(currentUser.id),
      });

      return reply.status(200).send({
        article: serializeSingleArticle(
          updated as unknown as ArticleWithRelations,
          currentUser.id,
        ),
      });
    },
  );

  // DELETE /api/articles/:slug - Delete an article (auth required, author only)
  fastify.delete<{ Params: { slug: string } }>(
    '/api/articles/:slug',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const { slug } = request.params;
      const currentUser = request.currentUser!;

      const existing = await prisma.article.findUnique({
        where: { slug },
        select: { id: true, authorId: true },
      });

      if (!existing) {
        throw notFoundError('article');
      }

      if (existing.authorId !== currentUser.id) {
        throw forbiddenError('article');
      }

      await prisma.article.delete({
        where: { id: existing.id },
      });

      return reply.status(204).send();
    },
  );

  // POST /api/articles/:slug/favorite - Favorite an article (auth required)
  fastify.post<{ Params: { slug: string } }>(
    '/api/articles/:slug/favorite',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const { slug } = request.params;
      const currentUser = request.currentUser!;

      const existing = await prisma.article.findUnique({
        where: { slug },
        select: { id: true },
      });

      if (!existing) {
        throw notFoundError('article');
      }

      await prisma.favorite.upsert({
        where: {
          userId_articleId: {
            userId: currentUser.id,
            articleId: existing.id,
          },
        },
        create: {
          userId: currentUser.id,
          articleId: existing.id,
        },
        update: {},
      });

      const article = await prisma.article.findUniqueOrThrow({
        where: { id: existing.id },
        include: articleRelationsInclude(currentUser.id),
      });

      return reply.status(200).send({
        article: serializeSingleArticle(
          article as unknown as ArticleWithRelations,
          currentUser.id,
        ),
      });
    },
  );

  // DELETE /api/articles/:slug/favorite - Unfavorite an article (auth required)
  fastify.delete<{ Params: { slug: string } }>(
    '/api/articles/:slug/favorite',
    { preHandler: [fastify.authenticateRequired] },
    async (request, reply) => {
      const { slug } = request.params;
      const currentUser = request.currentUser!;

      const existing = await prisma.article.findUnique({
        where: { slug },
        select: { id: true },
      });

      if (!existing) {
        throw notFoundError('article');
      }

      await prisma.favorite.deleteMany({
        where: {
          userId: currentUser.id,
          articleId: existing.id,
        },
      });

      const article = await prisma.article.findUniqueOrThrow({
        where: { id: existing.id },
        include: articleRelationsInclude(currentUser.id),
      });

      return reply.status(200).send({
        article: serializeSingleArticle(
          article as unknown as ArticleWithRelations,
          currentUser.id,
        ),
      });
    },
  );
}
