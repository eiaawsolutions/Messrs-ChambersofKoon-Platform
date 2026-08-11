import Link from 'next/link';
import { requireActor } from '@/lib/auth/session';
import { signOut } from '@/lib/auth/auth';
import { can } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { config } from '@/lib/config/env';

export const dynamic = 'force-dynamic';

/**
 * Authenticated shell.
 *
 * Navigation is filtered by capability, but that is presentation only — every
 * page re-checks server-side. Hiding a link is not access control; it just
 * stops people finding doors they cannot open.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const cfg = config();

  const nav = [
    { href: '/dashboard', label: 'Today', show: true },
    { href: '/intake', label: 'Intake', show: can(actor, PERMISSIONS.INTAKE_VIEW) },
    { href: '/matters', label: 'Matters', show: can(actor, PERMISSIONS.MATTER_VIEW) },
    { href: '/precedent', label: 'Precedent', show: can(actor, PERMISSIONS.RAG_SEARCH) },
    { href: '/archive', label: 'Archive', show: can(actor, PERMISSIONS.ARCHIVE_UPLOAD) },
    { href: '/admin', label: 'Admin', show: can(actor, PERMISSIONS.ADMIN_USERS_MANAGE) },
    { href: '/audit', label: 'Audit', show: can(actor, PERMISSIONS.AUDIT_VIEW) },
  ].filter((item) => item.show);

  return (
    <div className="min-h-screen">
      <header className="border-line bg-paper-raised sticky top-0 z-40 border-b">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-5 py-3">
          <Link href="/dashboard" className="flex-none">
            <span className="text-brass-500 block font-mono text-[10px] tracking-[0.18em] uppercase">
              Matter Velocity
            </span>
            <span className="font-display text-ink block text-sm leading-tight">
              {cfg.FIRM_SHORT_NAME}
            </span>
          </Link>

          <nav aria-label="Main" className="scroll-x flex-1">
            <ul className="flex items-center gap-1">
              {nav.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-ink-muted hover:bg-paper-sunken hover:text-ink rounded-sm px-3 py-1.5 text-sm whitespace-nowrap transition-colors"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex flex-none items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-ink text-sm leading-tight">{actor.fullName}</p>
              <p className="text-ink-faint text-xs leading-tight">
                {actor.roleName} · {actor.office}
              </p>
            </div>
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/sign-in' });
              }}
            >
              <button className="btn btn-ghost" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-7xl px-5 py-8">
        {children}
      </main>
    </div>
  );
}
