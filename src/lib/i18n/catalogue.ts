/**
 * Message catalogue for client-facing copy (NFR-5.2).
 *
 * "English (Malaysia) at launch; copy externalised in a message catalogue so
 *  Bahasa Malaysia can be added without code changes."
 *
 * ## What is in here, and what deliberately is not
 *
 * Everything a **member of the public** reads: the enquiry form, the widget
 * panel, the confirmation page, the reschedule link. Those are the surfaces a
 * client meets, often at the worst moment of their year, and "without code
 * changes" is a real requirement for them — adding Bahasa Malaysia means
 * adding one object below and nothing else.
 *
 * The **staff dashboard is not here**, and that is a decision rather than an
 * omission. It is used by a firm that works in English, its vocabulary is
 * legal-professional rather than lay, and translating it would triple the
 * surface for no requirement — NFR-5.2 asks for a catalogue that makes Bahasa
 * Malaysia *addable*, and the audience that needs it is the public one. If the
 * firm later wants a Malay dashboard, the mechanism is already here and the
 * work is transcription.
 *
 * Email templates are already externalised elsewhere and better: they live in
 * `message_templates`, carry a `locale` column, and are editable by an admin
 * without a deploy at all.
 *
 * ## No library
 *
 * A typed object and a lookup. The catalogue is a few dozen strings on a
 * surface with no pluralisation rules to speak of and no runtime locale
 * negotiation to do, so an i18n framework would add a dependency, a build step
 * and a class of missing-key runtime failures in exchange for nothing. `t()`
 * cannot miss a key: `MessageKey` is derived from the English catalogue, so a
 * typo does not compile.
 */

export const LOCALES = ['en-MY', 'ms-MY'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en-MY';

/**
 * The English catalogue is the source of truth for the key set. Every other
 * locale is a `Partial` of it, so a translation may be incomplete without
 * breaking the build — an untranslated string falls back to English, which is
 * the behaviour a half-finished translation should have.
 */
const EN_MY = {
  // --- Enquiry form (FR-2.2) -----------------------------------------------
  'enquiry.title': 'Make an enquiry',
  'enquiry.intro':
    'Tell us what has happened and how to reach you. A member of the firm will respond. We cannot give legal advice through this form, and sending it does not create a solicitor-client relationship.',
  'enquiry.field.name': 'Your name',
  'enquiry.field.email': 'Email',
  'enquiry.field.phone': 'Telephone',
  'enquiry.field.type': 'What is this about?',
  'enquiry.field.message': 'What has happened?',
  'enquiry.submit': 'Send enquiry',
  'enquiry.consent.prefix': 'I have read and accept the',
  'enquiry.consent.terms': 'terms and conditions',
  'enquiry.consent.and': 'and the',
  'enquiry.consent.privacy': 'privacy policy',

  // --- Confirmation --------------------------------------------------------
  'received.title': 'Thank you — we have it',
  'received.body':
    'Your enquiry has reached the firm. A member of the team will review it and respond. You will hear from us by email.',
  'received.emergency': 'If someone is in immediate danger, call the police on 999.',
  'received.failed.title': 'We could not send that',
  'received.failed.body':
    'Something went wrong, or too many enquiries have come from this connection recently. Please try again shortly. If the matter is urgent, telephone the office directly.',
  'received.failed.back': 'Back to the form',

  // --- Client reschedule link (FR-3.8) -------------------------------------
  'reschedule.title': 'Move your consultation',
  'reschedule.current': 'Currently booked',
  'reschedule.choose': 'Choose a time that suits you better',
  'reschedule.submit': 'Request this time',
  'reschedule.urgent':
    'If this is urgent, please telephone the office rather than waiting for a reply here.',

  // --- Widget panel (FR-2.1) -----------------------------------------------
  'widget.launcher': 'Make an enquiry',
  'widget.close': 'Close',
  'widget.send': 'Send',
  'widget.placeholder': 'Type your message',
  'widget.disclaimer': 'This is not legal advice. Do not send anything confidential.',
} as const;

export type MessageKey = keyof typeof EN_MY;

/**
 * Bahasa Malaysia.
 *
 * Empty at launch, and empty on purpose — machine-translating a firm's client
 * correspondence into a language nobody on the delivery team reads well enough
 * to check is how a platform ends up telling someone the wrong thing about
 * their divorce. The structure is proven by the fallback tests; the strings
 * come from the firm, or from a translator the firm trusts.
 */
const MS_MY: Partial<Record<MessageKey, string>> = {};

const CATALOGUES: Record<Locale, Partial<Record<MessageKey, string>>> = {
  'en-MY': EN_MY,
  'ms-MY': MS_MY,
};

/** Look up a string, falling back to English for anything untranslated. */
export function t(key: MessageKey, locale: Locale = DEFAULT_LOCALE): string {
  return CATALOGUES[locale]?.[key] ?? EN_MY[key];
}

/** Narrow an arbitrary string — a query parameter, a header — to a known locale. */
export function resolveLocale(candidate: string | null | undefined): Locale {
  return LOCALES.includes(candidate as Locale) ? (candidate as Locale) : DEFAULT_LOCALE;
}

/**
 * The whole catalogue for one locale, English-filled.
 *
 * Used by the widget, which is a separate bundle served to the firm's website
 * and cannot import this module at runtime — it receives the strings with its
 * configuration instead, so a translation reaches visitors without the firm
 * touching their site.
 */
export function catalogueFor(locale: Locale): Record<MessageKey, string> {
  const out = {} as Record<MessageKey, string>;
  for (const key of Object.keys(EN_MY) as MessageKey[]) out[key] = t(key, locale);
  return out;
}

/** Which keys a locale still needs. Empty for `en-MY` by construction. */
export function untranslatedKeys(locale: Locale): MessageKey[] {
  const catalogue = CATALOGUES[locale] ?? {};
  return (Object.keys(EN_MY) as MessageKey[]).filter((key) => catalogue[key] === undefined);
}
