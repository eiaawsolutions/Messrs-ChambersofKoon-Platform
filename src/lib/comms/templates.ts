import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { messageTemplates, type MessageTemplate } from '@/lib/db/schema';

/**
 * Message template loading (FR-9.3).
 *
 * Templates live in the database so firm staff can edit copy without a deploy.
 * A short in-process cache keeps the hot path (a milestone email per status
 * change) off the database, and is cleared whenever the admin console saves.
 */

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: MessageTemplate | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function loadTemplate(key: string): Promise<MessageTemplate | null> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [row] = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.key, key), eq(messageTemplates.isActive, true)))
    .limit(1);

  const value = row ?? null;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function invalidateTemplateCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

export async function listTemplates(): Promise<MessageTemplate[]> {
  return db.select().from(messageTemplates).orderBy(messageTemplates.key);
}
