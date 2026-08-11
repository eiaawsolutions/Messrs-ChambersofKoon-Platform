import 'server-only';
import { config, secret } from '@/lib/config/env';

/**
 * Resend transport (PRD §3.1, FR-7.3, FR-7.7).
 *
 * Called directly over HTTP rather than through the SDK because the .ics
 * attachment needs an exact `content_type` including the `method` parameter —
 * `text/calendar; method=REQUEST`. Without it Gmail renders the invitation as
 * a file attachment instead of an accept/decline card, which is precisely what
 * AT-03 checks.
 *
 * Sender identity is configurable (FR-7.7): EIAAW's verified domain with the
 * firm's display name by default, or the firm's own domain once DNS is in
 * place. Only the address and display name change; nothing else here does.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface EmailAttachment {
  filename: string;
  /** Raw content; encoded to base64 before sending. */
  content: string | Buffer;
  contentType?: string;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  /** Collapses duplicate sends when a job retries. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  id: string;
}

export class EmailSendError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'EmailSendError';
    this.status = status;
    // 4xx other than 429 means the request is wrong; retrying will not fix it.
    this.retryable = status === 429 || status >= 500;
  }
}

export function senderIdentity(): { from: string; replyTo: string | undefined } {
  const cfg = config();
  const name = cfg.RESEND_FROM_NAME.replace(/"/g, '');
  return {
    from: `${name} <${cfg.RESEND_FROM_ADDRESS}>`,
    replyTo: cfg.RESEND_REPLY_TO,
  };
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = await secret('RESEND_API_KEY');
  const identity = senderIdentity();

  const body: Record<string, unknown> = {
    from: identity.from,
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
    text: input.text,
  };

  if (input.html) body.html = input.html;
  const replyTo = input.replyTo ?? identity.replyTo;
  if (replyTo) body.reply_to = replyTo;
  if (input.headers) body.headers = input.headers;

  if (input.attachments?.length) {
    body.attachments = input.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: Buffer.from(attachment.content).toString('base64'),
      ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
    }));
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
  if (input.idempotencyKey) {
    headers['Idempotency-Key'] = input.idempotencyKey;
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { message?: string; name?: string };
      if (payload.message) detail = payload.message;
    } catch {
      // Body was not JSON; the status alone is the signal.
    }
    throw new EmailSendError(detail, response.status);
  }

  const payload = (await response.json()) as { id?: string };
  return { id: payload.id ?? '' };
}

/**
 * Send a calendar invitation (FR-3.6).
 *
 * The `method` parameter on the content type is what makes Gmail, Outlook and
 * Apple Mail render an RSVP card. It must match the METHOD inside the .ics.
 */
export async function sendCalendarInvite(input: {
  to: string[];
  subject: string;
  text: string;
  ics: string;
  method: 'REQUEST' | 'CANCEL';
  idempotencyKey?: string;
}): Promise<SendEmailResult> {
  return sendEmail({
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    attachments: [
      {
        filename: 'invite.ics',
        content: input.ics,
        contentType: `text/calendar; charset=utf-8; method=${input.method}`,
      },
    ],
  });
}

/**
 * Render a message template. Deliberately a simple `{{token}}` substitution
 * rather than a template engine: these bodies are edited by firm staff in the
 * admin console, and an engine with logic in it would be a code-execution
 * surface owned by non-engineers.
 *
 * Unknown tokens are stripped rather than left visible — a client should never
 * receive an email containing a literal `{{lawyerName}}`.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string | null | undefined>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

/** Which tokens a template references — used by the admin preview (FR-9.3). */
export function templateVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Minimal, safe HTML rendering of a plain-text body.
 * Escapes first, then applies paragraph breaks — never the other way round.
 */
export function textToHtml(text: string, firmName: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px 0;">${p.replace(/\n/g, '<br />')}</p>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#fbfaf7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfaf7;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="max-width:560px;background:#ffffff;border:1px solid #e2ded5;border-radius:5px;">
<tr><td style="padding:28px 28px 8px 28px;border-bottom:2px solid #a9772e;">
<span style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#131a24;">
${firmName.replace(/</g, '&lt;')}</span>
</td></tr>
<tr><td style="padding:24px 28px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;
font-size:15px;line-height:1.6;color:#131a24;">
${paragraphs}
</td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;
font-size:12px;line-height:1.5;color:#8d95a1;text-align:left;">
This message relates to a legal matter and may be confidential. If it reached you in error,
please tell us and delete it.
</p>
</td></tr></table>
</body></html>`;
}
