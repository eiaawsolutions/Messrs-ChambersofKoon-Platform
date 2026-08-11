import { describe, expect, it } from 'vitest';
import { isResumable, SESSION_IDLE_WINDOW_MINUTES } from './session';

/**
 * The bug this guards against: two unrelated enquiries arriving on one
 * conversation because the browser held the same session token forever.
 */

const now = new Date('2026-08-12T10:00:00Z');
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);

describe('isResumable', () => {
  it('resumes a conversation still in progress', () => {
    expect(isResumable({ status: 'new', lastActivityAt: minutesAgo(3) }, now)).toBe(true);
  });

  it('resumes across an accidental reload well inside the window', () => {
    expect(
      isResumable(
        { status: 'new', lastActivityAt: minutesAgo(SESSION_IDLE_WINDOW_MINUTES - 1) },
        now,
      ),
    ).toBe(true);
  });

  it('refuses a token that has gone idle past the window', () => {
    expect(
      isResumable(
        { status: 'new', lastActivityAt: minutesAgo(SESSION_IDLE_WINDOW_MINUTES + 1) },
        now,
      ),
    ).toBe(false);
  });

  it('refuses a token from days ago — the merged-enquiry case', () => {
    expect(isResumable({ status: 'new', lastActivityAt: minutesAgo(60 * 24 * 3) }, now)).toBe(
      false,
    );
  });

  it.each(['triaged', 'needs_review', 'slot_proposed', 'booked', 'declined', 'spam'] as const)(
    'refuses to append to an enquiry already handed over (%s)',
    (status) => {
      // Recent enough to pass the idle window; the status is what stops it.
      expect(isResumable({ status, lastActivityAt: minutesAgo(1) }, now)).toBe(false);
    },
  );

  it('treats clock skew as active rather than expiring a live conversation', () => {
    expect(isResumable({ status: 'new', lastActivityAt: minutesAgo(-5) }, now)).toBe(true);
  });

  it('refuses an unusable timestamp instead of guessing', () => {
    expect(isResumable({ status: 'new', lastActivityAt: new Date(Number.NaN) }, now)).toBe(false);
  });
});
