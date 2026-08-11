import 'server-only';

/**
 * Infisical secret resolver — TypeScript port of the EIAAW house pattern
 * (`app/Services/Secrets/InfisicalResolver.php` in the Laravel projects).
 *
 * EIAAW deploy contract:
 *   The only raw secrets in the deployment env are the three Infisical bootstrap
 *   credentials. Every other secret is a `secret://<project>/<env>/<NAME>` handle,
 *   resolved here at boot and cached in memory.
 *
 * The resolver is deliberately fail-closed in production: an unresolvable handle
 * throws rather than silently leaving the literal `secret://…` string in config,
 * which would otherwise surface as a confusing downstream auth error.
 */

const HANDLE_PREFIX = 'secret://';

interface CacheEntry {
  value: string;
  expiresAt: number;
}

interface ResolverOptions {
  siteUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  defaultEnvironment: string;
  cacheTtlSeconds: number;
  requestTimeoutMs: number;
}

export interface ParsedHandle {
  /** Infisical workspace/project slug segment, e.g. `chambersofkoon-prod`. */
  project: string;
  /** Environment slug, e.g. `prod`. */
  environment: string;
  /** Secret folder path, e.g. `/` or `/stripe`. */
  path: string;
  /** Secret name, e.g. `ANTHROPIC_API_KEY`. */
  name: string;
}

export function isSecretHandle(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.startsWith(HANDLE_PREFIX);
}

/**
 * Parse `secret://project/env/some/path/NAME` into its parts.
 * The last segment is always the secret name; anything between the environment
 * and the name is the folder path.
 */
export function parseHandle(handle: string): ParsedHandle {
  if (!isSecretHandle(handle)) {
    throw new Error(`Not a secret handle: ${handle}`);
  }
  const segments = handle.slice(HANDLE_PREFIX.length).split('/').filter(Boolean);
  if (segments.length < 3) {
    throw new Error(
      `Malformed secret handle "${handle}". Expected secret://<project>/<env>/[path/]<NAME>.`,
    );
  }
  const project = segments[0]!;
  const environment = segments[1]!;
  const name = segments[segments.length - 1]!;
  const folders = segments.slice(2, -1);
  const path = folders.length > 0 ? `/${folders.join('/')}` : '/';
  return { project, environment, path, name };
}

class InfisicalResolver {
  private readonly options: ResolverOptions;
  private readonly cache = new Map<string, CacheEntry>();
  private token: { value: string; expiresAt: number } | null = null;
  private inflightLogin: Promise<string> | null = null;

  constructor(options: ResolverOptions) {
    this.options = options;
  }

  private now(): number {
    return Date.now();
  }

  /** Universal-auth login. Concurrent callers share one in-flight request. */
  private async login(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 30_000) {
      return this.token.value;
    }
    if (this.inflightLogin) return this.inflightLogin;

    this.inflightLogin = (async () => {
      const res = await this.fetchWithTimeout(
        `${this.options.siteUrl}/api/v1/auth/universal-auth/login`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientId: this.options.clientId,
            clientSecret: this.options.clientSecret,
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`Infisical login failed with HTTP ${res.status}`);
      }
      const body = (await res.json()) as { accessToken: string; expiresIn: number };
      const ttlMs = (body.expiresIn ?? 3600) * 1000;
      this.token = { value: body.accessToken, expiresAt: this.now() + ttlMs };
      return body.accessToken;
    })();

    try {
      return await this.inflightLogin;
    } finally {
      this.inflightLogin = null;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
    } finally {
      clearTimeout(timer);
    }
  }

  async resolve(handle: string): Promise<string> {
    const cached = this.cache.get(handle);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const parsed = parseHandle(handle);
    const token = await this.login();

    const url = new URL(`${this.options.siteUrl}/api/v3/secrets/raw/${parsed.name}`);
    url.searchParams.set('workspaceId', this.options.projectId);
    url.searchParams.set('environment', parsed.environment || this.options.defaultEnvironment);
    url.searchParams.set('secretPath', parsed.path);

    const res = await this.fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      // Deliberately does not include the response body — Infisical error
      // payloads can echo secret metadata into logs.
      throw new Error(
        `Infisical could not resolve ${parsed.environment}${parsed.path}${parsed.name} (HTTP ${res.status})`,
      );
    }

    const body = (await res.json()) as { secret?: { secretValue?: string } };
    const value = body.secret?.secretValue;
    if (typeof value !== 'string') {
      throw new Error(`Infisical returned no value for ${parsed.name}`);
    }

    this.cache.set(handle, {
      value,
      expiresAt: this.now() + this.options.cacheTtlSeconds * 1000,
    });
    return value;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.login();
      return true;
    } catch {
      return false;
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.token = null;
  }
}

let singleton: InfisicalResolver | null = null;

function resolverEnabled(): boolean {
  return process.env.INFISICAL_RESOLVER_ENABLED === 'true';
}

function getResolver(): InfisicalResolver {
  if (singleton) return singleton;
  const clientId = process.env.INFISICAL_APP_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_APP_CLIENT_SECRET;
  const projectId = process.env.INFISICAL_PROJECT_ID;

  if (!clientId || !clientSecret || !projectId) {
    throw new Error(
      'INFISICAL_RESOLVER_ENABLED=true but bootstrap credentials are missing. ' +
        'Set INFISICAL_APP_CLIENT_ID, INFISICAL_APP_CLIENT_SECRET and INFISICAL_PROJECT_ID.',
    );
  }

  singleton = new InfisicalResolver({
    siteUrl: (process.env.INFISICAL_SITE_URL ?? 'https://app.infisical.com').replace(/\/$/, ''),
    clientId,
    clientSecret,
    projectId,
    defaultEnvironment: process.env.INFISICAL_ENVIRONMENT ?? 'prod',
    cacheTtlSeconds: Number(process.env.INFISICAL_CACHE_TTL ?? 300),
    requestTimeoutMs: Number(process.env.INFISICAL_REQUEST_TIMEOUT ?? 5000),
  });
  return singleton;
}

/**
 * Resolve a single value that may or may not be a handle.
 *
 * - Plain value  → returned unchanged.
 * - Handle + resolver enabled → fetched from Infisical.
 * - Handle + resolver disabled → throws in production, returns '' in dev so a
 *   developer can run the app without a vault for the parts they aren't touching.
 */
export async function resolveSecret(raw: string | undefined): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  if (!isSecretHandle(raw)) return raw;

  if (!resolverEnabled()) {
    if (process.env.APP_ENV === 'production') {
      throw new Error(
        `Secret handle "${raw}" cannot be resolved: INFISICAL_RESOLVER_ENABLED is not true in production.`,
      );
    }
    return '';
  }
  return getResolver().resolve(raw);
}

/** Resolve every handle in a record, in parallel. */
export async function resolveAll<T extends Record<string, string | undefined>>(
  input: T,
): Promise<{ [K in keyof T]: string | undefined }> {
  const entries = Object.entries(input);
  const resolved = await Promise.all(
    entries.map(async ([key, value]) => [key, await resolveSecret(value)] as const),
  );
  return Object.fromEntries(resolved) as { [K in keyof T]: string | undefined };
}

export async function secretsHealthCheck(): Promise<boolean> {
  if (!resolverEnabled()) return true;
  return getResolver().healthCheck();
}

export function __resetResolverForTests(): void {
  singleton?.clearCache();
  singleton = null;
}
