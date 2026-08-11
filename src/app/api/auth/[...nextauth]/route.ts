import { type NextRequest } from 'next/server';
import { authHandlers } from '@/lib/auth/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Auth.js route handler.
 *
 * Resolved lazily because provider secrets may be Infisical handles, which
 * cannot be read synchronously at module load.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const handlers = await authHandlers();
  return handlers.GET(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  const handlers = await authHandlers();
  return handlers.POST(request);
}
