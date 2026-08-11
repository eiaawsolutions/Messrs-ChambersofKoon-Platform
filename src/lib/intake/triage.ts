import 'server-only';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { enquiries, enquiryMessages } from '@/lib/db/schema';
import { generateStructured, generateText, AiSchemaError } from '@/lib/ai/client';
import { INTAKE_SYSTEM, INTAKE_BRIEF_SYSTEM, wrapUntrusted } from '@/lib/ai/prompts';
import { caseBriefJsonSchema, caseBriefSchema, type CaseBrief } from '@/lib/ai/schemas';
import { scrubFreeText } from '@/lib/ai/tokenise';
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

function looksComplete(reply: string, turnCount: number): boolean {
  // The prompt tells the agent to say so and stop asking. Trailing questions
  // are the reliable signal that it has not finished.
  const asksAQuestion = /\?\s*$/.test(reply.trim());
  return !asksAQuestion && turnCount >= 3;
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

  const cleaned = scrubFreeText(params.userMessage).slice(0, 4000);

  await db.insert(enquiryMessages).values({
    enquiryId: params.enquiryId,
    role: 'user',
    content: cleaned,
  });

  const messages = [
    ...history.map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    })),
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
  return { reply, turnCount, readyForBrief: looksComplete(reply, turnCount / 2) };
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

/** Most recent enquiry for a widget session, used to continue a conversation. */
export async function findEnquiryBySession(sessionToken: string): Promise<string | null> {
  const [row] = await db
    .select({ id: enquiries.id })
    .from(enquiries)
    .where(eq(enquiries.sessionToken, sessionToken))
    .orderBy(desc(enquiries.createdAt))
    .limit(1);
  return row?.id ?? null;
}
