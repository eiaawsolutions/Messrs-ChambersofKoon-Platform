import Link from 'next/link';
import { requireActor } from '@/lib/auth/session';
import { can } from '@/lib/auth/guard';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { AuthorizationError } from '@/lib/auth/guard';

export const dynamic = 'force-dynamic';

/**
 * Admin console shell (M9).
 *
 * Each tab is gated by its own permission, so the practice manager's delegated
 * access (onboarding and availability) shows only those two. Every page
 * re-asserts server-side — the nav is presentation.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();

  const tabs = [
    {
      href: '/admin/users',
      label: 'Users',
      show:
        can(actor, PERMISSIONS.ADMIN_USERS_MANAGE) || can(actor, PERMISSIONS.ADMIN_USERS_ONBOARD),
    },
    { href: '/admin/roles', label: 'Roles', show: can(actor, PERMISSIONS.ADMIN_ROLES_MANAGE) },
    {
      href: '/admin/availability',
      label: 'Availability',
      show: can(actor, PERMISSIONS.ADMIN_AVAILABILITY_MANAGE),
    },
    {
      href: '/admin/templates',
      label: 'Message templates',
      show: can(actor, PERMISSIONS.ADMIN_MESSAGING_MANAGE),
    },
    {
      href: '/admin/features',
      label: 'Feature access',
      show: can(actor, PERMISSIONS.ADMIN_FEATURES_MANAGE),
    },
  ].filter((tab) => tab.show);

  if (tabs.length === 0) {
    throw new AuthorizationError(PERMISSIONS.ADMIN_USERS_MANAGE);
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="rule-brass text-3xl">Administration</h1>
      </header>

      <nav aria-label="Administration" className="scroll-x border-line border-b">
        <ul className="flex gap-1">
          {tabs.map((tab) => (
            <li key={tab.href}>
              <Link
                href={tab.href}
                className="text-ink-muted hover:text-ink hover:border-brass-500 -mb-px block border-b-2 border-transparent px-4 py-2.5 text-sm whitespace-nowrap transition-colors"
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {children}
    </div>
  );
}
