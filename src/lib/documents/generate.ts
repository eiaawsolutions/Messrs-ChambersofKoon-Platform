import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  clients,
  documentTemplates,
  documentVersions,
  documents,
  matters,
  roles,
  users,
} from '@/lib/db/schema';
import { getObject, putObject, storageKey } from '@/lib/storage/s3';
import { assembleDocx, summariseChanges } from '@/lib/documents/template';
import { generateStructured } from '@/lib/ai/client';
import { DRAFTING_SYSTEM, wrapUntrusted } from '@/lib/ai/prompts';
import { clauseDraftJsonSchema, clauseDraftSchema } from '@/lib/ai/schemas';
import { vaultForMatter } from '@/lib/ai/tokenise';
import { decryptField } from '@/lib/security/crypto';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';
import { retrievePrecedent } from '@/lib/rag/retrieve';
import { loadGrants, type Actor } from '@/lib/auth/guard';
import { ROLE_NAMES } from '@/lib/auth/permissions';
import { config } from '@/lib/config/env';

/**
 * Document generation (M4, FR-4.2 – FR-4.4).
 *
 * The split that matters: deterministic placeholders are filled from matter
 * data and are *never* model output; Claude drafts only the blocks the
 * template marked `ai:`. Those two sets are assembled separately and passed to
 * `assembleDocx` as separate arguments, so there is no code path where a model
 * could supply a party name or an IC number.
 *
 * Identifiers are tokenised before any prompt leaves the platform and
 * rehydrated in the rendered output (AI-1). The vault lives for the duration of
 * one generation and is disposed in a finally block.
 */

export interface GenerateInput {
  documentId: string;
  actorUserId: string;
}

interface MatterBundle {
  matterId: string;
  reference: string;
  title: string;
  practiceArea: string;
  office: string;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  clientIdNumber: string | null;
  clientNotes: string | null;
  lawyerName: string;
}

async function loadBundle(matterId: string): Promise<MatterBundle | null> {
  const [row] = await db
    .select({
      matterId: matters.id,
      reference: matters.reference,
      title: matters.title,
      practiceArea: matters.practiceArea,
      office: matters.office,
      clientName: clients.fullName,
      clientEmail: clients.email,
      clientPhone: clients.phone,
      clientIdEncrypted: clients.idNumberEncrypted,
      clientNotes: clients.notes,
      lawyerName: users.fullName,
    })
    .from(matters)
    .innerJoin(clients, eq(clients.id, matters.clientId))
    .leftJoin(users, eq(users.id, matters.assignedUserId))
    .where(eq(matters.id, matterId))
    .limit(1);

  if (!row) return null;

  let clientIdNumber: string | null = null;
  if (row.clientIdEncrypted) {
    try {
      clientIdNumber = await decryptField(row.clientIdEncrypted);
    } catch {
      // A decryption failure must not block drafting; the field renders as
      // [TO CONFIRM] and the lawyer supplies it.
      clientIdNumber = null;
    }
  }

  return {
    matterId: row.matterId,
    reference: row.reference,
    title: row.title,
    practiceArea: row.practiceArea,
    office: row.office,
    clientName: row.clientName,
    clientEmail: row.clientEmail,
    clientPhone: row.clientPhone,
    clientIdNumber,
    clientNotes: row.clientNotes,
    lawyerName: row.lawyerName ?? config().FIRM_NAME,
  };
}

/** Deterministic values only. Nothing here is ever model-generated (FR-4.2). */
function buildDeterministic(bundle: MatterBundle): Record<string, string> {
  const today = new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());

  return {
    clientName: bundle.clientName,
    clientEmail: bundle.clientEmail ?? '',
    clientPhone: bundle.clientPhone ?? '',
    clientIdNumber: bundle.clientIdNumber ?? '',
    matterReference: bundle.reference,
    matterTitle: bundle.title,
    practiceArea: bundle.practiceArea.replace(/_/g, ' '),
    office: bundle.office,
    lawyerName: bundle.lawyerName,
    firmName: config().FIRM_NAME,
    todayDate: today,
  };
}

export interface GenerationOutcome {
  documentVersionId: string;
  versionNo: number;
  missingDeterministic: string[];
  missingFacts: string[];
  citedChunkIds: string[];
}

