import type { Metadata } from 'next';
import Link from 'next/link';
import { config } from '@/lib/config/env';

export const metadata: Metadata = { title: 'Enquiry received' };

export default async function EnquiryReceivedPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const failed = status === 'error';
  const cfg = config();

  return (
    <main id="main" className="grain relative flex min-h-screen items-center justify-center px-5">
      <div className="surface-raised w-full max-w-md p-8">
        <p className="text-ink-muted mb-2 font-mono text-xs tracking-widest uppercase">
          {cfg.FIRM_NAME}
        </p>

        {failed ? (
          <>
            <h1 className="rule-brass text-2xl">We could not send that</h1>
            <p className="text-ink-muted mt-6 text-sm">
              Something went wrong, or too many enquiries have come from this connection recently.
              Please try again shortly. If the matter is urgent, telephone the office directly.
            </p>
            <Link href="/enquiry" className="btn btn-secondary mt-6">
              Back to the form
            </Link>
          </>
        ) : (
          <>
            <h1 className="rule-brass text-2xl">Thank you — we have it</h1>
            <p className="text-ink-muted mt-6 text-sm">
              Your enquiry has reached the firm. A member of the team will review it and respond.
              You will hear from us by email.
            </p>
            <p className="text-ink-faint mt-4 text-xs">
              If someone is in immediate danger, call the police on 999.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
