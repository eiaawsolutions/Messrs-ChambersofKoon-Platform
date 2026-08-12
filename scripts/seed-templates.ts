import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db, stopPool } from '@/lib/db/client';
import { documentTemplates } from '@/lib/db/schema';
import { putObject, storageKey } from '@/lib/storage/s3';
import { parseTemplate } from '@/lib/documents/template';
import { buildStarterDocx, STARTER_TEMPLATES } from '@/lib/documents/starter-templates';

/**
 * Register the starter document templates.
 *
 *   npm run seed:templates
 *
 * Document generation cannot run without at least one template: the generator
 * fills a firm .docx, it does not compose one. This registers the three
 * scaffolds in `starter-templates.ts` so a fresh environment can produce a
 * draft end to end on day one.
 *
 * They are scaffolds, not precedent — structure and placeholders, no clause
 * wording. Replace each with the firm's own before anything is filed.
 *
 * Idempotent by (name, version): re-running skips templates already present
 * rather than creating a second version, so it is safe on every deploy.
 */

async function main(): Promise<void> {
  console.log('Registering starter document templates…\n');

  let created = 0;
  let skipped = 0;

  for (const template of STARTER_TEMPLATES) {
    const [existing] = await db
      .select({ id: documentTemplates.id })
      .from(documentTemplates)
      .where(and(eq(documentTemplates.name, template.name), eq(documentTemplates.version, 1)))
      .limit(1);

    if (existing) {
      console.log(`  = ${template.name} (already registered)`);
      skipped++;
      continue;
    }

    const buffer = buildStarterDocx(template);

    // Parsed the same way an uploaded template would be, so the placeholder
    // contract cannot drift from what the generator will actually resolve.
    const { schema } = parseTemplate(buffer);

    const key = storageKey({
      kind: 'template',
      id: template.docType,
      filename: `${template.name} v1.docx`,
    });

    await putObject({
      key,
      body: buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    await db.insert(documentTemplates).values({
      name: template.name,
      practiceArea: template.practiceArea,
      docType: template.docType,
      storageKey: key,
      version: 1,
      placeholderSchema: schema,
      isActive: true,
    });

    console.log(
      `  + ${template.name} — ${schema.deterministic.length} field(s), ${schema.ai.length} AI block(s)`,
    );
    created++;
  }

  console.log(`\n${created} registered, ${skipped} already present.`);
  if (created > 0) {
    console.log(
      'These are scaffolds. Replace each with the firm’s own precedent before\n' +
        'any document produced from them is sent or filed.\n',
    );
  }

  await stopPool();
}

main().catch(async (error: unknown) => {
  const message = (error as Error).message ?? String(error);

  // The common failure by far, and the stack trace tells an operator nothing
  // they can act on.
  if (message.includes('Object storage is not configured')) {
    console.error(
      '\nObject storage is not configured, so the .docx files have nowhere to go.\n' +
        'Set STORAGE_ENDPOINT (or STORAGE_ACCOUNT_ID for R2) plus the access keys,\n' +
        'then run this again. Nothing was written — re-running is safe.\n',
    );
  } else {
    console.error('Template seeding failed:', error);
  }

  await stopPool().catch(() => {});
  process.exit(1);
});
