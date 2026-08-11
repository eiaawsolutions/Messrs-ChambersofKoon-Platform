import { describe, expect, it } from 'vitest';
import { appointmentUid, buildIcs, escapeIcsText, foldLine, formatIcsDate } from './ics';

/**
 * FR-3.6, FR-3.7, AT-03, AT-04.
 *
 * These assert wire format, because that is what the acceptance criteria are
 * about. "It looked fine in Gmail" is not a test.
 */

const BASE = {
  uid: 'appt-123@app.chambersofkoon.com.my',
  summary: 'Consultation — Family & Matrimonial',
  startsAt: new Date('2026-09-14T02:00:00.000Z'), // 10:00 MYT
  endsAt: new Date('2026-09-14T02:45:00.000Z'),
  organiser: { email: 'notifications@mail.eiaawsolutions.com', name: 'Messrs Chambers of Koon' },
  attendees: [
    { email: 'client@example.com', name: 'Siti Aminah' },
    { email: 'lawyer@chambersofkoon.com.my', name: 'Tan Yong Koon' },
  ],
  now: new Date('2026-09-10T09:30:00.000Z'),
};

/**
 * Unfold before asserting on properties, exactly as a real iCalendar parser
 * does (RFC 5545 §3.1): a CRLF followed by a single space or tab is a
 * continuation, not a line break. ATTENDEE and ORGANIZER lines routinely
 * exceed 75 octets and are folded, so asserting on the raw split would test
 * the folding rather than the content.
 */
function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, '');
}

function lines(ics: string): string[] {
  return unfold(ics).split('\r\n');
}

describe('formatIcsDate', () => {
  it('emits UTC basic format with a Z suffix', () => {
    expect(formatIcsDate(new Date('2026-09-14T02:00:00Z'))).toBe('20260914T020000Z');
  });

  it('zero-pads every component', () => {
    expect(formatIcsDate(new Date('2026-01-02T03:04:05Z'))).toBe('20260102T030405Z');
  });
});

describe('escapeIcsText', () => {
  it('escapes backslash before the characters it would then introduce', () => {
    expect(escapeIcsText('a\\b')).toBe('a\\\\b');
  });

  it('escapes semicolons and commas', () => {
    expect(escapeIcsText('Koon; Tan, Partner')).toBe('Koon\\; Tan\\, Partner');
  });

  it('converts newlines to the literal \\n sequence', () => {
    expect(escapeIcsText('line1\nline2')).toBe('line1\\nline2');
    expect(escapeIcsText('line1\r\nline2')).toBe('line1\\nline2');
  });
});

describe('foldLine', () => {
  it('leaves short lines untouched', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('folds long lines with a leading space on continuations', () => {
    const folded = foldLine(`DESCRIPTION:${'x'.repeat(200)}`);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(1)) {
      expect(part.startsWith(' ')).toBe(true);
    }
  });

  it('counts octets, not characters, so multi-byte names do not overflow', () => {
    // 40 three-byte characters = 120 octets, but only 40 JS characters.
    const line = `SUMMARY:${'中'.repeat(40)}`;
    const folded = foldLine(line);
    const encoder = new TextEncoder();
    for (const part of folded.split('\r\n')) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
    }
  });
});

