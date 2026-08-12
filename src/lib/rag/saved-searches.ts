import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { savedSearches, type Office, type PracticeArea } from '@/lib/db/schema';
import type { Actor } from '@/lib/auth/guard';

/**
 * Saved precedent searches (FR-8.5).
 *
 * A saved search is a stored *question*, never a stored answer. It re-runs
 * under the reader's own scope every time it is opened, so a search saved by a
 * partner and later opened by a pupil returns the pupil's permitted excerpts.
 * Storing result sets would have created a quiet route across the permission
 * boundary that FR-6.2 exists to hold.
 *
 * Every function here scopes to `actor.id` in the WHERE clause rather than
 * checking ownership after the read, so posting another lawyer's row id
 * returns and changes nothing.
 */

/** A ceiling, so one enthusiastic user cannot fill the table. */
const MAX_PER_USER = 30;

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  practiceArea: PracticeArea | null;
  office: Office | null;
  dateFrom: string | null;
  dateTo: string | null;
}

export async function listSavedSearches(actor: Actor): Promise<SavedSearch[]> {
  return db
    .select({
      id: savedSearches.id,
      name: savedSearches.name,
      query: savedSearches.query,
      practiceArea: savedSearches.practiceArea,
      office: savedSearches.office,
      dateFrom: savedSearches.dateFrom,
      dateTo: savedSearches.dateTo,
    })
    .from(savedSearches)
    .where(eq(savedSearches.userId, actor.id))
    .orderBy(desc(savedSearches.createdAt))
    .limit(MAX_PER_USER);
}

/**
 * Save, or update the one already under that name.
 *
 * Re-saving a name overwrites rather than erroring: the natural way to refine a
 * saved search is to run it, change a filter and save it again, and a
 * duplicate-name error there would read as a bug.
 */
export async function saveSearch(params: {
  actor: Actor;
  name: string;
  query: string;
  practiceArea: string | null;
  office: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}): Promise<void> {
  const values = {
    userId: params.actor.id,
    name: params.name,
    query: params.query,
    practiceArea: (params.practiceArea || null) as PracticeArea | null,
    office: (params.office || null) as Office | null,
    dateFrom: params.dateFrom || null,
    dateTo: params.dateTo || null,
  };

  await db
    .insert(savedSearches)
    .values(values)
    .onConflictDoUpdate({
      target: [savedSearches.userId, savedSearches.name],
      set: {
        query: values.query,
        practiceArea: values.practiceArea,
        office: values.office,
        dateFrom: values.dateFrom,
        dateTo: values.dateTo,
      },
    });
}

export async function deleteSavedSearch(params: { actor: Actor; id: string }): Promise<void> {
  await db
    .delete(savedSearches)
    .where(and(eq(savedSearches.id, params.id), eq(savedSearches.userId, params.actor.id)));
}
