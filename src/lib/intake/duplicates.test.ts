import { describe, expect, it } from 'vitest';
import {
  classifyEnquiry,
  dispositionNote,
  DUPLICATE_WINDOW_HOURS,
  SPAM_THRESHOLD,
  type RecentEnquiry,
} from './duplicates';

const NOW = new Date('2026-08-13T14:00:00.000Z');
const EMAIL = 'nurul.aisyah@example.com';

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

function prior(count: number): RecentEnquiry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `enquiry-${i}`,
    createdAt: hoursAgo(i + 1),
    summary: 'divorce, two children',
  }));
}

describe('classifyEnquiry (FR-2.8)', () => {
  it('passes a first enquiry through untouched', () => {
    expect(classifyEnquiry({ contactEmail: EMAIL, recent: [], now: NOW })).toEqual({
      disposition: 'distinct',
      duplicateOfEnquiryId: null,
      reason: 'none',
    });
  });

  it('flags a second enquiry from the same address inside the window', () => {
    const verdict = classifyEnquiry({
      contactEmail: EMAIL,
      recent: [{ id: 'earlier', createdAt: hoursAgo(3), summary: 'divorce' }],
      now: NOW,
    });

    expect(verdict.disposition).toBe('duplicate');
    expect(verdict.duplicateOfEnquiryId).toBe('earlier');
    expect(verdict.reason).toBe('same_email_within_window');
  });

  it('links to the most recent earlier enquiry, not the oldest', () => {
    const verdict = classifyEnquiry({
      contactEmail: EMAIL,
      recent: [
        { id: 'oldest', createdAt: hoursAgo(20), summary: 'divorce' },
        { id: 'newest', createdAt: hoursAgo(2), summary: 'divorce' },
      ],
      now: NOW,
    });

    expect(verdict.duplicateOfEnquiryId).toBe('newest');
  });

  it('ignores an enquiry older than the window', () => {
    const verdict = classifyEnquiry({
      contactEmail: EMAIL,
      recent: [{ id: 'last-week', createdAt: hoursAgo(DUPLICATE_WINDOW_HOURS + 1), summary: '' }],
      now: NOW,
    });

    expect(verdict.disposition).toBe('distinct');
  });

  it('does not correlate an enquiry with no email address', () => {
    // An anonymous enquiry is not a repeat of anything; the per-IP limits
    // cover that case instead.
    for (const contactEmail of [null, '', '   ']) {
      expect(
        classifyEnquiry({
          contactEmail,
          recent: [{ id: 'earlier', createdAt: hoursAgo(1), summary: '' }],
          now: NOW,
        }).disposition,
      ).toBe('distinct');
    }
  });

  it('still only says duplicate at four prior enquiries', () => {
    // A distressed enquirer sending several messages as things occur to them
    // is ordinary and must reach a lawyer.
    const verdict = classifyEnquiry({ contactEmail: EMAIL, recent: prior(4), now: NOW });
    expect(verdict.disposition).toBe('duplicate');
  });

  it('calls it spam once the volume passes what a person produces', () => {
    const verdict = classifyEnquiry({
      contactEmail: EMAIL,
      recent: prior(SPAM_THRESHOLD),
      now: NOW,
    });

    expect(verdict.disposition).toBe('spam');
    expect(verdict.reason).toBe('volume_from_one_address');
    expect(verdict.duplicateOfEnquiryId).toBeNull();
  });

  it('counts only the enquiries inside the window towards spam', () => {
    const stale: RecentEnquiry[] = Array.from({ length: SPAM_THRESHOLD }, (_, i) => ({
      id: `old-${i}`,
      createdAt: hoursAgo(DUPLICATE_WINDOW_HOURS + i + 1),
      summary: '',
    }));

    const verdict = classifyEnquiry({
      contactEmail: EMAIL,
      recent: [...stale, { id: 'recent', createdAt: hoursAgo(1), summary: '' }],
      now: NOW,
    });

    expect(verdict.disposition).toBe('duplicate');
  });

  it('honours an overridden window', () => {
    const verdict = classifyEnquiry({
      contactEmail: EMAIL,
      recent: [{ id: 'earlier', createdAt: hoursAgo(3), summary: '' }],
      now: NOW,
      windowHours: 2,
    });

    expect(verdict.disposition).toBe('distinct');
  });
});

describe('dispositionNote', () => {
  it('says nothing for an ordinary enquiry', () => {
    expect(
      dispositionNote({ disposition: 'distinct', duplicateOfEnquiryId: null, reason: 'none' }),
    ).toBeNull();
  });

  it('tells a clerk to read both, not to discard one', () => {
    const note = dispositionNote({
      disposition: 'duplicate',
      duplicateOfEnquiryId: 'earlier',
      reason: 'same_email_within_window',
    });
    expect(note).toContain('Read them together');
  });

  it('makes clear that held is not deleted', () => {
    const note = dispositionNote({
      disposition: 'spam',
      duplicateOfEnquiryId: null,
      reason: 'volume_from_one_address',
    });
    expect(note).toContain('rather than deleted');
  });
});