describe('buildIcs — REQUEST (FR-3.6, AT-03)', () => {
  const ics = buildIcs({ ...BASE, sequence: 0, method: 'REQUEST' });

  it('uses CRLF line endings throughout', () => {
    expect(ics.includes('\r\n')).toBe(true);
    // No bare LF that is not part of a CRLF pair.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it('declares METHOD:REQUEST so mail clients render accept/decline', () => {
    expect(lines(ics)).toContain('METHOD:REQUEST');
  });

  it('carries the stable UID and SEQUENCE 0', () => {
    expect(lines(ics)).toContain('UID:appt-123@app.chambersofkoon.com.my');
    expect(lines(ics)).toContain('SEQUENCE:0');
  });

  it('sets STATUS:CONFIRMED and opaque busy time', () => {
    expect(lines(ics)).toContain('STATUS:CONFIRMED');
    expect(lines(ics)).toContain('TRANSP:OPAQUE');
  });

  it('asks both attendees to RSVP', () => {
    const attendeeLines = lines(ics).filter((l) => l.startsWith('ATTENDEE'));
    expect(attendeeLines).toHaveLength(2);
    for (const line of attendeeLines) {
      expect(line).toContain('RSVP=TRUE');
      expect(line).toContain('PARTSTAT=NEEDS-ACTION');
    }
  });

  it('names an organiser, which Exchange requires to accept the invitation', () => {
    const organiser = lines(ics).find((l) => l.startsWith('ORGANIZER'));
    expect(organiser).toContain('mailto:notifications@mail.eiaawsolutions.com');
  });

  it('includes a reminder alarm', () => {
    expect(lines(ics)).toContain('BEGIN:VALARM');
    expect(lines(ics)).toContain('TRIGGER:-PT60M');
  });

  it('opens and closes the calendar and event blocks', () => {
    const l = lines(ics);
    expect(l[0]).toBe('BEGIN:VCALENDAR');
    expect(l.filter(Boolean).at(-1)).toBe('END:VCALENDAR');
    expect(l).toContain('BEGIN:VEVENT');
    expect(l).toContain('END:VEVENT');
  });
});

describe('buildIcs — reschedule (FR-3.7, AT-04)', () => {
  const original = buildIcs({ ...BASE, sequence: 0, method: 'REQUEST' });
  const rescheduled = buildIcs({
    ...BASE,
    sequence: 1,
    method: 'REQUEST',
    startsAt: new Date('2026-09-15T06:00:00.000Z'),
    endsAt: new Date('2026-09-15T06:45:00.000Z'),
  });

  it('keeps the same UID so calendars update rather than duplicate', () => {
    const uidOf = (ics: string) => lines(ics).find((l) => l.startsWith('UID:'));
    expect(uidOf(rescheduled)).toBe(uidOf(original));
  });

  it('increments SEQUENCE so the update is not ignored as stale', () => {
    expect(lines(original)).toContain('SEQUENCE:0');
    expect(lines(rescheduled)).toContain('SEQUENCE:1');
  });

  it('carries the new time', () => {
    expect(lines(rescheduled)).toContain('DTSTART:20260915T060000Z');
    expect(lines(rescheduled)).toContain('DTEND:20260915T064500Z');
  });
});

describe('buildIcs — CANCEL (FR-3.7)', () => {
  const ics = buildIcs({ ...BASE, sequence: 2, method: 'CANCEL' });

  it('declares METHOD:CANCEL', () => {
    expect(lines(ics)).toContain('METHOD:CANCEL');
  });

  it('marks the event cancelled and frees the time', () => {
    expect(lines(ics)).toContain('STATUS:CANCELLED');
    expect(lines(ics)).toContain('TRANSP:TRANSPARENT');
  });

  it('does not ask for an RSVP on a cancellation', () => {
    for (const line of lines(ics).filter((l) => l.startsWith('ATTENDEE'))) {
      expect(line).toContain('RSVP=FALSE');
    }
  });

  it('omits the reminder alarm', () => {
    expect(lines(ics)).not.toContain('BEGIN:VALARM');
  });

  it('retains the UID of the appointment being cancelled', () => {
    expect(lines(ics)).toContain('UID:appt-123@app.chambersofkoon.com.my');
  });
});

describe('appointmentUid', () => {
  it('is stable and domain-qualified', () => {
    expect(appointmentUid('abc-def', 'app.chambersofkoon.com.my')).toBe(
      'abc-def@app.chambersofkoon.com.my',
    );
  });
});

describe('escaping inside a built invitation', () => {
  it('escapes commas in a summary rather than splitting the property', () => {
    const ics = buildIcs({
      ...BASE,
      sequence: 0,
      method: 'REQUEST',
      summary: 'Consultation, first — Tan, Y.K.',
    });
    expect(unfold(ics)).toContain('SUMMARY:Consultation\\, first — Tan\\, Y.K.');
  });
});
