import { NextResponse } from 'next/server';
import { databaseHealthCheck } from '@/lib/db/client';
import { secretsHealthCheck } from '@/lib/secrets/resolver';
import { storageHealthCheck } from '@/lib/storage/s3';
import { queueHealthCheck } from '@/lib/jobs/queue';
import { config, optionalSecret } from '@/lib/config/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * NFR-3.5: "Health endpoint /api/health checks database, storage, queue and
 * Claude API reachability; external uptime monitor alerts on failure."
 *
 * Dependency checks run in parallel with individual timeouts so one hung
 * dependency cannot make the health check itself the outage.
 *
 * The response deliberately carries no version string, hostname, or
 * configuration detail — an unauthenticated endpoint should not be a
 * reconnaissance surface (penetration-testing.md).
 */

/**
 * Per-dependency timeouts.
 *
 * A single budget for everything made this endpoint flap: the database answers
 * in tens of milliseconds over a private network, while an S3 HeadBucket is a
 * TLS handshake plus a signed round trip to another continent and legitimately
 * takes seconds on a cold connection. A check that alternates between ok and
 * timeout is worse than no check, because people learn to ignore it.
 */
const CHECK_TIMEOUT_MS: Record<string, number> = {
  database: 4000,
  queue: 4000,
  secrets: 6000,
  storage: 10_000,
  anthropic: 10_000,
};
const DEFAULT_TIMEOUT_MS = 5000;

type CheckResult = { ok: boolean; latencyMs: number; note?: string };

async function withTimeout(
  name: string,
  fn: () => Promise<CheckResult>,
): Promise<[string, CheckResult]> {
  const started = Date.now();
  const budget = CHECK_TIMEOUT_MS[name] ?? DEFAULT_TIMEOUT_MS;
  try {
    const result = await Promise.race([
      fn(),
      new Promise<CheckResult>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), budget),
      ),
    ]);
    return [name, result];
  } catch (error) {
    return [
      name,
      {
        ok: false,
        latencyMs: Date.now() - started,
        note: (error as Error).message === 'timeout' ? 'timeout' : 'unreachable',
      },
    ];
  }
}

/**
 * Claude reachability without spending tokens: an unauthenticated TCP+TLS
 * reach to the API host. A models call would cost money on every uptime poll.
 */
async function anthropicCheck(): Promise<CheckResult> {
  const started = Date.now();
  const key = await optionalSecret('ANTHROPIC_API_KEY');
  if (!key) {
    return { ok: false, latencyMs: 0, note: 'not configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    CHECK_TIMEOUT_MS.anthropic ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: controller.signal,
      cache: 'no-store',
    });
    return {
      ok: res.ok,
      latencyMs: Date.now() - started,
      note: res.ok ? undefined : `http ${res.status}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(): Promise<NextResponse> {
  const started = Date.now();

  const results = await Promise.all([
    withTimeout('database', databaseHealthCheck),
    withTimeout('storage', storageHealthCheck),
    withTimeout('queue', queueHealthCheck),
    withTimeout('anthropic', anthropicCheck),
    withTimeout('secrets', async () => {
      const t = Date.now();
      const ok = await secretsHealthCheck();
      return { ok, latencyMs: Date.now() - t };
    }),
  ]);

  const checks = Object.fromEntries(results) as Record<string, CheckResult>;

  // The database is the only hard dependency for liveness. The others degrade
  // features rather than taking the platform down, so they report unhealthy
  // without failing the container's health probe into a restart loop.
  const healthy = checks.database?.ok === true;
  const degraded = Object.values(checks).some((c) => !c.ok);

  return NextResponse.json(
    {
      status: healthy ? (degraded ? 'degraded' : 'ok') : 'unhealthy',
      environment: config().APP_ENV,
      checks,
      elapsedMs: Date.now() - started,
    },
    {
      status: healthy ? 200 : 503,
      headers: { 'cache-control': 'no-store, max-age=0' },
    },
  );
}
