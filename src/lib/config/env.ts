import 'server-only';
import { z } from 'zod';
import { resolveSecret } from '@/lib/secrets/resolver';

/**
 * Typed, validated server configuration.
 *
 * Values that may arrive as `secret://…` handles are resolved lazily through
 * `config()` rather than at module load, because Next.js evaluates modules at
 * build time where the vault is intentionally unreachable.
 *
 * Nothing here is exposed to the client. Client-visible values must be
 * NEXT_PUBLIC_* and read directly in the component.
 */

const appEnvSchema = z.enum(['development', 'uat', 'production']);

const nonSecretSchema = z.object({
  APP_ENV: appEnvSchema.default('development'),
  APP_BASE_URL: z.string().url(),
  FIRM_NAME: z.string().default('Messrs Chambers of Koon'),
  FIRM_SHORT_NAME: z.string().default('Chambers of Koon'),
  FIRM_TIMEZONE: z.string().default('Asia/Kuala_Lumpur'),

  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().optional(),

  ANTHROPIC_MODEL_DRAFTING: z.string().default('claude-sonnet-5'),
  ANTHROPIC_MODEL_CLASSIFY: z.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_MODEL_VISION: z.string().default('claude-sonnet-5'),
  AI_MONTHLY_SPEND_CEILING_USD: z.coerce.number().positive().default(400),

  EMBEDDING_PROVIDER: z.enum(['voyage', 'openai']).default('voyage'),
  EMBEDDING_MODEL_VERSION: z.string().default('voyage-law-2'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),

  RESEND_FROM_ADDRESS: z.string().email().default('notifications@mail.eiaawsolutions.com'),
  RESEND_FROM_NAME: z.string().default('Messrs Chambers of Koon'),
  RESEND_REPLY_TO: z.string().email().optional(),

  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().default('auto'),
  STORAGE_BUCKET: z.string().default('chambersofkoon-matters'),

  ALLOWED_EMAIL_DOMAINS: z.string().default('chambersofkoon.com.my'),
  SESSION_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(43_200),

  WIDGET_PUBLIC_KEY: z.string().default('cok_public_dev_key'),
  WIDGET_ALLOWED_ORIGINS: z.string().default(''),
  TURNSTILE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  TURNSTILE_SITE_KEY: z.string().optional(),

  PROPOSAL_EXPIRY_WORKING_HOURS: z.coerce.number().int().positive().default(12),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type NonSecretConfig = z.infer<typeof nonSecretSchema>;

/** Names of every env var whose value may be a `secret://` handle. */
export const SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'EMBEDDING_API_KEY',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'AUTH_SECRET',
  'AUTH_GOOGLE_ID',
  'AUTH_GOOGLE_SECRET',
  'AUTH_MICROSOFT_ID',
  'AUTH_MICROSOFT_SECRET',
  'AUTH_MICROSOFT_TENANT_ID',
  'FIELD_ENCRYPTION_KEY',
  'TURNSTILE_SECRET_KEY',
  'SENTRY_DSN',
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

let nonSecretCache: NonSecretConfig | null = null;

/** Non-secret configuration. Safe to call during build. */
export function config(): NonSecretConfig {
  if (nonSecretCache) return nonSecretCache;
  const parsed = nonSecretSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  nonSecretCache = parsed.data;
  return nonSecretCache;
}

const secretCache = new Map<SecretKey, string>();

/** Resolve a secret, via Infisical when the value is a handle. Cached per process. */
export async function secret(key: SecretKey): Promise<string> {
  const cached = secretCache.get(key);
  if (cached !== undefined) return cached;

  const resolved = await resolveSecret(process.env[key]);
  if (!resolved) {
    throw new Error(
      `Missing secret ${key}. Set it in the environment, or as a secret:// handle ` +
        `with INFISICAL_RESOLVER_ENABLED=true.`,
    );
  }
  secretCache.set(key, resolved);
  return resolved;
}

/** Like `secret()` but returns undefined instead of throwing when unset. */
export async function optionalSecret(key: SecretKey): Promise<string | undefined> {
  try {
    return await secret(key);
  } catch {
    return undefined;
  }
}

export function allowedEmailDomains(): string[] {
  return config()
    .ALLOWED_EMAIL_DOMAINS.split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function widgetAllowedOrigins(): string[] {
  const configured = config()
    .WIDGET_ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  // The app's own origin always may call the widget endpoint (preview page).
  const self = config().APP_BASE_URL.replace(/\/$/, '');
  return Array.from(new Set([...configured, self]));
}

export function isProduction(): boolean {
  return config().APP_ENV === 'production';
}

/**
 * Domain used to qualify iCalendar UIDs. Exchange treats an invitation whose
 * UID domain the organiser does not control as spoofed, so this follows the
 * sending address rather than the app's own hostname.
 */
export function senderDomain(): string {
  const address = config().RESEND_FROM_ADDRESS;
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : 'chambersofkoon.com.my';
}

/**
 * Startup diagnostic: which secrets are still unset, and which are handles
 * awaiting the resolver. Surfaced on the admin health page so a misconfigured
 * deploy is visible before someone hits the feature that needs the key —
 * without ever printing a value.
 */
export function secretConfigurationReport(): Array<{
  key: SecretKey;
  state: 'unset' | 'handle' | 'literal';
}> {
  return SECRET_KEYS.map((key) => {
    const raw = process.env[key];
    if (!raw) return { key, state: 'unset' as const };
    if (raw.startsWith('secret://')) return { key, state: 'handle' as const };
    return { key, state: 'literal' as const };
  });
}

export function __resetConfigForTests(): void {
  nonSecretCache = null;
  secretCache.clear();
}
