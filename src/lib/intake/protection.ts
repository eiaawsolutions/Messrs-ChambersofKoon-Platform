import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { config, optionalSecret, widgetAllowedOrigins } from '@/lib/config/env';
import { safeEqual } from '@/lib/security/crypto';

/**
 * Public endpoint protection (FR-2.3, NFR-1.6).
 *
 * "POST /api/public/enquiry is rate-limited per IP and session, protected by a
 *  bot check (Turnstile/hCaptcha), and restricted to the widget's origin via a
 *  CORS allow-list."
 *
 * The rate limiter is a fixed-window counter in Postgres rather than Redis: it
 * is one fewer service to run, and at the volume a boutique firm's website
 * produces the write cost is negligible. The atomic upsert means concurrent
 * requests cannot both read a stale count and let a burst through.
 */

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMITS = {
  /** Per IP: generous enough for a real conversation, tight enough to matter. */
  perIp: { limit: 40, windowSeconds: 3600 } satisfies RateLimitRule,
  /** Per widget session: one enquirer's conversation. */
  perSession: { limit: 60, windowSeconds: 3600 } satisfies RateLimitRule,
  /** New conversations per IP per day — the abuse-shaped signal. */
  newConversationPerIp: { limit: 8, windowSeconds: 86_400 } satisfies RateLimitRule,
};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Atomic fixed-window counter. The window resets when `window_start` is older
 * than the window length, which is decided inside the statement so two
 * concurrent requests cannot both reset it.
 */
export async function checkRateLimit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
  const rows = await db.execute<{ count: number; window_start: Date }>(sql`
    insert into rate_limit_buckets (key, count, window_start)
    values (${key}, 1, now())
    on conflict (key) do update set
      count = case
        when rate_limit_buckets.window_start < now() - (${rule.windowSeconds} || ' seconds')::interval
          then 1
        else rate_limit_buckets.count + 1
      end,
      window_start = case
        when rate_limit_buckets.window_start < now() - (${rule.windowSeconds} || ' seconds')::interval
          then now()
        else rate_limit_buckets.window_start
      end
    returning count, window_start
  `);

  const row = rows.rows[0];
  const count = Number(row?.count ?? 1);
  const windowStart = row?.window_start ? new Date(row.window_start) : new Date();
  const resetAt = new Date(windowStart.getTime() + rule.windowSeconds * 1000);

  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    resetAt,
  };
}

/** Housekeeping so the table does not grow without bound. */
export async function pruneRateLimits(): Promise<number> {
  const result = await db.execute(sql`
    delete from rate_limit_buckets where window_start < now() - interval '2 days'
  `);
  return result.rowCount ?? 0;
}

/**
 * CORS: only the firm's website may call the public endpoint.
 * Returns the echoed origin, or null when the origin is not allow-listed —
 * the caller then omits the CORS headers entirely rather than sending `*`.
 */
export function resolveAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const normalised = origin.replace(/\/$/, '');
  return widgetAllowedOrigins().includes(normalised) ? normalised : null;
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = resolveAllowedOrigin(origin);
  if (!allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-widget-key',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

/** Constant-time comparison of the public widget key. */
export function isValidWidgetKey(provided: string | null): boolean {
  if (!provided) return false;
  return safeEqual(provided, config().WIDGET_PUBLIC_KEY);
}

export interface TurnstileResult {
  ok: boolean;
  reason?: string;
}

/**
 * Cloudflare Turnstile verification.
 *
 * Disabled in development so the widget can be exercised locally, and that is
 * a deliberate, config-driven decision rather than an accident: TURNSTILE_ENABLED
 * is true in uat and production, and the deploy checklist verifies it.
 */
export async function verifyTurnstile(
  token: string | null,
  remoteIp: string | null,
): Promise<TurnstileResult> {
  if (!config().TURNSTILE_ENABLED) return { ok: true };
  if (!token) return { ok: false, reason: 'missing_token' };

  const secretKey = await optionalSecret('TURNSTILE_SECRET_KEY');
  if (!secretKey) return { ok: false, reason: 'not_configured' };

  const body = new FormData();
  body.append('secret', secretKey);
  body.append('response', token);
  if (remoteIp) body.append('remoteip', remoteIp);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    const payload = (await response.json()) as {
      success?: boolean;
      'error-codes'?: string[];
    };
    return payload.success === true
      ? { ok: true }
      : { ok: false, reason: payload['error-codes']?.join(',') ?? 'rejected' };
  } catch {
    // A Turnstile outage must not take the firm's enquiry form offline.
    // Failing open here is the deliberate trade: the rate limiter and the
    // origin allow-list still apply, and a spike in unverified submissions is
    // visible on the operational dashboard.
    console.warn('[intake] Turnstile verification unreachable; allowing with rate limits only');
    return { ok: true, reason: 'verification_unavailable' };
  }
}

/** First hop client IP, trusting only the proxy Railway puts in front. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? null;
  return headers.get('x-real-ip');
}
