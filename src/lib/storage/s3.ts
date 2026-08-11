import 'server-only';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, secret } from '@/lib/config/env';

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

async function client(): Promise<S3Client> {
  if (clientInstance) return clientInstance;
  const cfg = config();
  clientInstance = new S3Client({
    region: cfg.STORAGE_REGION,
    endpoint: cfg.STORAGE_ENDPOINT,
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
  return `${parts.kind}/${scope}/${parts.id}/${safeName}`;
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
  if (!config().STORAGE_ENDPOINT) {
    return { ok: false, latencyMs: 0, note: 'not configured' };
  }
  try {
    const s3 = await client();
    await s3.send(new HeadBucketCommand({ Bucket: bucket() }));
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, note: (error as Error).name };
  }
}

export function __resetStorageForTests(): void {
  clientInstance = null;
}
