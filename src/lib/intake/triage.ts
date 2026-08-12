import 'server-only';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { enquiries, enquiryMessages, type PracticeArea } from '@/lib/db/schema';
import { isResumable } from '@/lib/intake/session';
import {
  enquiryTypeById,
  isMismatched,
  practiceAreaForEnquiryType,
} from '@/lib/intake/enquiry-types';
import { generateStructured, generateText, AiSchemaError } from '@/lib/ai/client';
import { INTAKE_SYSTEM, INTAKE_BRIEF_SYSTEM, wrapUntrusted } from '@/lib/ai/prompts';
import { caseBriefJsonSchema, caseBriefSchema, type CaseBrief } from '@/lib/ai/schemas';
import { extractContactDetails, scrubFreeText } from '@/lib/ai/tokenise';
import { contactPatchFromBrief } from '@/lib/intake/brief-contact';
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

/**
 * The percentage a lawyer reads at a glance.
 *
 * The number stays on screen beside it — a band alone would hide the
 * difference between 61% and 94%, and 61% is a materially different thing to
 * hand a fee earner even though both clear the threshold.
 */
export function confidenceBand(confidence: number): 'High' | 'Medium' | 'Low' {
  if (confidence >= 85) return 'High';
  if (confidence >= CONFIDENCE_THRESHOLD) return 'Medium';
  return 'Low';
}

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
 * The firm's website form would not submit without a name, an email, a contact
 * number and an enquiry type, and the widget now opens with that same form —
 * so for any enquiry started since, all four are on file before the first
 * word. `detailsOnFile` says so, and it changes what "finished" means: the
 * only thing outstanding is the facts, so the moment the agent stops asking,
 * there is nothing left to hold the person for.
 *
 * The graduated rules below still apply to everything else — enquiries opened
 * before the form existed, and anything a member of staff enters by hand —
 * where contact details have to be recovered from the conversation itself:
 *
 *  1. **Both ways to reach them.** The conversation now holds what the form
 *     would have captured. Continuing to interrogate is how people abandon an
 *     enquiry; a lawyer can ask the rest at the consultation.
 *  2. **One way only.** Hold on for a turn so the agent can ask for the other,
 *     then close anyway. Pressing twice loses the enquiry entirely, and an
 *     enquiry with one channel is worth more than none.
 *  3. The agent stopped asking questions, as the prompt instructs.
 *  4. The hard cap, so a chatty model cannot trap anyone in a loop.
 *
 * The name is not checked here because it cannot be reliably detected mid
 * conversation — it is enforced on the brief, where a model reading the whole
 * transcript can tell whether one was given.
 */
