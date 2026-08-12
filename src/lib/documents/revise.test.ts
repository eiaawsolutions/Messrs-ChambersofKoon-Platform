import { describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import { recordRevision, RevisionRejected, REVISION_ERRORS } from './revise';
import { buildStarterDocx, STARTER_TEMPLATES } from './starter-templates';
import type { Actor } from '@/lib/auth/guard';

/**
 * The revision upload is the one place a lawyer's own file enters the
 * platform. Every assertion here covers a rejection that happens before any
 * database work, so the checks are proven to run first — a malformed upload
 * must never reach storage or the version table.
 */

const actor = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'lawyer@example.com',
  fullName: 'Test Lawyer',
} as Actor;

function attempt(bytes: Buffer) {
  return recordRevision({
    actor,
    documentId: '00000000-0000-0000-0000-0000000000aa',
    matterId: '00000000-0000-0000-0000-0000000000bb',
    filename: 'petition.docx',
    bytes,
    note: null,
  });
}

async function codeFor(bytes: Buffer): Promise<string> {
  try {
    await attempt(bytes);
    return 'accepted';
  } catch (error) {
    if (error instanceof RevisionRejected) return error.code;
    throw error;
  }
}

describe('recordRevision — upload validation', () => {
  it('rejects an empty file', async () => {
    expect(await codeFor(Buffer.alloc(0))).toBe('empty');
  });

  it('rejects a file over the size cap', async () => {
    expect(await codeFor(Buffer.alloc(26 * 1024 * 1024))).toBe('too_large');
  });

  it('rejects bytes that are not a zip, whatever the file is called', async () => {
    expect(await codeFor(Buffer.from('This is a .txt renamed to .docx'))).toBe('not_docx');
  });

  it('rejects a zip that is not a Word document', async () => {
    // A .zip of holiday photos, renamed. Valid archive, wrong contents.
    const zip = new PizZip();
    zip.file('photo.jpg', 'not really a jpeg');
    expect(await codeFor(zip.generate({ type: 'nodebuffer' }) as Buffer)).toBe('not_docx');
  });

  it('accepts a genuine .docx far enough to look the document up', async () => {
    // The document id does not exist, so it fails at the lookup — which is
    // proof the byte-level checks passed rather than short-circuiting.
    const docx = buildStarterDocx(STARTER_TEMPLATES[0]!);
    expect(await codeFor(docx)).toBe('not_found');
  });

  it('gives every rejection code a message for the page to render', () => {
    for (const [code, message] of Object.entries(REVISION_ERRORS)) {
      expect(message.length, code).toBeGreaterThan(0);
    }
  });
});
