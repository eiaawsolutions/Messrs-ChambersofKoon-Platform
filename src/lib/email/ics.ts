/**
 * RFC 5545 iCalendar builder (FR-3.6, FR-3.7).
 *
 * Written by hand rather than pulled from a library because the acceptance
 * criteria are about exact wire format: a stable UID across reschedules, a
 * SEQUENCE that increments, METHOD:REQUEST vs METHOD:CANCEL, and an ORGANIZER
 * whose address matches the SMTP envelope. Gmail, Outlook and Apple Mail each
 * refuse to render an invitation for a different reason when these are wrong
 * (AT-03, AT-04), and most convenience libraries hide exactly these fields.
 *
 * Everything here is pure — no I/O — so the output can be asserted byte for
 * byte in tests.
 */

export type IcsMethod = 'REQUEST' | 'CANCEL';

export interface IcsAttendee {
  email: string;
  name?: string;
  /** Attendees whose acceptance is expected. Organiser is separate. */
  rsvp?: boolean;
}

export interface IcsEventInput {
  uid: string;
  sequence: number;
  method: IcsMethod;
  summary: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  organiser: { email: string; name?: string };
  attendees: IcsAttendee[];
  /** Overridable for deterministic tests. */
  now?: Date;
  /** Product identifier written into PRODID. */
  prodId?: string;
}

const DEFAULT_PRODID = '-//EIAAW Solutions//Matter Velocity Platform//EN';

/** RFC 5545 dates are UTC basic format with a trailing Z. */
export function formatIcsDate(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * Escape TEXT values per RFC 5545 §3.3.11.
 * Order matters: backslash first, or subsequently inserted backslashes get
 * double-escaped.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold lines to 75 octets per RFC 5545 §3.1, continuing with a single space.
 *
 * Counted in UTF-8 octets rather than JS characters: a Malaysian name with a
 * multi-byte character would otherwise push the line over the limit and
 * Outlook silently drops the property.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  // First line allows 75 octets; continuations allow 74 (one is the leading space).
  let limit = 75;

  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    if (currentBytes + charBytes > limit) {
      out.push(current);
      current = char;
      currentBytes = charBytes;
      limit = 74;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current) out.push(current);

  return out.map((part, index) => (index === 0 ? part : ` ${part}`)).join('\r\n');
}

function attendeeLine(attendee: IcsAttendee, method: IcsMethod): string {
  const params = [
    'CUTYPE=INDIVIDUAL',
    'ROLE=REQ-PARTICIPANT',
    // A cancellation must not ask for an RSVP.
    method === 'CANCEL' ? 'PARTSTAT=DECLINED' : 'PARTSTAT=NEEDS-ACTION',
    method === 'CANCEL' ? 'RSVP=FALSE' : `RSVP=${attendee.rsvp === false ? 'FALSE' : 'TRUE'}`,
  ];
  if (attendee.name) params.push(`CN=${escapeIcsText(attendee.name)}`);
  return `ATTENDEE;${params.join(';')}:mailto:${attendee.email}`;
}

export function buildIcs(input: IcsEventInput): string {
  const now = input.now ?? new Date();
  const isCancel = input.method === 'CANCEL';

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${input.prodId ?? DEFAULT_PRODID}`,
    'CALSCALE:GREGORIAN',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    // UID is stable across the whole life of the appointment. This is what
    // makes a reschedule update the existing calendar entry instead of
    // creating a duplicate (AT-04).
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${formatIcsDate(now)}`,
    `DTSTART:${formatIcsDate(input.startsAt)}`,
    `DTEND:${formatIcsDate(input.endsAt)}`,
    `SUMMARY:${escapeIcsText(input.summary)}`,
  ];

  if (input.location) {
    lines.push(`LOCATION:${escapeIcsText(input.location)}`);
  }
  if (input.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(input.description)}`);
  }

  const organiserParams = input.organiser.name ? `;CN=${escapeIcsText(input.organiser.name)}` : '';
  lines.push(`ORGANIZER${organiserParams}:mailto:${input.organiser.email}`);

  for (const attendee of input.attendees) {
    lines.push(attendeeLine(attendee, input.method));
  }

  lines.push(`STATUS:${isCancel ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push(`TRANSP:${isCancel ? 'TRANSPARENT' : 'OPAQUE'}`);

  // A reminder is only meaningful on a live invitation.
  if (!isCancel) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'TRIGGER:-PT60M',
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  // CRLF line endings are mandatory (RFC 5545 §3.1); LF-only breaks Outlook.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * Stable UID for an appointment.
 *
 * Derived from the appointment's own primary key so it survives reschedules
 * and is reproducible if a send has to be replayed. The domain part must be a
 * real domain the organiser controls, or Exchange treats the invitation as
 * spoofed.
 */
export function appointmentUid(appointmentId: string, domain: string): string {
  return `${appointmentId}@${domain}`;
}
