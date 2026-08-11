import { z } from 'zod';

/**
 * Structured-output contracts (AI-3).
 *
 * Each export pairs a Zod schema (validated on the way back) with the JSON
 * Schema sent to the model as a tool definition. They are written out by hand
 * rather than derived, because the JSON Schema doubles as prompt surface — the
 * field descriptions are instructions the model reads, and they are worded for
 * that purpose.
 */

export const PRACTICE_AREAS = [
  'family_matrimonial',
  'debt_recovery',
  'land_property',
  'corporate_disputes',
  'general',
] as const;

export const URGENCIES = ['low', 'normal', 'high', 'critical'] as const;

// ---------------------------------------------------------------------------
// Practice-area classification
// ---------------------------------------------------------------------------

export const classificationSchema = z.object({
  practiceArea: z.enum(PRACTICE_AREAS),
  urgency: z.enum(URGENCIES),
  confidence: z.number().int().min(0).max(100),
  reasoning: z.string().max(500),
});

export type Classification = z.infer<typeof classificationSchema>;

export const classificationJsonSchema = {
  type: 'object',
  properties: {
    practiceArea: {
      type: 'string',
      enum: [...PRACTICE_AREAS],
      description: 'The single practice area this enquiry belongs to.',
    },
    urgency: {
      type: 'string',
      enum: [...URGENCIES],
      description:
        'critical = safety at risk or a deadline within days. high = deadline within weeks or ' +
        'active proceedings. normal = no imminent deadline. low = exploratory.',
    },
    confidence: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description:
        'How certain you are of the practice area. Score below 60 if the enquiry is vague, ' +
        'spans several unrelated problems, or you are guessing. A low score routes to a human, ' +
        'which is the correct outcome when you are unsure.',
    },
    reasoning: {
      type: 'string',
      description: 'One or two sentences on what decided the classification.',
    },
  },
  required: ['practiceArea', 'urgency', 'confidence', 'reasoning'],
} as const;

// ---------------------------------------------------------------------------
// Intake case brief
// ---------------------------------------------------------------------------

/**
 * A list field the model may hand back in a slightly different shape.
 *
 * Live intake failed on exactly this: `facts` came back as one prose string
 * and `openQuestions` was omitted entirely, so validation failed twice and the
 * whole brief was discarded — a lawyer got nothing because a list arrived as a
 * sentence. The content was there and usable.
 *
 * Normalising is not the same as accepting a partial result. AI-3's "never
 * render a partial draft" governs drafting, where an invented clause is
 * dangerous. A brief whose facts arrived as prose is complete; it is shaped
 * differently. Anything genuinely absent becomes an empty list, which the UI
 * already renders as "nothing recorded".
 */
function tolerantStringList(maxLength: number, maxItems: number) {
  return z.preprocess(
    (value) => {
      if (Array.isArray(value)) return value.map((item) => String(item));
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];
        // Prose arrives as a paragraph, or as its own bulleted/numbered list.
        const lines = trimmed
          .split(/\r?\n+/)
          .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
          .filter(Boolean);
        return lines.length > 1 ? lines : [trimmed];
      }
      return [];
    },
    z.array(z.string().max(maxLength)).max(maxItems),
  );
}

export const caseBriefSchema = z.object({
  contactName: z.string().max(200).catch(''),
  contactEmail: z.string().max(320).catch(''),
  contactPhone: z.string().max(40).catch(''),
  practiceArea: z.enum(PRACTICE_AREAS),
  urgency: z.enum(URGENCIES),
  confidence: z.number().int().min(0).max(100),
  summary: z.string().min(1).max(2000),
  facts: tolerantStringList(500, 20),
  openQuestions: tolerantStringList(300, 10),
  suggestedNextStep: z.string().max(300).catch(''),
  safetyConcern: z.boolean().catch(false),
  complete: z.boolean().catch(true),
});

export type CaseBrief = z.infer<typeof caseBriefSchema>;

