import type { Metadata } from 'next';
import Link from 'next/link';
import { config } from '@/lib/config/env';
import { resolveLocale, t } from '@/lib/i18n/catalogue';

export const metadata: Metadata = { title: 'Enquiry received' };

export default async function EnquiryReceivedPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; lang?: string }>;
}) {
  const { status, lang } = await searchParams;
  const failed = status === 'error';
  const cfg = config();
  const locale = resolveLocale(lang);

  return (
    <main id="main" className="grain relative flex min-h-screen items-center justify-center px-5">
      <div className="surface-raised w-full max-w-md p-8">
        <p className="text-ink-muted mb-2 font-mono text-xs tracking-widest uppercase">
          {cfg.FIRM_NAME}
        </p>

        {failed ? (
          <>
            <h1 className="rule-brass text-2xl">{t('received.failed.title', locale)}</h1>
            <p className="text-ink-muted mt-6 text-sm">{t('received.failed.body', locale)}</p>
            <Link href="/enquiry" className="btn btn-secondary mt-6">
              {t('received.failed.back', locale)}
            </Link>
          </>
        ) : (
          <>
            <h1 className="rule-brass text-2xl">{t('received.title', locale)}</h1>
            <p className="text-ink-muted mt-6 text-sm">{t('received.body', locale)}</p>
            <p className="text-ink-faint mt-4 text-xs">{t('received.emergency', locale)}</p>
          </>
        )}
      </div>
    </main>
  );
}
