import { redirect } from 'next/navigation';
import { getActor } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * The root is not a landing page — this is a private practice system. Signed-in
 * users go to their dashboard, everyone else to sign-in.
 */
export default async function RootPage() {
  const actor = await getActor();
  redirect(actor ? '/dashboard' : '/sign-in');
}
