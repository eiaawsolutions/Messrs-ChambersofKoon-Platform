import { describe, expect, it } from 'vitest';
import {
  CLIENT_RESCHEDULE_NOTICE_MINUTES,
  evaluateRescheduleLink,
  matchOfferedSlot,
} from './reschedule-link';
import type { Slot } from './slots';

const NOW = new Date('2026-08-13T02:00:00.000Z'); // 10:00 MYT

function appointment(
  overrides: Partial<{ state: 'confirmed' | 'cancelled' | 'rescheduled'; startsAt: Date }> = {},
) {
  return {
    state: 'confirmed' as const,
    startsAt: new Date('2026-08-20T02:00:00.000Z'),
    ...overrides,
  };
}

describe('evaluateRescheduleLink (FR-3.8)', () => {
  it('opens for a confirmed future appointment with nothing pending', () => {
    expect(
      evaluateRescheduleLink({ appointment: appointment(), hasPendingProposal: false, now: NOW }),
    ).toEqual({ openable: true });
  });

  it('reports an unrecognised token as unknown rather than describing it', () => {
    expect(
      evaluateRescheduleLink({ appointment: null, hasPendingProposal: false, now: NOW }),
    ).toEqual({ openable: false, code: 'unknown' });
  });

  it('tells a genuine token holder their consultation was cancelled', () => {
    expect(
      evaluateRescheduleLink({
        appointment: appointment({ state: 'cancelled' }),
        hasPendingProposal: false,
        now: NOW,
      }),
    ).toEqual({ openable: false, code: 'cancelled' });
  });

  it('closes the link once the appointment is inside the notice window', () => {
    const startsAt = new Date(NOW.getTime() + (CLIENT_RESCHEDULE_NOTICE_MINUTES - 1) * 60_000);
    expect(
      evaluateRescheduleLink({
        appointment: appointment({ startsAt }),
        hasPendingProposal: false,
        now: NOW,
      }),
    ).toEqual({ openable: false, code: 'passed' });
  });

  it('closes the link for an appointment that has already happened', () => {
    const startsAt = new Date(NOW.getTime() - 86_400_000);
    expect(
      evaluateRescheduleLink({
        appointment: appointment({ startsAt }),
        hasPendingProposal: false,
        now: NOW,
      }),
    ).toEqual({ openable: false, code: 'passed' });
  });

  it('stays open just outside the notice window', () => {
    const startsAt = new Date(NOW.getTime() + (CLIENT_RESCHEDULE_NOTICE_MINUTES + 1) * 60_000);
    expect(
      evaluateRescheduleLink({
        appointment: appointment({ startsAt }),
        hasPendingProposal: false,
        now: NOW,
      }),
    ).toEqual({ openable: true });
  });

  it('refuses a second request while the first is undecided', () => {
    // Otherwise one client can hold every free slot in the lawyer's week,
    // because a pending proposal counts as busy when the next slot is found.
    expect(
      evaluateRescheduleLink({ appointment: appointment(), hasPendingProposal: true, now: NOW }),
    ).toEqual({ openable: false, code: 'pending_request' });
  });

  it('reports cancellation ahead of a pending request', () => {
    expect(
      evaluateRescheduleLink({
        appointment: appointment({ state: 'cancelled' }),
        hasPendingProposal: true,
        now: NOW,
      }),
    ).toEqual({ openable: false, code: 'cancelled' });
  });
});

describe('matchOfferedSlot (FR-3.8)', () => {
  const offered: Slot[] = [
    {
      userId: 'lawyer-1',
      startsAt: new Date('2026-08-21T01:00:00.000Z'),
      endsAt: new Date('2026-08-21T01:45:00.000Z'),
    },
    {
      userId: 'lawyer-1',
      startsAt: new Date('2026-08-21T02:00:00.000Z'),
      endsAt: new Date('2026-08-21T02:45:00.000Z'),
    },
  ];

  it('returns the offered slot for an exact start instant', () => {
    expect(matchOfferedSlot(offered, '2026-08-21T02:00:00.000Z')).toBe(offered[1]);
  });

  it('accepts an equivalent instant written in another offset', () => {
    expect(matchOfferedSlot(offered, '2026-08-21T10:00:00+08:00')).toBe(offered[1]);
  });

  it('refuses a time that was never offered', () => {
    // The whole point: a hand-edited form cannot book a lawyer at 3am.
    expect(matchOfferedSlot(offered, '2026-08-21T19:00:00.000Z')).toBeNull();
  });

  it('refuses a slot that has just stopped being offered', () => {
    expect(matchOfferedSlot([offered[0]!], '2026-08-21T02:00:00.000Z')).toBeNull();
  });

  it('refuses an unparseable value rather than throwing', () => {
    expect(matchOfferedSlot(offered, 'tomorrow please')).toBeNull();
    expect(matchOfferedSlot(offered, '')).toBeNull();
  });

  it('refuses when nothing is on offer', () => {
    expect(matchOfferedSlot([], '2026-08-21T02:00:00.000Z')).toBeNull();
  });
});
