import type { Prisma, User } from '@prisma/client';

export const authorWithFollowersInclude = (currentUserId: number | null) =>
  ({
    followers: currentUserId
      ? {
          where: { followerId: currentUserId },
          select: { followerId: true },
        }
      : false,
  }) satisfies Prisma.UserInclude;

export const articleRelationsInclude = (currentUserId: number | null) =>
  ({
    author: {
      include: authorWithFollowersInclude(currentUserId),
    },
    tags: {
      include: { tag: true },
      orderBy: { position: 'asc' as const },
    },
    favorites: currentUserId
      ? {
          where: { userId: currentUserId },
          select: { userId: true },
        }
      : false,
    _count: {
      select: { favorites: true },
    },
  }) satisfies Prisma.ArticleInclude;

export const commentRelationsInclude = (currentUserId: number | null) =>
  ({
    author: {
      include: authorWithFollowersInclude(currentUserId),
    },
  }) satisfies Prisma.CommentInclude;

export type ArticleWithRelations = Prisma.ArticleGetPayload<{
  include: {
    author: {
      include: {
        followers: {
          select: { followerId: true };
        };
      };
    };
    tags: {
      include: { tag: true };
    };
    favorites: {
      select: { userId: true };
    };
    _count: {
      select: { favorites: true };
    };
  };
}>;

export type CommentWithRelations = Prisma.CommentGetPayload<{
  include: {
    author: {
      include: {
        followers: {
          select: { followerId: true };
        };
      };
    };
  };
}>;

export function serializeUser(user: User, token: string) {
  return {
    email: user.email,
    token,
    username: user.username,
    bio: user.bio ?? null,
    image: user.image ?? null,
  };
}

export function serializeProfile(
  user: Pick<User, 'username' | 'bio' | 'image'>,
  following: boolean,
) {
  return {
    username: user.username,
    bio: user.bio ?? null,
    image: user.image ?? null,
    following,
  };
}

function isFollowingAuthor(
  author: { followers?: Array<{ followerId: number }> },
  currentUserId: number | null,
): boolean {
  if (!currentUserId || !Array.isArray(author.followers)) {
    return false;
  }
  return author.followers.length > 0;
}

function isFavoritedByCurrentUser(
  article: { favorites?: Array<{ userId: number }> },
  currentUserId: number | null,
): boolean {
  if (!currentUserId || !Array.isArray(article.favorites)) {
    return false;
  }
  return article.favorites.length > 0;
}

export function serializeSingleArticle(
  article: ArticleWithRelations,
  currentUserId: number | null,
) {
  return {
    slug: article.slug,
    title: article.title,
    description: article.description,
    body: article.body,
    tagList: article.tags.map((at) => at.tag.name),
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
    favorited: isFavoritedByCurrentUser(article, currentUserId),
    favoritesCount: article._count.favorites,
    author: serializeProfile(
      article.author,
      isFollowingAuthor(article.author, currentUserId),
    ),
  };
}

export function serializeArticleListItem(
  article: ArticleWithRelations,
  currentUserId: number | null,
) {
  return {
    slug: article.slug,
    title: article.title,
    description: article.description,
    tagList: article.tags.map((at) => at.tag.name),
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
    favorited: isFavoritedByCurrentUser(article, currentUserId),
    favoritesCount: article._count.favorites,
    author: serializeProfile(
      article.author,
      isFollowingAuthor(article.author, currentUserId),
    ),
  };
}

export function serializeComment(
  comment: CommentWithRelations,
  currentUserId: number | null,
) {
  return {
    id: comment.id,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
    body: comment.body,
    author: serializeProfile(
      comment.author,
      isFollowingAuthor(comment.author, currentUserId),
    ),
  };
}
