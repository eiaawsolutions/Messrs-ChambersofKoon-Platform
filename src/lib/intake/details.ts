import { z } from 'zod';
import { ENQUIRY_TYPE_IDS, enquiryTypeById } from '@/lib/intake/enquiry-types';

/**
 * The enquiry details contract (FR-2.1, FR-2.2).
 *
 * The firm's website form would not submit without a name, an email, a contact
 * number and an enquiry type. Both entry points into the platform now ask for
 * the same four before anything else happens: the widget shows them as its
 * first screen, and the page at /enquiry is the same form served without
 * scripting.
 *
 * The rules live here, once, rather than in each route handler. Two entry
 * points with two hand-written schemas drift, and they drift in the direction
 * that costs the firm an enquiry — the widget accepting a phone number the
 * form would have rejected, or the reverse. Client-side validation in the
 * widget is a courtesy to the person typing; this module is the authority, and
 * the server re-parses everything regardless of what the client checked.
 *
 * No `server-only` import: the widget bundle imports the codes for its own
 * first pass. Nothing here reads the database or a secret.
 */

/** Malaysia. Used when a local number arrives without a country code. */
const MY_COUNTRY_CODE = '60';

/** Matches the `message` column budget and the widget's own maxlength. */
export const MAX_MESSAGE_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Rejection codes
// ---------------------------------------------------------------------------

/**
 * A closed set, keyed by a stable code.
 *
 * Handlers return the code and each surface renders its own copy, so nothing
 * the caller supplied is ever reflected back onto a page — the same discipline
 * as REVISION_ERRORS in documents/revise.ts.
 */
export const DETAIL_ERRORS = {
  name_required: 'Enter your name.',
  name_too_short: 'Enter your full name so the firm knows who it is speaking to.',
  email_required: 'Enter an email address.',
  email_invalid: 'That email address does not look right. Check it and try again.',
  phone_required: 'Enter a contact number.',
  phone_invalid:
    'That does not look like a number the firm can call. Include the mobile or area prefix.',
  type_required: 'Choose the type of enquiry.',
  type_unknown: 'Choose one of the listed enquiry types.',
  message_too_long: 'That message is too long. Please keep it under 4,000 characters.',
  too_long: 'That is longer than this field allows.',
} as const;

export type DetailErrorCode = keyof typeof DETAIL_ERRORS;

export const DETAIL_FIELDS = [
  'contactName',
  'contactEmail',
  'contactPhone',
  'enquiryType',
  'message',
] as const;

export type DetailField = (typeof DETAIL_FIELDS)[number];

/** The code reported when a field is absent altogether rather than malformed. */
const MISSING: Record<DetailField, DetailErrorCode> = {
  contactName: 'name_required',
  contactEmail: 'email_required',
  contactPhone: 'phone_required',
  enquiryType: 'type_required',
  message: 'message_too_long',
};

/**
 * Codes travel as zod's message string, which keeps the schema readable and
 * lets zod map issues back to fields. This wrapper exists so a mistyped code is
 * a compile error rather than a message that renders as "undefined".
 */