export const caseBriefJsonSchema = {
  type: 'object',
  properties: {
    contactName: {
      type: 'string',
      description: 'The name the person gave. Empty string if they did not give one.',
    },
    contactEmail: {
      type: 'string',
      description: 'The email they gave, verbatim. Empty string if none. Never invent one.',
    },
    contactPhone: {
      type: 'string',
      description: 'The phone number they gave, verbatim. Empty string if none.',
    },
    practiceArea: { type: 'string', enum: [...PRACTICE_AREAS] },
    urgency: { type: 'string', enum: [...URGENCIES] },
    confidence: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Confidence in the practice-area classification. Below 60 routes to a human.',
    },
    summary: {
      type: 'string',
      description:
        'What has happened, in three to six sentences, in plain English. Written for a lawyer ' +
        'reading it two minutes before the consultation. Facts only, no analysis or advice.',
    },
    facts: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Discrete facts the person stated, one per item, e.g. "Married 11 years", ' +
        '"Two children aged 6 and 9", "Both parties agree to divorce". Only what was actually ' +
        'said. Do not infer.',
    },
    openQuestions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Things the lawyer still needs to ask, because they were not covered or the person ' +
        'did not know.',
    },
    suggestedNextStep: {
      type: 'string',
      description:
        'A procedural next step for the firm, e.g. "First consultation with the family law lead". ' +
        'Never advice directed at the client.',
    },
    safetyConcern: {
      type: 'boolean',
      description:
        'True if the person described violence, threats, or immediate risk to someone. This ' +
        'escalates regardless of urgency.',
    },
    complete: {
      type: 'boolean',
      description:
        'True when there is enough here to run a first consultation. False if the conversation ' +
        'ended before the basics were gathered.',
    },
  },
  required: [
    'contactName',
    'contactEmail',
    'contactPhone',
    'practiceArea',
    'urgency',
    'confidence',
    'summary',
    'facts',
    'openQuestions',
    'suggestedNextStep',
    'safetyConcern',
    'complete',
  ],
} as const;

// ---------------------------------------------------------------------------
// Retrieval query rewrite
// ---------------------------------------------------------------------------

export const queryRewriteSchema = z.object({
  semanticQuery: z.string().min(1).max(1000),
  keywords: z.array(z.string().max(80)).min(1).max(8),
  practiceArea: z.enum(PRACTICE_AREAS).nullable(),
});

export type QueryRewrite = z.infer<typeof queryRewriteSchema>;

export const queryRewriteJsonSchema = {
  type: 'object',
  properties: {
    semanticQuery: {
      type: 'string',
      description: 'A clean restatement of the legal substance, for vector search.',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 8,
      description:
        'High-signal terms for keyword search: party types, causes of action, document types, ' +
        'procedural terms. Keep any party or matter name exactly as the lawyer wrote it.',
    },
    practiceArea: {
      type: ['string', 'null'],
      enum: [...PRACTICE_AREAS, null],
      description: 'The practice area if clearly implied by the query, otherwise null.',
    },
  },
  required: ['semanticQuery', 'keywords', 'practiceArea'],
} as const;

// ---------------------------------------------------------------------------
// Document drafting — one AI block at a time
// ---------------------------------------------------------------------------

export const clauseDraftSchema = z.object({
  // The clause itself stays strict. AI-3 is explicit that a malformed draft
  // fails to a human rather than rendering partially, and an absent or
  // truncated clause is exactly that.
  text: z.string().min(1).max(20_000),
  // The two lists around it are reporting, not content. A usable clause should
  // not be thrown away because its accompanying checklist arrived as prose.
  missingFacts: tolerantStringList(300, 20),
  citedSources: tolerantStringList(120, 20),
});

export type ClauseDraft = z.infer<typeof clauseDraftSchema>;

export const clauseDraftJsonSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description:
        'The clause body only. No heading, no preamble, no explanation. Use [TO CONFIRM: …] ' +
        'inline where a required fact was not supplied.',
    },
    missingFacts: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Every fact you needed but were not given, matching each [TO CONFIRM: …] you wrote. ' +
        'The lawyer sees this list as a checklist before finalising.',
    },
    citedSources: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The reference ids of retrieved precedent excerpts you actually drew on. Empty if none. ' +
        'Never list a source you did not use.',
    },
  },
  required: ['text', 'missingFacts', 'citedSources'],
} as const;
