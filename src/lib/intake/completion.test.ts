import { describe, expect, it } from 'vitest';
import { looksComplete } from './triage';

/**
 * The widget now opens with the firm's own enquiry form, so a modern enquiry
 * arrives with name, email, number and type already on file — the
 * `detailsOnFile` cases below.
 *
 * The graduated cases cover everything else: enquiries opened before the form
 * existed, and anything entered by hand, where contact details have to be
 * recovered from the conversation. Hold on for the missing detail, but never
 * at the cost of losing the enquiry entirely.
 */

const answering = { reply: 'Thank you — I have what I need.', exchanges: 4 };
const asking = { reply: 'And what is the best number to reach you on?', exchanges: 4 };

describe('looksComplete', () => {
  it('closes once both an email and a number are on file', () => {
    expect(looksComplete({ ...answering, hasEmail: true, hasPhone: true })).toBe(true);
  });

  it('does not close early when only an email was given', () => {
    // Still asking, exchange 4 — the agent gets its turn to request the number.
    expect(looksComplete({ ...asking, hasEmail: true, hasPhone: false })).toBe(false);
  });

  it('does not close early when only a number was given', () => {
    expect(looksComplete({ ...asking, hasEmail: false, hasPhone: true })).toBe(false);
  });

  it('closes on one channel rather than pressing twice', () => {
    expect(
      looksComplete({
        reply: 'Could you share an email too?',
        exchanges: 5,
        hasEmail: false,
        hasPhone: true,
      }),
    ).toBe(true);
  });

  it('closes when the agent stops asking questions', () => {
    expect(
      looksComplete({
        reply: 'I have enough to pass this to the team.',
        exchanges: 3,
        hasEmail: false,
        hasPhone: false,
      }),
    ).toBe(true);
  });

  it('keeps going while the agent is still asking and nothing is on file', () => {
    expect(
      looksComplete({
        reply: 'How long were you married?',
        exchanges: 3,
        hasEmail: false,
        hasPhone: false,
      }),
    ).toBe(false);
  });

  it('closes at the hard cap even with no contact details at all', () => {
    // Someone who will not give details still gets handed to a person rather
    // than trapped in a loop.
    expect(
      looksComplete({ reply: 'And your name?', exchanges: 6, hasEmail: false, hasPhone: false }),
    ).toBe(true);
  });

  it('treats a trailing question mark as still asking, whitespace and all', () => {
    expect(
      looksComplete({
        reply: 'What is your email?  \n',
        exchanges: 3,
        hasEmail: false,
        hasPhone: false,
      }),
    ).toBe(false);
  });
});

describe('looksComplete when the opening form supplied the details', () => {
  const onFile = { hasEmail: true, hasPhone: true, detailsOnFile: true };

  it('closes as soon as the agent stops asking', () => {
    // Only the facts were outstanding, and the agent has just said it has
    // them. Another round would be a question we do not need answered.
    expect(
      looksComplete({ ...onFile, reply: 'Thank you — I have what I need.', exchanges: 2 }),
    ).toBe(true);
  });

  it('keeps going while the agent is still asking about the matter', () => {
    expect(looksComplete({ ...onFile, reply: 'How long were you married?', exchanges: 2 })).toBe(
      false,
    );
  });

  it('does not close on the opening exchange alone', () => {
    // The form is not an enquiry brief. One exchange gives a lawyer the
    // person's name and a category, and nothing about what happened.
    expect(looksComplete({ ...onFile, reply: 'Thank you.', exchanges: 1 })).toBe(false);
  });

  it('still closes at the hard cap when the agent will not stop asking', () => {
    expect(looksComplete({ ...onFile, reply: 'And after that?', exchanges: 6 })).toBe(true);
  });

  it('matches the demo script: four exchanges, then the brief', () => {
    // Form submitted, three follow-up rounds, agent signs off.
    expect(
      looksComplete({
        ...onFile,
        reply: 'Understood, and thank you — I have everything I need.',
        exchanges: 4,
      }),
    ).toBe(true);
  });
});
