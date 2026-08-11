import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';

/**
 * Session revocation.
 *
 * Deliberately in its own module, importing nothing but the database. It used
 * to live in session.ts, which imports Auth.js — so every module that merely
 * wanted to revoke a session (the admin service, the credential service) pulled
 * the entire auth stack in with it, and could not be exercised outside a Next
 * runtime.
 *
 * Sessions are JWTs and cannot be deleted server-side. `session_epoch` is what
 * makes them revocable: `getActor()` compares the token's epoch against the
 * database on every request, so bumping it here ends every live session for
 * that user on their next request rather than at their next sign-in (AT-07).
 */
export async function revokeSessions(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, userId));
}
