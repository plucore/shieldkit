/**
 * app/lib/emails/send.server.ts
 *
 * Centralised Resend client wrapper. Returns the provider message id on
 * success or { error } on failure — never throws so a single bad address
 * doesn't stop a batch (e.g. weekly-digest cron iterates all paid merchants
 * sequentially and tolerates per-merchant failures).
 *
 * Requires RESEND_API_KEY env var. If missing, every send returns an error
 * — calling code should check `if (!process.env.RESEND_API_KEY)` and skip
 * actual send rather than relying on this function to validate.
 */

import { Resend } from "resend";

const FROM_DEFAULT = "ShieldKit <noreply@shieldkit.app>";

let _resend: Resend | null = null;

function getClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const client = getClient();
  if (!client) {
    return { ok: false, error: "RESEND_API_KEY_NOT_SET" };
  }

  try {
    const res = await client.emails.send({
      from: params.from ?? FROM_DEFAULT,
      to: params.to,
      subject: params.subject,
      html: params.html,
      replyTo: params.replyTo,
    });

    if (res.error) {
      return { ok: false, error: res.error.message ?? String(res.error) };
    }
    return { ok: true, messageId: res.data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
