import 'server-only';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { enquiries, enquiryMessages } from '@/lib/db/schema';
import { isResumable } from '@/lib/intake/session';
import { generateStructured, generateText, AiSchemaError } from '@/lib/ai/client';
import { INTAKE_SYSTEM, INTAKE_BRIEF_SYSTEM, wrapUntrusted } from '@/lib/ai/prompts';
import { caseBriefJsonSchema, caseBriefSchema, type CaseBrief } from '@/lib/ai/schemas';
import { extractContactDetails, scrubFreeText } from '@/lib/ai/tokenise';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Intake triage agent (M2, FR-2.4 – FR-2.6).
 *
 * Two model calls with different jobs:
 *
 *  1. `respondToTurn` — the conversation the enquirer actually sees. Sonnet
 *     class, guarded by INTAKE_SYSTEM against giving legal advice, quoting
 *     fees or promising outcomes (AI-4).
 *  2. `buildCaseBrief` — a separate structured pass over the finished
 *     transcript. Kept separate so the brief is derived from what was said
 *     rather than assembled incrementally by a model that is also trying to
 *     hold a conversation.
 *
 * Everything the enquirer typed is treated as untrusted data, wrapped in
 * delimiters, and structurally scrubbed for identifier shapes before it
 * reaches the model (OWASP LLM01, AI-1).
 */

/** Below this, the enquiry goes to a human instead of proposing a slot (FR-2.6). */
export const CONFIDENCE_THRESHOLD = 60;

/** A conversation this long is either abuse or a person who needs a human. */
const MAX_TURNS = 24;

export interface TurnResult {
  reply: string;
  turnCount: number;
  /** True once the agent signals it has enough to brief a lawyer. */
  readyForBrief: boolean;
}

/** After this many exchanges, brief regardless — an endless intake helps nobody. */
const FORCE_BRIEF_AFTER_EXCHANGES = 6;

/**
 * Has the conversation reached the point of handing over to a lawyer?
 *
 * Three ways to be done, in order of strength:
 *
 *  1. **Contact details are on file** after a few exchanges. Someone who has
 *     given their name and a way to reach them has finished telling their
 *     story; continuing to interrogate is how people abandon an enquiry. A
 *     lawyer can ask the rest at the consultation — that is what it is for.
 *  2. The agent stopped asking questions, as the prompt instructs.
 *  3. The hard cap, so a chatty model cannot trap anyone in a loop.
 */
function looksComplete(params: {
  reply: string;
  exchanges: number;
  hasContactDetails: boolean;
}): boolean {
  if (params.exchanges >= FORCE_BRIEF_AFTER_EXCHANGES) return true;
  if (params.hasContactDetails && params.exchanges >= 4) return true;

  const asksAQuestion = /\?\s*$/.test(params.reply.trim());
  return !asksAQuestion && params.exchanges >= 3;
}

/** One conversational turn. Persists both sides of the exchange. */
export async function respondToTurn(params: {
  enquiryId: string;
  userMessage: string;
}): Promise<TurnResult> {
  const history = await db
    .select({ role: enquiryMessages.role, content: enquiryMessages.content })
    .from(enquiryMessages)
    .where(eq(enquiryMessages.enquiryId, params.enquiryId))
    .orderBy(enquiryMessages.createdAt);

  if (history.length >= MAX_TURNS * 2) {
    return {
      reply:
        'Thank you — I have enough to pass this to the team. Someone from the firm will ' +
        'be in touch. If this is urgent, please call the office.',
      turnCount: history.length,
      readyForBrief: true,
    };
  }

  // Capture contact details from the raw message before the scrub destroys
  // them, then store them on the enquiry. The model only ever sees the
  // placeholder (AI-1); the firm keeps the real value.
  const contact = extractContactDetails(params.userMessage);
  if (contact.email || contact.phone) {
    const patch: Record<string, string> = {};
    if (contact.email) patch.contactEmail = contact.email;
    if (contact.phone) patch.contactPhone = contact.phone;
    await db.update(enquiries).set(patch).where(eq(enquiries.id, params.enquiryId));
  }

  const [enquiryRow] = await db
    .select({ email: enquiries.contactEmail, phone: enquiries.contactPhone })
    .from(enquiries)
    .where(eq(enquiries.id, params.enquiryId))
    .limit(1);
  const hasContactDetails = Boolean(
    contact.email || contact.phone || enquiryRow?.email || enquiryRow?.phone,
  );

  const cleaned = scrubFreeText(params.userMessage).slice(0, 4000);

  await db.insert(enquiryMessages).values({
    enquiryId: params.enquiryId,
    role: 'user',
    content: cleaned,
  });

  // Earlier turns are replayed wrapped too. Only the newest message used to
  // be fenced, so an instruction planted on turn one arrived unfenced on turn
  // two and read as though the firm had written it (OWASP LLM01).
  const messages = [
    ...history.map((m) =>
      m.role === 'assistant'
        ? { role: 'assistant' as const, content: m.content }
        : { role: 'user' as const, content: wrapUntrusted('enquirer_message', m.content) },
    ),
    {
      role: 'user' as const,
      content: wrapUntrusted('enquirer_message', cleaned),
    },
  ];

  const result = await generateText({
    system: INTAKE_SYSTEM,
    messages,
    maxTokens: 1024,
    temperature: 0.4,
    ctx: { task: 'intake.conversation' },
  });

  const reply = result.text.trim();

  await db.insert(enquiryMessages).values({
    enquiryId: params.enquiryId,
    role: 'assistant',
    content: reply,
  });

  const turnCount = history.length + 2;
  return {
    reply,
    turnCount,
    readyForBrief: looksComplete({
      reply,
      exchanges: Math.floor(turnCount / 2),
      hasContactDetails,
    }),
  };
}

