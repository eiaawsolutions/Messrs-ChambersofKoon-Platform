import 'server-only';
import { db } from '@/lib/db/client';
import { enquiryMessages } from '@/lib/db/schema';
import { buildCaseBrief } from '@/lib/intake/triage';
import { flagDuplicates } from '@/lib/intake/duplicate-check';
import { proposeSlot, officeAddress } from '@/lib/scheduling/service';
import { formatSlotForClient } from '@/lib/scheduling/slots';
import { enqueue, JOBS } from '@/lib/jobs/queue';

/**
 * The handover turn — the moment intake stops and the firm takes over.
 *
 * Everything else in the conversation is one model call and a reply. This turn
 * does the whole handover so the enquirer leaves knowing what happens next:
 * brief, then proposal, then a closing line that names the slot.
 *
 * ## Why this runs inline rather than in the worker
 *
 * The brief and the proposal used to be queued, which meant the last thing the
 * enquirer heard was that someone would be in touch — true, but it is the
 * sentence every firm's contact form already sends. Naming the time is the
 * difference between an acknowledgement and an appointment, and it can only be
 * named if the slot exists before the reply is written.
 *
 * The cost is a Sonnet call plus a scheduling sweep on the final turn of an
 * unauthenticated endpoint. That is bounded: it happens once per conversation,
 * behind the new-conversation limit of 8 per IP per day.
 *
 * ## What it will not do
 *
 * FR-3.4 is unchanged. Nothing here emails the enquirer, and `proposeSlot` has
 * no path that does. The slot is *proposed*, the wording says so, and the
 * invitation is still sent only when a lawyer accepts. A lawyer who declines or
 * reschedules changes a time the enquirer has already been told — which is why
 * the sentence commits to confirmation, never to attendance.
 */

export interface HandoverResult {
  /** Appended to the agent's reply. Empty when no slot could be named. */
  closingLine: string;
  proposalId: string | null;
}

/** Falls back to the generic close whenever anything is not certain. */
const GENERIC_CLOSE =
  'I have prepared a summary for the team and someone from the firm will be in touch to arrange a consultation. Nothing further is needed from you tonight.';

export async function handOverToFirm(enquiryId: string): Promise<HandoverResult> {
  const result = await decide(enquiryId);

  // The transcript has to match what the enquirer was shown, or a lawyer
  // reading it later will not understand why a client is expecting a Tuesday.
  // Recorded after the brief is built, not before, so the brief is derived
  // from the conversation rather than from the platform's own closing line.
  try {
    await db.insert(enquiryMessages).values({
      enquiryId,
      role: 'assistant',
      content: result.closingLine,
    });
  } catch (error) {
    console.error('[intake] could not record the closing line', (error as Error).message);
  }

  return result;
}

async function decide(enquiryId: string): Promise<HandoverResult> {
  try {
    /*
     * FR-2.8, checked before the model call rather than after.
     *
     * A held enquiry needs no brief and no slot, so running this first also
     * means a script cannot spend the firm's Sonnet budget by repeating
     * itself. The enquirer is never told they were flagged — they get the same
     * close as anyone whose enquiry a person will look at, which is exactly
     * what happens next.
     */
    const flag = await flagDuplicates(enquiryId);
    if (flag.disposition === 'spam') {
      return { closingLine: GENERIC_CLOSE, proposalId: null };
    }

    const outcome = await buildCaseBrief(enquiryId);

    // FR-2.6: a low-confidence or incomplete brief goes to a person. Naming a
    // time here would commit the firm to a consultation it has not triaged.
    if (!outcome.autoProposeSlot) {
      return { closingLine: GENERIC_CLOSE, proposalId: null };
    }

    const proposal = await proposeSlot(enquiryId);
    if (!proposal) {
      // Classified fine, but no availability rule matched. The enquiry is in
      // the queue; a human will schedule it.
      return { closingLine: GENERIC_CLOSE, proposalId: null };
    }

    const area = outcome.brief.practiceArea.replace(/_/g, ' ');

    return {
      proposalId: proposal.proposalId,
      closingLine:
        `Based on what you have shared, this falls under our ${area} practice. ` +
        `I have prepared a summary for that team and proposed a consultation on ` +
        `${formatSlotForClient(proposal.slot)} at ${officeAddress(proposal.office)}. ` +
        `You will receive confirmation once the lawyer approves it — the time may change ` +
        `until then. Nothing further is needed from you tonight.`,
    };
  } catch (error) {
    // The conversation itself succeeded; only the handover failed. Queue the
    // work that would have run here and close on the generic line rather than
    // telling someone in distress that something went wrong.
    console.error(
      '[intake] inline handover failed, falling back to the queue',
      (error as Error).message,
    );
    try {
      await enqueue(JOBS.TRIAGE_ENQUIRY, { enquiryId }, { singletonKey: `triage-${enquiryId}` });
    } catch (queueError) {
      console.error('[intake] handover fallback enqueue failed', (queueError as Error).message);
    }
    return { closingLine: GENERIC_CLOSE, proposalId: null };
  }
}