export function looksComplete(params: {
  reply: string;
  exchanges: number;
  hasEmail: boolean;
  hasPhone: boolean;
  /** The opening form supplied name, email, number and type up front. */
  detailsOnFile?: boolean;
}): boolean {
  if (params.exchanges >= FORCE_BRIEF_AFTER_EXCHANGES) return true;

  const asksAQuestion = /\?\s*$/.test(params.reply.trim());

  // Nothing is outstanding but the facts, and the agent has just said it has
  // them. Holding for another round would be asking a question we do not need
  // the answer to — which is exactly how a form that already worked gets a
  // reputation for being slower than an email.
  if (params.detailsOnFile && !asksAQuestion && params.exchanges >= 2) return true;

  if (params.hasEmail && params.hasPhone && params.exchanges >= 4) return true;
  if ((params.hasEmail || params.hasPhone) && params.exchanges >= 5) return true;

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

  const [enquiryRow] = await db
    .select({
      name: enquiries.contactName,
      email: enquiries.contactEmail,
      phone: enquiries.contactPhone,
      enquiryTypeSelected: enquiries.enquiryTypeSelected,
    })
    .from(enquiries)
    .where(eq(enquiries.id, params.enquiryId))
    .limit(1);

  /**
   * Read from the enquiry rather than taken from the caller.
   *
   * The opening form writes all four before the first turn, so the row is
   * authoritative and stays right on turn five — where a flag passed in by the
   * route handler would already have been lost. It is also not something an
   * unauthenticated caller should be able to assert about their own enquiry.
   */
  const detailsOnFile = Boolean(
    enquiryRow?.name && enquiryRow.email && enquiryRow.phone && enquiryRow.enquiryTypeSelected,
  );

  // Capture contact details from the raw message before the scrub destroys
  // them, then store them on the enquiry. The model only ever sees the
  // placeholder (AI-1); the firm keeps the real value.
  //
  // Only ever fills a blank. Since the opening form became mandatory the
  // enquiry already holds a validated, normalised address and number, and the
  // addresses that appear later in a transcript are usually somebody else's —
  // an ex-spouse's email, the other side's solicitor. Overwriting on sight
  // would quietly redirect the firm's reply to the opposing party.
  const contact = extractContactDetails(params.userMessage);
  const patch: Record<string, string> = {};
  if (contact.email && !enquiryRow?.email) patch.contactEmail = contact.email;
  if (contact.phone && !enquiryRow?.phone) patch.contactPhone = contact.phone;
  if (Object.keys(patch).length > 0) {
    await db.update(enquiries).set(patch).where(eq(enquiries.id, params.enquiryId));
  }

  const hasEmail = Boolean(enquiryRow?.email ?? contact.email);
  const hasPhone = Boolean(enquiryRow?.phone ?? contact.phone);

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
      hasEmail,
      hasPhone,
      detailsOnFile,
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

  const [current] = await db
    .select({
      enquiryTypeSelected: enquiries.enquiryTypeSelected,
      contactName: enquiries.contactName,
      contactEmail: enquiries.contactEmail,
      contactPhone: enquiries.contactPhone,
    })
    .from(enquiries)
    .where(eq(enquiries.id, enquiryId))
    .limit(1);
  const selectedType = current?.enquiryTypeSelected ?? null;

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

  // A person who picked "Property & Land" from the firm's own list has told us
  // something the classifier just failed to extract. Prefer their answer over
  // `general`, which routes nowhere: no availability rule and no template is
  // scoped to it. Only `general` is overridden — a specific classification
  // that disagrees with the selection is a real disagreement, and gets shown
  // to a lawyer rather than quietly resolved either way.
  const practiceArea =
    brief.practiceArea === 'general'
      ? (practiceAreaForEnquiryType(selectedType) ?? brief.practiceArea)
      : brief.practiceArea;

  const mismatched = isMismatched(selectedType, practiceArea);

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

  const briefMarkdown = renderBriefMarkdown(brief, {
    selectedType,
    practiceArea,
    mismatched,
  });

  /*
   * The brief is the weakest source of contact detail on the platform, because
   * the model that wrote it read a scrubbed transcript and so reports the
   * enquirer's email as `[EMAIL]`. Taking it at face value here replaced the
   * address the opening form had validated with a placeholder, and the damage
   * only surfaced when a lawyer accepted the consultation and the mail
   * transport rejected the recipient. See `contactPatchFromBrief` for the rules.
   */
  const contactPatch = contactPatchFromBrief(
    {
      name: current?.contactName ?? null,
      email: current?.contactEmail ?? null,
      phone: current?.contactPhone ?? null,
    },
    brief,
  );

  await db
    .update(enquiries)
    .set({
      ...contactPatch,
      practiceAreaPredicted: practiceArea,
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
export function renderBriefMarkdown(
  brief: CaseBrief,
  routing?: {
    selectedType: string | null;
    practiceArea: PracticeArea;
    mismatched: boolean;
  },
): string {
  const sections: string[] = [];

  if (brief.safetyConcern) {
    sections.push('> **Safety concern disclosed during intake. Handle personally.**');
  }

  // Surfaced, never resolved silently. One of the two is wrong and it is not
  // always the client — someone who picks "Corporate & Commercial" and then
  // describes a tenancy dispute may have misread the list, or may have a
  // corporate landlord and be entirely right.
  if (routing?.mismatched) {
    const selected = enquiryTypeById(routing.selectedType);
    sections.push(
      `> **Check the routing.** The enquirer chose ${selected?.label ?? routing.selectedType}; ` +
        `this has been filed as ${routing.practiceArea.replace(/_/g, ' ')}. Confirm before the consultation.`,
    );
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
