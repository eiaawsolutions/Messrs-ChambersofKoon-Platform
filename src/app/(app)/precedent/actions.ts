'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireActor, requestContext } from '@/lib/auth/session';
import { assertCan, getAuthorisedMatter, AuthorizationError } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { getDocumentHeader } from '@/lib/queries/documents';
import { insertCitedExcerpt, InsertRejected } from '@/lib/documents/insert-excerpt';
import { saveSearch, deleteSavedSearch } from '@/lib/rag/saved-searches';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Precedent server actions (FR-6.5, FR-8.5).
 *
 * As in the matter actions, every one of these re-authorises. A server action
 * is a public endpoint; the button being hidden is not a control.
 */

/** The search that was on screen, carried through the redirect and back. */
const filtersSchema = z.object({
  q: z.string().max(400).optional(),
  area: z.string().max(40).optional(),
  office: z.string().max(10).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
});

type Filters = z.infer<typeof filtersSchema>;

function readFilters(formData: FormData): Filters {
  return filtersSchema.parse({
    q: formData.get('q') || undefined,
    area: formData.get('area') || undefined,
    office: formData.get('office') || undefined,
    from: formData.get('from') || undefined,
    to: formData.get('to') || undefined,
  });
}

/**
 * Rebuild the results URL.
 *
 * Only keys this function names are carried, and every value came through the
 * schema above, so nothing arbitrary from the request reaches the redirect.
 */
function backToResults(params: {
  documentId?: string;
  filters: Filters;
  insert?: string;
  versionNo?: number;
}): string {
  const search = new URLSearchParams();
  if (params.documentId) search.set('document', params.documentId);
  if (params.filters.q) search.set('q', params.filters.q);
  if (params.filters.area) search.set('area', params.filters.area);
  if (params.filters.office) search.set('office', params.filters.office);
  if (params.filters.from) search.set('from', params.filters.from);
  if (params.filters.to) search.set('to', params.filters.to);
  if (params.insert) search.set('insert', params.insert);
  if (params.versionNo !== undefined) search.set('v', String(params.versionNo));
  return `/precedent?${search.toString()}`;
}

const insertSchema = z.object({
  documentId: z.string().uuid(),
  chunkId: z.string().uuid(),
});

/**
 * FR-6.5: "Insert into draft pulls a cited excerpt into the current document
 * with the citation retained."
 *
 * Two identifiers arrive and neither is taken on trust:
 *
 * - The **document** is re-read through `getDocumentHeader`, which applies the
 *   caller's matter scope. That read is also where the matter id comes from.
 *   The form posts one too, but it is never what authorisation is decided on —
 *   otherwise a permitted document could be paired with someone else's matter.
 * - The **chunk** is re-read inside `insertCitedExcerpt` through
 *   `permittedChunk`, under the caller's own retrieval scope. The excerpt text
 *   never travels in the request at all, so a forged form cannot write chosen
 *   words into a draft.
 *
 * A document that does not exist and one the caller may not open both end at
 * `not_found`, so probing an id discloses nothing.
 */
export async function insertPrecedentAction(formData: FormData): Promise<void> {
  const parsed = insertSchema.parse({
    documentId: formData.get('documentId'),
    chunkId: formData.get('chunkId'),
  });
  const filters = readFilters(formData);

  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.RAG_SEARCH);

  const document = await getDocumentHeader(actor, parsed.documentId);
  if (!document) {
    redirect(backToResults({ filters, insert: 'not_found' }));
  }

  // Drafting permission on the matter the document actually belongs to.
  const matter = await getAuthorisedMatter(actor, document.matterId, PERMISSIONS.DOCUMENT_GENERATE);
  if (!matter) {
    const ctx = await requestContext();
    await audit({
      action: AUDIT_ACTIONS.MATTER_ACCESS_DENIED,
      actorUserId: actor.id,
      actorEmail: actor.email,
      entityType: 'matter',
      entityId: document.matterId,
      metadata: { permission: PERMISSIONS.DOCUMENT_GENERATE, via: 'precedent.insert' },
      ...ctx,
    });
    throw new AuthorizationError(PERMISSIONS.DOCUMENT_GENERATE, document.matterId);
  }

  let outcome: string;
  let versionNo: number | undefined;
  try {
    const result = await insertCitedExcerpt({
      actor,
      documentId: parsed.documentId,
      matterId: document.matterId,
      chunkId: parsed.chunkId,
    });
    outcome = 'saved';
    versionNo = result.versionNo;
  } catch (error) {
    if (!(error instanceof InsertRejected)) throw error;
    outcome = error.code;
  }

  revalidatePath(`/documents/${parsed.documentId}`);
  revalidatePath(`/matters/${document.matterId}`);
  redirect(backToResults({ documentId: parsed.documentId, filters, insert: outcome, versionNo }));
}

const saveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  query: z.string().trim().min(1).max(400),
  practiceArea: z.string().max(40).optional(),
  office: z.string().max(10).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
});

/** FR-8.5: save the query and its filters — never the results. */
export async function saveSearchAction(formData: FormData): Promise<void> {
  const parsed = saveSchema.parse({
    name: formData.get('name'),
    query: formData.get('q'),
    practiceArea: formData.get('area') || undefined,
    office: formData.get('office') || undefined,
    from: formData.get('from') || undefined,
    to: formData.get('to') || undefined,
  });

  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.RAG_SEARCH);

  await saveSearch({
    actor,
    name: parsed.name,
    query: parsed.query,
    practiceArea: parsed.practiceArea ?? null,
    office: parsed.office ?? null,
    dateFrom: parsed.from ?? null,
    dateTo: parsed.to ?? null,
  });

  revalidatePath('/precedent');
}

const forgetSchema = z.object({ id: z.string().uuid() });

export async function deleteSavedSearchAction(formData: FormData): Promise<void> {
  const parsed = forgetSchema.parse({ id: formData.get('id') });

  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.RAG_SEARCH);

  // Scoped to the caller's own rows inside the delete — posting another
  // lawyer's row id matches nothing rather than removing their search.
  await deleteSavedSearch({ actor, id: parsed.id });

  revalidatePath('/precedent');
}
