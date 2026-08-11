import 'server-only';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, optionalSecret, secret } from '@/lib/config/env';

/**
 * S3-compatible object storage (Cloudflare R2).
 *
 * NFR-1.3: "All object storage access via short-lived presigned URLs. No
 * public buckets." Nothing in the application ever returns a bucket URL
 * directly; every download goes through a route that authorises first and then
 * mints a URL valid for minutes.
 */

const PRESIGN_TTL_SECONDS = 300; // 5 minutes

let clientInstance: S3Client | null = null;

/**
 * The S3 endpoint. Explicit `STORAGE_ENDPOINT` wins; otherwise it is derived
 * from the R2 account id, which is what the shared EIAAW vault holds.
 */
export async function resolveEndpoint(): Promise<string | undefined> {
  const explicit = config().STORAGE_ENDPOINT;

  // STORAGE_ENDPOINT is read from the non-secret schema, so it is never passed
  // through the resolver. If someone configures it as a `secret://` handle the
  // literal string would otherwise be handed to the S3 client as an endpoint
  // URL, which fails deep inside the SDK with an opaque EndpointError. Treat a
  // handle here as "not configured" and derive instead.
  if (explicit && explicit.startsWith('secret://')) {
    console.warn(
      '[storage] STORAGE_ENDPOINT is a secret:// handle but is read as plain configuration. ' +
        'Ignoring it and deriving the endpoint from STORAGE_ACCOUNT_ID. ' +
        'Set STORAGE_ENDPOINT to a literal URL, or unset it.',
    );
  } else if (explicit) {
    return explicit;
  }

  const accountId = await optionalSecret('STORAGE_ACCOUNT_ID');
  return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined;
}

async function client(): Promise<S3Client> {
  if (clientInstance) return clientInstance;
  const cfg = config();
  const endpoint = await resolveEndpoint();
  if (!endpoint) {
    throw new Error(
      'Object storage is not configured: set STORAGE_ENDPOINT, or STORAGE_ACCOUNT_ID for R2.',
    );
  }
  clientInstance = new S3Client({
    region: cfg.STORAGE_REGION,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: await secret('STORAGE_ACCESS_KEY_ID'),
      secretAccessKey: await secret('STORAGE_SECRET_ACCESS_KEY'),
    },
  });
  return clientInstance;
}

function bucket(): string {
  return config().STORAGE_BUCKET;
}

/**
 * Deterministic, non-guessable key layout.
 * Keys are never derived from user-supplied filenames alone — a client could
 * otherwise choose a key that collides with, or traverses into, another
 * matter's prefix.
 */
export function storageKey(parts: {
  kind: 'archive' | 'document' | 'template';
  matterId?: string | null;
  id: string;
  filename: string;
}): string {
  const safeName = parts.filename
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-120);
  const scope = parts.matterId ?? 'unassigned';
  const prefix = config().STORAGE_PREFIX;
  const base = `${parts.kind}/${scope}/${parts.id}/${safeName}`;
  return prefix ? `${prefix}/${base}` : base;
}

export async function putObject(params: {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}): Promise<void> {
  const s3 = await client();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      // Belt and braces: the bucket is private, and objects say so too.
      ACL: undefined,
    }),
  );
}

export async function getObject(key: string): Promise<Buffer> {
  const s3 = await client();
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!response.Body) throw new Error(`Object not found: ${key}`);
  const chunks: Uint8Array[] = [];
  // @ts-expect-error — Body is a Node.js Readable in the Node runtime.
  for await (const chunk of response.Body) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks);
}

export async function deleteObject(key: string): Promise<void> {
  const s3 = await client();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/**
 * Short-lived download URL. `downloadFilename` sets Content-Disposition so the
 * browser saves "Divorce Petition v3.docx" rather than the opaque storage key.
 */
export async function presignedDownloadUrl(params: {
  key: string;
  downloadFilename?: string;
  ttlSeconds?: number;
}): Promise<string> {
  const s3 = await client();
  const command = new GetObjectCommand({
    Bucket: bucket(),
    Key: params.key,
    ...(params.downloadFilename
      ? {
          ResponseContentDisposition: `attachment; filename="${params.downloadFilename.replace(
            /"/g,
            '',
          )}"`,
        }
      : {}),
  });
  return getSignedUrl(s3, command, { expiresIn: params.ttlSeconds ?? PRESIGN_TTL_SECONDS });
}

export async function presignedUploadUrl(params: {
  key: string;
  contentType: string;
  ttlSeconds?: number;
}): Promise<string> {
  const s3 = await client();
  const command = new PutObjectCommand({
    Bucket: bucket(),
    Key: params.key,
    ContentType: params.contentType,
  });
  return getSignedUrl(s3, command, { expiresIn: params.ttlSeconds ?? PRESIGN_TTL_SECONDS });
}

export async function storageHealthCheck(): Promise<{
  ok: boolean;
  latencyMs: number;
  note?: string;
}> {
  const started = Date.now();
  if (!(await resolveEndpoint())) {
    return { ok: false, latencyMs: 0, note: 'not configured' };
  }
  try {
    const s3 = await client();
    await s3.send(new HeadBucketCommand({ Bucket: bucket() }));
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    const message = (error as Error).message;
    const name = (error as Error).name;

    // These three failures need completely different responses, and an
    // operator reading a bare "Error" cannot tell them apart.
    let note: string;
    if (/Missing secret|cannot be resolved|not configured/i.test(message)) {
      note = 'credentials unresolved (Infisical resolver off?)';
    } else if (
      /AccessDenied|Forbidden|Unknown|NoSuchBucket|EndpointError/i.test(name) ||
      /Access Denied/i.test(message)
    ) {
      note = `bucket "${bucket()}" not reachable with these credentials — create it and scope the R2 token to it`;
    } else {
      note = name;
    }
    return { ok: false, latencyMs: Date.now() - started, note };
  }
}

export function __resetStorageForTests(): void {
  clientInstance = null;
}
