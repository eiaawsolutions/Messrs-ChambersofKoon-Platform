import { describe, expect, it } from 'vitest';
import {
  catalogueFor,
  DEFAULT_LOCALE,
  LOCALES,
  resolveLocale,
  t,
  untranslatedKeys,
  type Locale,
  type MessageKey,
} from './catalogue';

describe('message catalogue (NFR-5.2)', () => {
  it('returns the English string at launch', () => {
    expect(t('enquiry.title')).toBe('Make an enquiry');
    expect(t('enquiry.title', 'en-MY')).toBe('Make an enquiry');
  });

  it('falls back to English for an untranslated key', () => {
    // The point of the fallback: a half-finished Malay translation shows
    // English where it is incomplete rather than a blank or a key name.
    expect(t('enquiry.title', 'ms-MY')).toBe('Make an enquiry');
  });

  it('never returns an empty string for any key in any locale', () => {
    const keys = Object.keys(catalogueFor('en-MY')) as MessageKey[];
    for (const locale of LOCALES) {
      for (const key of keys) {
        expect(t(key, locale).length).toBeGreaterThan(0);
      }
    }
  });

  it('English is complete by construction', () => {
    expect(untranslatedKeys('en-MY')).toEqual([]);
  });

  it('reports what a partial locale still needs', () => {
    // Bahasa Malaysia is deliberately empty at launch, so this is the whole
    // key set — and the number a translator is quoted from.
    const outstanding = untranslatedKeys('ms-MY');
    expect(outstanding.length).toBe(Object.keys(catalogueFor('en-MY')).length);
  });

  it('resolves a known locale and rejects anything else', () => {
    expect(resolveLocale('ms-MY')).toBe('ms-MY');
    expect(resolveLocale('en-MY')).toBe('en-MY');
    for (const rubbish of [null, undefined, '', 'fr', 'en', '../../etc/passwd', 'en-MY ']) {
      expect(resolveLocale(rubbish)).toBe(DEFAULT_LOCALE);
    }
  });

  it('catalogueFor returns every key, English-filled', () => {
    const english = catalogueFor('en-MY');
    const malay = catalogueFor('ms-MY');

    expect(Object.keys(malay)).toEqual(Object.keys(english));
    expect(malay).toEqual(english);
  });

  it('adding a locale needs no change to the lookup', () => {
    // The mechanism NFR-5.2 asks for: every declared locale already resolves.
    for (const locale of LOCALES) {
      expect(() => catalogueFor(locale as Locale)).not.toThrow();
    }
  });
});
