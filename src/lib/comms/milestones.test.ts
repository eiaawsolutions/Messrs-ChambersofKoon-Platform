import { describe, expect, it } from 'vitest';
import { classifySuppression, withheldMessageContent, SUBJECT_MAX } from './milestones';

/**
 * FR-7.4 is the decision to *not* write to a client. That decision is the one
 * most likely to be questioned months later — "you never told me about the
 * hearing" — so it has to leave the same quality of evidence as a send.
 *
 * The two functions under test are the whole decision: what counts as
 * suppression, and what the withheld row records. Both are pure so the
 * assertions run without a database standing in the way.
 */

describe('classifySuppression — what stops a client update', () => {
  it('lets an ordinary milestone through', () => {
    expect(
      classifySuppression({ eventSuppressed: false, commsHold: false, stageSuppressed: false }),
    ).toBeNull();
  });

  it('treats an absent hold flag as not held', () => {
    // A left join or a fresh matter can leave these null; null is not a hold.
    expect(
      classifySuppression({ eventSuppressed: null, commsHold: null, stageSuppressed: false }),
    ).toBeNull();
  });

  it('catches a stage the clerk marked suppressed as they recorded it', () => {
    const result = classifySuppression({ eventSuppressed: true, stageSuppressed: false });
    expect(result?.source).toBe('recorded_suppressed');
    expect(result?.reason).toBe('suppressed at the point of recording');
  });

  it('catches a matter on communications hold', () => {
    const result = classifySuppression({ commsHold: true, stageSuppressed: false });
    expect(result?.source).toBe('matter_hold');
    expect(result?.reason).toBe('matter is on communications hold');
  });

  it('catches a stage suppressed on this matter', () => {
    const result = classifySuppression({ stageSuppressed: true });
    expect(result?.source).toBe('stage_suppression');
    expect(result?.reason).toBe('stage is suppressed on this matter');
  });

  it('reports the point-of-recording decision ahead of a later hold', () => {
    // All three are true. The clerk's own decision is the most specific fact
    // about this event, so it is the one worth recording.
    const result = classifySuppression({
      eventSuppressed: true,
      commsHold: true,
      stageSuppressed: true,
    });
    expect(result?.source).toBe('recorded_suppressed');
  });

  it('reports a whole-matter hold ahead of a single suppressed stage', () => {
    const result = classifySuppression({ commsHold: true, stageSuppressed: true });
    expect(result?.source).toBe('matter_hold');
  });

  it('gives every source a reason a lawyer can read', () => {
    const sources = [
      classifySuppression({ eventSuppressed: true }),
      classifySuppression({ commsHold: true }),
      classifySuppression({ stageSuppressed: true }),
    ];
    for (const source of sources) {
      expect(source?.reason.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('withheldMessageContent — the evidence a hold leaves behind', () => {
  const base = { reason: 'matter is on communications hold' };

  it('records who the update would have gone to', () => {
    const row = withheldMessageContent({ ...base, clientEmail: 'client@example.com' });
    expect(row.toEmail).toBe('client@example.com');
  });

  it('records what would have been sent', () => {
    const row = withheldMessageContent({ ...base, templateKey: 'hearing_date_set' });
    expect(row.templateKey).toBe('hearing_date_set');
  });

  it('records the reason where the matter page will show it', () => {
    const row = withheldMessageContent(base);
    expect(row.subject).toContain('matter is on communications hold');
  });

  it('leaves the error column null, because a hold is not a failure', () => {
    // The matter page renders `error` in the danger colour. A deliberate hold
    // shown in red would misreport a decision as a fault — the same class of
    // problem as a chip claiming an escalation that never happened.
    expect(withheldMessageContent(base).error).toBeNull();
  });

  it('leaves the body empty, because nothing was rendered', () => {
    expect(withheldMessageContent(base).bodyRendered).toBe('');
  });

  it('falls back to an empty recipient when the client has no email', () => {
    // to_email is NOT NULL; a missing address must not break the record of
    // the withholding.
    const row = withheldMessageContent({ ...base, clientEmail: null });
    expect(row.toEmail).toBe('');
  });

  it('falls back to a null template when the stage has none', () => {
    expect(withheldMessageContent({ ...base, templateKey: null }).templateKey).toBeNull();
  });

  it('keeps the subject inside the column width', () => {
    const row = withheldMessageContent({ ...base, reason: 'x'.repeat(SUBJECT_MAX * 2) });
    expect(row.subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
  });
});
