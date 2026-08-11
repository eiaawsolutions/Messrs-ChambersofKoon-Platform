import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { messages } from '@/lib/db/schema';
import { raiseException } from '@/lib/comms/milestones';
import { audit, AUDIT_ACTIONS } from '@/lib/audit/log';

/**
 * Delivery-state write-back from provider webhooks (FR-7.5).
 *
 * Kept out of the route handler so the handler is only signature verification
 * plus dispatch, which is the part that has to be obviously correct on review.
 */

export type DeliveryEvent =
  'email.delivered' | 'email.bounced' | 'email.complained' | 'email.delivery_delayed';

export interface DeliveryOutcome {
  handled: boolean;
  note: string;
}

export async function recordDelivery(params: {
  providerMessageId: string;
  event: string;
}): Promise<DeliveryOutcome> {
  const [message] = await db
    .select({ id: messages.id, matterId: messages.matterId, toEmail: messages.toEmail })
    .from(messages)
    .where(eq(messages.resendMessageId, params.providerMessageId))
    .limit(1);

  if (!message) {
    // A message this environment did not send (e.g. another environment sharing
    // the sending domain). Acknowledge so the provider stops retrying.
    return { handled: false, note: 'unknown message' };
  }

  switch (params.event) {
    case 'email.delivered':
      await db
        .update(messages)
        .set({ state: 'delivered', deliveredAt: new Date() })
        .where(eq(messages.id, message.id));
      return { handled: true, note: 'delivered' };

    case 'email.bounced':
    case 'email.complained': {
      await db
        .update(messages)
        .set({ state: 'bounced', error: params.event })
        .where(eq(messages.id, message.id));

      // FR-7.5 / FR-7.6: raise a task for staff. The client is never chased
      // about their own bounce.
      await raiseException({
        matterId: message.matterId,
        messageId: message.id,
        kind: params.event === 'email.bounced' ? 'email_bounced' : 'email_complaint',
        title:
          params.event === 'email.bounced'
            ? `Client update bounced (${message.toEmail})`
            : `Client marked an update as spam (${message.toEmail})`,
        detail:
          'The client did not receive this update. Confirm the address on file and resend, ' +
          'or contact them another way.',
      });

      await audit({
        action: AUDIT_ACTIONS.MESSAGE_BOUNCED,
        entityType: 'message',
        entityId: message.id,
        matterId: message.matterId,
        metadata: { eventType: params.event },
      });

      return { handled: true, note: 'bounce recorded and escalated' };
    }

    case 'email.delivery_delayed':
      await db.update(messages).set({ error: 'delayed' }).where(eq(messages.id, message.id));
      return { handled: true, note: 'delay noted' };

    default:
      return { handled: false, note: 'ignored event type' };
  }
}
