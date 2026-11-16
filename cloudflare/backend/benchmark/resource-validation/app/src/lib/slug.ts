import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'article';
}

export async function generateUniqueSlug(
  prisma: PrismaClient,
  title: string,
  excludeArticleId?: number,
): Promise<string> {
  const baseSlug = slugifyTitle(title);

  const existingBase = await prisma.article.findUnique({
    where: { slug: baseSlug },
    select: { id: true },
  });

  if (!existingBase || existingBase.id === excludeArticleId) {
    return baseSlug;
  }

  for (let suffix = 2; suffix <= 20; suffix++) {
    const candidate = `${baseSlug}-${suffix}`;
    const existing = await prisma.article.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing || existing.id === excludeArticleId) {
      return candidate;
    }
  }

  return `${baseSlug}-${randomBytes(4).toString('hex')}`;
}