function code(value: DetailErrorCode): string {
  return value;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Deliberately permissive. A refused address costs the firm an enquiry, and
 * the only real test of an email address is sending to it — which the platform
 * does within the hour. This catches the class that is certainly wrong (no @,
 * no dot in the domain, whitespace) and lets everything else through.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Malaysian numbers, canonicalised to E.164.
 *
 * The same person writes `012-555 0148`, `0125550148` and `+60 12 555 0148` on
 * three different days, and a firm holding all three cannot tell it has one
 * client. Storage is therefore canonical and display is a separate concern —
 * see `formatPhone`.
 *
 * A number already carrying a country code other than 60 is kept as an
 * international number rather than coerced: the firm has clients abroad, and
 * silently rewriting +65 to +60 produces a number that dials a stranger.
 *
 * Returns null when the input cannot be a dialable number at all, which is
 * what separates a real mistake from a box someone typed a dash into.
 */
export function normalisePhone(raw: string): string | null {
  const compact = raw.replace(/[\s()./-]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  let nsn: string;

  if (compact.startsWith('+')) {
    const digits = compact.slice(1);
    if (!digits.startsWith(MY_COUNTRY_CODE)) {
      // Somewhere else. E.164 allows 15 digits including the country code.
      return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
    }
    nsn = digits.slice(MY_COUNTRY_CODE.length).replace(/^0+/, '');
  } else if (compact.startsWith(MY_COUNTRY_CODE) && compact.length >= 10) {
    nsn = compact.slice(MY_COUNTRY_CODE.length).replace(/^0+/, '');
  } else {
    nsn = compact.replace(/^0+/, '');
  }

  // Malaysian national significant numbers run from 8 digits (05-xxx xxxx) to
  // 10 (mobile 01x-xxxx xxxx), and never begin with 0 once the trunk prefix is
  // gone.
  if (!/^[1-9]\d{7,9}$/.test(nsn)) return null;

  return `+${MY_COUNTRY_CODE}${nsn}`;
}

/**
 * The readable form of a stored number, for anything a person reads.
 *
 * Mobile prefixes are two digits (01x) and landline area codes are one (03 for
 * Kuala Lumpur, 05 for Perak), so the split cannot be a fixed width — grouping
 * 03-2856 7000 as 032-856 7000 reads as a typo to every Malaysian who sees it.
 *
 * An international number is left as it arrived: guessing another country's
 * grouping produces something that reads as wrong to anyone who knows it.
 */
export function formatPhone(e164: string): string {
  const malaysian = /^\+60(\d{8,10})$/.exec(e164);
  if (!malaysian) return e164;

  const nsn = malaysian[1] as string;
  const prefix = nsn.startsWith('1') ? nsn.slice(0, 2) : nsn.slice(0, 1);
  const rest = nsn.slice(prefix.length);

  return `0${prefix}-${rest.slice(0, -4)} ${rest.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const detailsSchema = z.object({
  contactName: z
    .string()
    .max(200, code('too_long'))
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .refine((v) => v.length > 0, code('name_required'))
    // One character is a typo. Two is "Ng", a real Malaysian surname, and must
    // not be refused.
    .refine((v) => v.length >= 2, code('name_too_short')),

  contactEmail: z
    .string()
    .max(320, code('too_long'))
    .transform((v) => v.trim().toLowerCase())
    .refine((v) => v.length > 0, code('email_required'))
    .refine((v) => EMAIL_PATTERN.test(v), code('email_invalid')),

  contactPhone: z
    .string()
    .max(40, code('too_long'))
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, code('phone_required'))
    .refine((v) => normalisePhone(v) !== null, code('phone_invalid'))
    .transform((v) => normalisePhone(v) as string),

  enquiryType: z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, code('type_required'))
    .refine((v) => (ENQUIRY_TYPE_IDS as readonly string[]).includes(v), code('type_unknown')),

  message: z
    .string()
    .max(MAX_MESSAGE_LENGTH, code('message_too_long'))
    .transform((v) => v.trim())
    .optional(),
});

export interface EnquiryDetails {
  contactName: string;
  contactEmail: string;
  /** E.164. Use `formatPhone` for anything a person reads. */
  contactPhone: string;
  enquiryType: string;
  message?: string;
}

export type DetailErrors = Partial<Record<DetailField, DetailErrorCode>>;

export type ParseResult =
  { ok: true; details: EnquiryDetails } | { ok: false; errors: DetailErrors };

function isDetailField(value: unknown): value is DetailField {
  return typeof value === 'string' && (DETAIL_FIELDS as readonly string[]).includes(value);
}

/**
 * Parse and normalise a set of submitted details.
 *
 * Only the first failure per field is reported: a box is corrected once, and
 * listing "required" and "invalid" against the same empty field helps nobody.
 */
export function parseEnquiryDetails(input: unknown): ParseResult {
  const result = detailsSchema.safeParse(input);

  if (result.success) {
    const { message, ...rest } = result.data;
    return { ok: true, details: message ? { ...rest, message } : rest };
  }

  const errors: DetailErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (!isDetailField(field) || errors[field]) continue;
    // A field omitted altogether fails zod's own type check and carries zod's
    // wording, not ours — report it as missing rather than leaking that text.
    errors[field] = (
      issue.message in DETAIL_ERRORS ? issue.message : MISSING[field]
    ) as DetailErrorCode;
  }

  return { ok: false, errors };
}

/**
 * The first line of the transcript, built from the details.
 *
 * The message box is optional, so an enquiry can arrive holding nothing but
 * the four required answers. Triage still needs something to classify, and the
 * enquirer's own choice of type is the strongest signal available before a
 * word has been typed — stated in the firm's own public wording rather than
 * translated into an internal practice-area name the person never saw.
 */
export function composeInitialMessage(details: EnquiryDetails): string {
  const selected = enquiryTypeById(details.enquiryType);
  const lines = [
    selected ? `Enquiry type selected: ${selected.label}.` : '',
    details.message ?? '',
  ];
  const body = lines.filter(Boolean).join('\n\n');

  return body || 'No details supplied beyond the contact information.';
}
