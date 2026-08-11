'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor } from '@/lib/auth/session';
import { assertCan } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { retryExtraction } from '@/lib/archive/upload';

const schema = z.object({ archiveFileId: z.string().uuid() });

/** FR-5.3: failed extractions are retryable from the UI. */
export async function retryExtractionAction(formData: FormData): Promise<void> {
  const { archiveFileId } = schema.parse({ archiveFileId: formData.get('archiveFileId') });

  const actor = await requireActor();
  assertCan(actor, PERMISSIONS.ARCHIVE_UPLOAD);

  const ok = await retryExtraction(actor, archiveFileId);
  if (!ok) throw new Error('Not authorised');

  revalidatePath('/archive');
}