export interface TriageOutcome {
  brief: CaseBrief;
  /** False when confidence is low or the brief is incomplete (FR-2.6). */
  autoProposeSlot: boolean;
  reason: string;
}

/**
 * Turn a finished conversation into a case brief and decide whether the
 * platform may propose a slot automatically.
 *
 * A malformed structured response fails to the human review queue rather than
 * producing a partial brief (AI-3).
 */
export async function buildCaseBrief(enquiryId: string): Promise<TriageOutcome> {
  const transcript = await db
    .select({ role: enquiryMessages.role, content: enquiryMessages.content })
    .from(enquiryMessages)
    .where(eq(enquiryMessages.enquiryId, enquiryId))
    .orderBy(enquiryMessages.createdAt);

  if (transcript.length === 0) {
    throw new Error(`Enquiry ${enquiryId} has no conversation to summarise`);
  }

  const rendered = transcript
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'Enquirer'}: ${m.content}`)
    .join('\n\n');

  let result;
  try {
    result = await generateStructured({
      system: INTAKE_BRIEF_SYSTEM,
      schema: caseBriefSchema,
      toolName: 'record_case_brief',
      toolDescription: 'Record the structured case brief for the lawyer.',
      jsonSchema: caseBriefJsonSchema as unknown as Record<string, unknown>,
      messages: [{ role: 'user', content: wrapUntrusted('intake_transcript', rendered) }],
      maxTokens: 2048,
      temperature: 0.1,
      ctx: { task: 'intake.brief' },
    });
  } catch (error) {
    if (error instanceof AiSchemaError) {
      await db.update(enquiries).set({ status: 'needs_review' }).where(eq(enquiries.id, enquiryId));
      await audit({
        action: AUDIT_ACTIONS.ENQUIRY_TRIAGED,
        entityType: 'enquiry',
        entityId: enquiryId,
        metadata: { outcome: 'needs_review', reason: 'structured_output_failed' },
      });
    }
    throw error;
  }

  const brief = result.data;

  // FR-2.6 and the safety escalation both route to a human rather than
  // proposing a slot. A safety concern needs a person, not a calendar entry.
  const lowConfidence = brief.confidence < CONFIDENCE_THRESHOLD;
  const autoProposeSlot = !lowConfidence && brief.complete && !brief.safetyConcern;

  const reason = brief.safetyConcern
    ? 'Safety concern disclosed — routed for immediate human attention'
    : lowConfidence
      ? `Classification confidence ${brief.confidence}% is below the ${CONFIDENCE_THRESHOLD}% threshold`
      : !brief.complete
        ? 'Conversation ended before the basics were gathered'
        : 'Ready to propose a consultation slot';

  const briefMarkdown = renderBriefMarkdown(brief);

  await db
    .update(enquiries)
    .set({
      contactName: brief.contactName || null,
      contactEmail: brief.contactEmail || null,
      contactPhone: brief.contactPhone || null,
      practiceAreaPredicted: brief.practiceArea,
      urgency: brief.safetyConcern ? 'critical' : brief.urgency,
      confidence: brief.confidence,
      caseBriefMd: briefMarkdown,
      status: autoProposeSlot ? 'triaged' : 'needs_review',
      modelVersion: result.model,
      promptHash: result.promptHash,
    })
    .where(eq(enquiries.id, enquiryId));

  await audit({
    action: AUDIT_ACTIONS.ENQUIRY_TRIAGED,
    entityType: 'enquiry',
    entityId: enquiryId,
    metadata: {
      practiceArea: brief.practiceArea,
      urgency: brief.urgency,
      confidence: brief.confidence,
      safetyConcern: brief.safetyConcern,
      autoProposeSlot,
      modelVersion: result.model,
      promptHash: result.promptHash,
    },
  });

  return { brief, autoProposeSlot, reason };
}

/** The brief a lawyer reads on the dashboard and in the notification email. */
export function renderBriefMarkdown(brief: CaseBrief): string {
  const sections: string[] = [];

  if (brief.safetyConcern) {
    sections.push('> **Safety concern disclosed during intake. Handle personally.**');
  }

  sections.push(`**Summary**\n\n${brief.summary}`);

  if (brief.facts.length > 0) {
    sections.push(`**Facts stated**\n\n${brief.facts.map((f) => `- ${f}`).join('\n')}`);
  }

  if (brief.openQuestions.length > 0) {
    sections.push(
      `**Still to establish**\n\n${brief.openQuestions.map((q) => `- ${q}`).join('\n')}`,
    );
  }

  sections.push(`**Suggested next step**\n\n${brief.suggestedNextStep}`);

  return sections.join('\n\n');
}

/**
 * The enquiry a widget session may continue, or null to start a fresh one.
 *
 * A matching token is necessary but not sufficient — see `isResumable`. A
 * token that names a handed-over or long-idle enquiry is not an error and is
 * not reported as one; the caller simply opens a new conversation, which is
 * what the person at the keyboard is actually doing.
 */
export async function findEnquiryBySession(sessionToken: string): Promise<string | null> {
  const [row] = await db
    .select({
      id: enquiries.id,
      status: enquiries.status,
      createdAt: enquiries.createdAt,
      lastMessageAt: sql<Date | null>`(
        select max(m.created_at) from enquiry_messages m where m.enquiry_id = ${enquiries.id}
      )`,
    })
    .from(enquiries)
    .where(eq(enquiries.sessionToken, sessionToken))
    .orderBy(desc(enquiries.createdAt))
    .limit(1);

  if (!row) return null;

  const lastActivityAt = row.lastMessageAt ? new Date(row.lastMessageAt) : row.createdAt;
  return isResumable({ status: row.status, lastActivityAt }) ? row.id : null;
}