export async function runDraftGeneration(input: GenerateInput): Promise<GenerationOutcome> {
  const [document] = await db
    .select({
      id: documents.id,
      matterId: documents.matterId,
      templateId: documents.templateId,
      title: documents.title,
      state: documents.state,
    })
    .from(documents)
    .where(eq(documents.id, input.documentId))
    .limit(1);

  if (!document) throw new Error(`Document ${input.documentId} not found`);
  if (document.state === 'final') {
    throw new Error('Document is final; generate a new draft on a new document');
  }
  if (!document.templateId) throw new Error('Document has no template');

  const [template] = await db
    .select()
    .from(documentTemplates)
    .where(eq(documentTemplates.id, document.templateId))
    .limit(1);
  if (!template) throw new Error('Template not found');

  const bundle = await loadBundle(document.matterId);
  if (!bundle) throw new Error('Matter not found');

  const actor = await loadActorForRetrieval(input.actorUserId);

  const vault = vaultForMatter({
    clientName: bundle.clientName,
    clientEmail: bundle.clientEmail,
    clientPhone: bundle.clientPhone,
    clientIdNumber: bundle.clientIdNumber,
    matterReference: bundle.reference,
  });

  try {
    const deterministic = buildDeterministic(bundle);
    const aiBlocks: Record<string, string> = {};
    const allMissingFacts: string[] = [];
    const allCitedChunks: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let modelVersion = '';

    for (const block of template.placeholderSchema.ai) {
      // Retrieve precedent for this block, permission-scoped to the drafter.
      const retrieval = actor
        ? await retrievePrecedent({
            actor,
            query: `${block.label} — ${bundle.practiceArea.replace(/_/g, ' ')} — ${bundle.title}`,
            filters: { practiceArea: bundle.practiceArea as never },
            limit: 5,
          })
        : { results: [], lowConfidence: true, rewrittenQuery: '', keywords: [] };

      const excerpts = retrieval.results
        .map(
          (r, i) =>
            `[source ${i + 1} | ${r.sourceFilename ?? r.matterReference ?? 'firm precedent'}` +
            `${r.locator ? `, ${r.locator}` : ''}]\n${vault.redact(r.text)}`,
        )
        .join('\n\n');

      // Everything the model sees is tokenised and fenced.
      const factsBlock = vault.redact(
        [
          `Matter reference: ${deterministic.matterReference}`,
          `Practice area: ${deterministic.practiceArea}`,
          `Matter title: ${bundle.title}`,
          `Client: ${deterministic.clientName}`,
          bundle.clientNotes ? `Notes on file: ${bundle.clientNotes}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );

      const result = await generateStructured({
        system: DRAFTING_SYSTEM,
        schema: clauseDraftSchema,
        toolName: 'record_clause',
        toolDescription: 'Record the drafted clause text.',
        jsonSchema: clauseDraftJsonSchema as unknown as Record<string, unknown>,
        messages: [
          {
            role: 'user',
            content:
              `Draft: ${block.label}\n\n${block.instruction}\n\n` +
              `${wrapUntrusted('matter_facts', factsBlock)}\n\n` +
              (excerpts
                ? `${wrapUntrusted('retrieved_precedent', excerpts)}\n\n` +
                  'Draw on the structure and reasoning of the excerpts. Do not copy them.'
                : 'No firm precedent was retrieved for this block. Draft from the facts alone.'),
          },
        ],
        maxTokens: 4096,
        temperature: 0.3,
        ctx: {
          task: 'draft.clause',
          actorUserId: input.actorUserId,
          matterId: document.matterId,
        },
      });

      // Rehydrate before the text is stored or shown to a human.
      aiBlocks[block.name] = vault.rehydrate(result.data.text);
      allMissingFacts.push(...result.data.missingFacts);
      allCitedChunks.push(...retrieval.results.map((r) => r.chunkId));

      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      costUsd += result.costUsd;
      modelVersion = result.model;
    }

    const templateBuffer = await getObject(template.storageKey);
    const assembled = assembleDocx({ templateBuffer, deterministic, aiBlocks });

    const [previous] = await db
      .select({ versionNo: documentVersions.versionNo, aiBlocks: documentVersions.aiBlocks })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, document.id))
      .orderBy(desc(documentVersions.versionNo))
      .limit(1);

    const versionNo = (previous?.versionNo ?? 0) + 1;
    const key = storageKey({
      kind: 'document',
      matterId: document.matterId,
      id: document.id,
      filename: `${document.title} v${versionNo}.docx`,
    });

    await putObject({
      key,
      body: assembled.buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const [version] = await db
      .insert(documentVersions)
      .values({
        documentId: document.id,
        versionNo,
        storageKey: key,
        generatedBy: 'ai',
        modelVersion,
        // FR-4.4: the exact prompt that produced this version.
        promptHash: DRAFTING_SYSTEM.hash,
        generationInputs: {
          templateId: template.id,
          templateVersion: template.version,
          deterministicKeys: Object.keys(deterministic),
          aiBlockNames: template.placeholderSchema.ai.map((b) => b.name),
          missingDeterministic: assembled.missingDeterministic,
          embeddingModelVersion: config().EMBEDDING_MODEL_VERSION,
        },
        citedChunkIds: [...new Set(allCitedChunks)],
        aiBlocks,
        changeSummary: summariseChanges(previous?.aiBlocks ?? {}, aiBlocks),
        inputTokens,
        outputTokens,
        costUsd: costUsd.toFixed(6),
        createdByUserId: input.actorUserId,
      })
      .returning({ id: documentVersions.id });

    if (!version) throw new Error('Could not record document version');

    await db
      .update(documents)
      .set({ currentVersionId: version.id, state: 'draft' })
      .where(eq(documents.id, document.id));

    await audit({
      action: AUDIT_ACTIONS.DOCUMENT_GENERATE,
      actorUserId: input.actorUserId,
      entityType: 'document_version',
      entityId: version.id,
      matterId: document.matterId,
      metadata: {
        versionNo,
        modelVersion,
        promptHash: DRAFTING_SYSTEM.hash,
        missingDeterministic: assembled.missingDeterministic,
        citedChunkCount: new Set(allCitedChunks).size,
        tokenisedIdentifiers: vault.stats().registered,
      },
    });

    return {
      documentVersionId: version.id,
      versionNo,
      missingDeterministic: assembled.missingDeterministic,
      missingFacts: [...new Set(allMissingFacts)],
      citedChunkIds: [...new Set(allCitedChunks)],
    };
  } finally {
    // The tokenisation map never outlives the request (AI-1).
    vault.dispose();
  }
}

/** Rebuild the drafter's Actor so retrieval is scoped to them, not to the job. */
async function loadActorForRetrieval(userId: string): Promise<Actor | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      roleId: users.roleId,
      roleName: roles.name,
      office: users.office,
      status: users.status,
      practiceAreas: users.practiceAreas,
      sessionEpoch: users.sessionEpoch,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    roleId: row.roleId,
    roleName: row.roleName,
    office: row.office,
    status: row.status,
    practiceAreas: row.practiceAreas,
    grants: await loadGrants(row.roleId),
    masksClientIdentifiers: row.roleName === ROLE_NAMES.PUPIL,
    sessionEpoch: row.sessionEpoch,
  };
}
