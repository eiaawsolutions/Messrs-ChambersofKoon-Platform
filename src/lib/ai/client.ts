import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { and, gte, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { aiUsageEvents } from '@/lib/db/schema';
import { config, secret } from '@/lib/config/env';
import type { VersionedPrompt } from '@/lib/ai/prompts';

/**
 * Anthropic client, model routing, cost ledger and spend ceiling (PRD §6.1, AI-3, AI-6).
 *
 * Model IDs are configuration, never constants in code (§6.1), so the firm can
 * move to a newer Claude release without a deploy. Every call records the exact
 * model version used, its token counts and its cost.
 */

/** Task -> model class routing (PRD §6.1). */
export type AiTask =
  | 'intake.conversation'
  | 'intake.brief'
  | 'classify.practice_area'
  | 'draft.clause'
  | 'ocr.extract'
  | 'rag.query_rewrite';

const TASK_MODEL_CLASS: Record<AiTask, 'drafting' | 'classify' | 'vision'> = {
  'intake.conversation': 'drafting', // Sonnet-class: streaming, structured capture
  'intake.brief': 'drafting',
  'classify.practice_area': 'classify', // Haiku-class: cheap, high volume
  'draft.clause': 'drafting', // Sonnet-class: highest quality, low volume
  'ocr.extract': 'vision',
  'rag.query_rewrite': 'classify', // Haiku-class: cheap
};

/**
 * Whether to send `temperature`.
 *
 * Model IDs are configuration, not constants (PRD §6.1), so this code has to
 * survive being pointed at a model with different parameter support. Newer
 * Claude models reject `temperature` outright — the request fails with
 * "temperature is deprecated for this model", which took down intake the first
 * time a live enquiry hit it.
 *
 * Default is to omit it. The prompts are explicit enough that sampling
 * temperature was never carrying much, and an omitted optional parameter can
 * never be the reason a client's enquiry fails.
 */
function sendTemperature(): boolean {
  return process.env.AI_SEND_TEMPERATURE === 'true';
}

export function modelFor(task: AiTask): string {
  const cfg = config();
  switch (TASK_MODEL_CLASS[task]) {
    case 'drafting':
      return cfg.ANTHROPIC_MODEL_DRAFTING;
    case 'classify':
      return cfg.ANTHROPIC_MODEL_CLASSIFY;
    case 'vision':
      return cfg.ANTHROPIC_MODEL_VISION;
  }
}

/**
 * Published per-million-token prices, USD. Used for the cost ledger and the
 * monthly ceiling alert.
 *
 * These are a *local estimate*, not a billing source of truth — Anthropic's
 * invoice is authoritative. Unknown model IDs fall back to the Sonnet tier so a
 * new model never silently records as free, which would defeat the ceiling.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};
const FALLBACK_PRICE = { input: 3, output: 15 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price =
    PRICE_PER_MTOK[model] ??
    PRICE_PER_MTOK[Object.keys(PRICE_PER_MTOK).find((k) => model.startsWith(k)) ?? ''] ??
    FALLBACK_PRICE;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

let clientInstance: Anthropic | null = null;

async function client(): Promise<Anthropic> {
  if (clientInstance) return clientInstance;
  clientInstance = new Anthropic({
    apiKey: await secret('ANTHROPIC_API_KEY'),
    maxRetries: 3,
    timeout: 120_000,
  });
  return clientInstance;
}

export class AiSpendCeilingError extends Error {
  constructor(spent: number, ceiling: number) {
    super(
      `AI spend ceiling reached: $${spent.toFixed(2)} of $${ceiling.toFixed(2)} this month. ` +
        'Raise AI_MONTHLY_SPEND_CEILING_USD or wait for the next billing period.',
    );
    this.name = 'AiSpendCeilingError';
  }
}

export class AiSchemaError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = 'AiSchemaError';
    this.raw = raw;
  }
}

/** Month-to-date spend in USD. */
export async function monthToDateSpendUsd(): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${aiUsageEvents.costUsd}::numeric), 0)::text` })
    .from(aiUsageEvents)
    .where(and(gte(aiUsageEvents.createdAt, startOfMonth)));

  return Number(row?.total ?? 0);
}

/**
 * AI-6: alert before throttling.
 *
 * At 80% of the ceiling we warn but keep serving — a firm mid-draft should not
 * be cut off without notice. At 100% we stop, because an unbounded model bill
 * is a worse failure than a queued draft.
 */
async function assertWithinBudget(): Promise<void> {
  const ceiling = config().AI_MONTHLY_SPEND_CEILING_USD;
  const spent = await monthToDateSpendUsd();
  if (spent >= ceiling) {
    throw new AiSpendCeilingError(spent, ceiling);
  }
  if (spent >= ceiling * 0.8) {
    console.warn('[ai] monthly spend at %d%% of ceiling', Math.round((spent / ceiling) * 100));
  }
}

export interface AiCallContext {
  task: AiTask;
  actorUserId?: string | null;
  matterId?: string | null;
}

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
}

async function recordUsage(params: {
  ctx: AiCallContext;
  model: string;
  promptHash: string | null;
  usage: UsageLike | undefined;
  latencyMs: number;
  succeeded: boolean;
}): Promise<void> {
  const inputTokens = params.usage?.input_tokens ?? 0;
  const outputTokens = params.usage?.output_tokens ?? 0;
  try {
    await db.insert(aiUsageEvents).values({
      task: params.ctx.task,
      modelVersion: params.model,
      promptHash: params.promptHash,
      inputTokens,
      outputTokens,
      cachedInputTokens: params.usage?.cache_read_input_tokens ?? 0,
      costUsd: estimateCostUsd(params.model, inputTokens, outputTokens).toFixed(6),
      latencyMs: params.latencyMs,
      actorUserId: params.ctx.actorUserId ?? null,
      matterId: params.ctx.matterId ?? null,
      succeeded: params.succeeded,
    });
  } catch (error) {
    // Ledger failure must not fail the user's action; it is alerted on instead.
    console.error('[ai] failed to record usage', (error as Error).message);
  }
}

export interface TextCallOptions {
  system: VersionedPrompt;
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
  temperature?: number;
  ctx: AiCallContext;
}

export interface TextResult {
  text: string;
  model: string;
  promptHash: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Plain text completion. */
export async function generateText(options: TextCallOptions): Promise<TextResult> {
  await assertWithinBudget();
  const model = modelFor(options.ctx.task);
  const started = Date.now();
  const anthropic = await client();

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: options.maxTokens ?? 4096,
      ...(sendTemperature() ? { temperature: options.temperature ?? 0.3 } : {}),
      system: options.system.text,
      messages: options.messages,
    });

    const latency = Date.now() - started;
    await recordUsage({
      ctx: options.ctx,
      model,
      promptHash: options.system.hash,
      usage: response.usage,
      latencyMs: latency,
      succeeded: true,
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      model,
      promptHash: options.system.hash,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd: estimateCostUsd(model, response.usage.input_tokens, response.usage.output_tokens),
    };
  } catch (error) {
    await recordUsage({
      ctx: options.ctx,
      model,
      promptHash: options.system.hash,
      usage: undefined,
      latencyMs: Date.now() - started,
      succeeded: false,
    });
    throw error;
  }
}

export interface StructuredCallOptions<T extends z.ZodTypeAny> extends TextCallOptions {
  schema: T;
  /** Name surfaced to the model as the output tool. */
  toolName: string;
  toolDescription: string;
  /** JSON Schema for the tool input. Zod schemas are not sent directly. */
  jsonSchema: Record<string, unknown>;
}

export interface StructuredResult<T> extends Omit<TextResult, 'text'> {
  data: T;
}

/**
 * Structured output via forced tool use, validated against a Zod schema (AI-3).
 *
 * "A malformed response retries once, then fails to a human queue — never
 *  renders a partial draft."
 *
 * The retry re-sends with the validation error appended, which recovers the
 * common case of one wrong enum value or a missing optional. A second failure
 * throws AiSchemaError; every caller routes that to a human queue rather than
 * degrading to a partial result.
 */
export async function generateStructured<T extends z.ZodTypeAny>(
  options: StructuredCallOptions<T>,
): Promise<StructuredResult<z.infer<T>>> {
  await assertWithinBudget();
  const model = modelFor(options.ctx.task);
  const anthropic = await client();

  const tool: Anthropic.Tool = {
    name: options.toolName,
    description: options.toolDescription,
    input_schema: options.jsonSchema as Anthropic.Tool.InputSchema,
  };

  let messages = [...options.messages];
  let lastRaw = '';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = Date.now();
    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model,
        max_tokens: options.maxTokens ?? 4096,
        ...(sendTemperature() ? { temperature: options.temperature ?? 0.2 } : {}),
        system: options.system.text,
        messages,
        tools: [tool],
        tool_choice: { type: 'tool', name: options.toolName },
      });
    } catch (error) {
      await recordUsage({
        ctx: options.ctx,
        model,
        promptHash: options.system.hash,
        usage: undefined,
        latencyMs: Date.now() - started,
        succeeded: false,
      });
      throw error;
    }

    await recordUsage({
      ctx: options.ctx,
      model,
      promptHash: options.system.hash,
      usage: response.usage,
      latencyMs: Date.now() - started,
      succeeded: true,
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (!toolUse) {
      lastRaw = JSON.stringify(response.content);
      if (attempt === 0) {
        messages = [
          ...messages,
          { role: 'assistant', content: response.content },
          {
            role: 'user',
            content: `You must call the ${options.toolName} tool. Call it now with the required fields.`,
          },
        ];
        continue;
      }
      throw new AiSchemaError('Model did not call the output tool', lastRaw);
    }

    lastRaw = JSON.stringify(toolUse.input);
    const parsed = options.schema.safeParse(toolUse.input);

    if (parsed.success) {
      return {
        data: parsed.data as z.infer<T>,
        model,
        promptHash: options.system.hash,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        costUsd: estimateCostUsd(model, response.usage.input_tokens, response.usage.output_tokens),
      };
    }

    if (attempt === 0) {
      const issues = parsed.error.issues
        .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      messages = [
        ...messages,
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: toolUse.id,
              is_error: true,
              content: `The output did not validate:\n${issues}\nCall ${options.toolName} again with corrected values.`,
            },
          ],
        },
      ];
      continue;
    }

    throw new AiSchemaError(
      `Structured output failed validation twice: ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}`,
      lastRaw,
    );
  }

  throw new AiSchemaError('Structured output exhausted retries', lastRaw);
}

export function __resetAiClientForTests(): void {
  clientInstance = null;
}
