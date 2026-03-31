/**
 * app/utils/email.server.ts
 *
 * Server-side email utilities powered by Resend.
 * NEVER import this file in client-side code — it references process.env
 * and the Resend SDK which must only run on the server.
 */

import { Resend } from "resend";
import { buildWelcomeHtml } from "./email-templates/welcome";
import { buildComplianceAlertHtml } from "./email-templates/compliance-alert";

// Singleton — initialised once at module load, safe on the server.
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendWelcomeEmail(
  email: string,
  shopName: string,
): Promise<void> {
  await resend.emails.send({
    from: "ShieldKit <am@plucore.com>",
    to: email,
    subject: "Your ShieldKit Scan Results Are Ready",
    html: buildWelcomeHtml(shopName),
  });
}

export async function sendComplianceAlertEmail(
  email: string,
  shopName: string,
  oldScore: number,
  newScore: number,
  newIssues: Array<{ check_name: string; severity: string; title: string }>,
): Promise<void> {
  await resend.emails.send({
    from: "ShieldKit <am@plucore.com>",
    to: email,
    subject: "ShieldKit Alert: Your compliance score dropped",
    html: buildComplianceAlertHtml(shopName, oldScore, newScore, newIssues),
  });
}
