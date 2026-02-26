/**
 * app/utils/email.server.ts
 *
 * Server-side email utilities powered by Resend.
 * NEVER import this file in client-side code — it references process.env
 * and the Resend SDK which must only run on the server.
 */

import { Resend } from "resend";

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
    subject:
      "Your ShieldKit Scan Results — and the Guide Google Doesn't Want You to See",
    html: buildWelcomeHtml(shopName),
  });
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildWelcomeHtml(shopName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your ShieldKit Scan Results</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
         style="background:#f1f5f9;padding:40px 16px;">
    <tr>
      <td align="center">

        <table width="600" cellpadding="0" cellspacing="0" role="presentation"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;
                      overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08);">

          <tr>
            <td style="background:#0f172a;padding:32px 40px;text-align:center;">
              <div style="color:#ffffff;font-size:28px;font-weight:800;letter-spacing:-0.02em;">
                🛡&nbsp; ShieldKit
              </div>
              <div style="color:#94a3b8;font-size:12px;margin-top:8px;
                          letter-spacing:0.06em;text-transform:uppercase;">
                Google Merchant Center Compliance
              </div>
            </td>
          </tr>

          <tr>
            <td style="background:#f8fafc;padding:32px 40px;
                        border-bottom:1px solid #e2e8f0;">
              <div style="font-size:24px;font-weight:800;color:#0f172a;
                          line-height:1.3;letter-spacing:-0.02em;">
                Your scan results are in — and we've got something extra for you.
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:36px 40px 32px;">

              <p style="margin:0 0 16px;font-size:16px;color:#334155;line-height:1.6;">
                Hi ${shopName},
              </p>

              <p style="margin:0 0 16px;font-size:16px;color:#334155;line-height:1.6;">
                Your full <strong>10-point GMC compliance audit</strong> is live in your
                Shopify admin dashboard. Every failed check includes a plain-English
                resolution guide — no guesswork, no Google support tickets.
              </p>

              <p style="margin:0 0 32px;font-size:16px;color:#334155;line-height:1.6;">
                As a thank-you for running your first scan, here is your copy of the
                <strong>ShieldKit GMC Survival Guide</strong> — the step-by-step playbook
                for the exact issues that get Shopify stores suspended, written in plain English.
              </p>

              <table cellpadding="0" cellspacing="0" role="presentation"
                     style="width:100%;margin-bottom:32px;">
                <tr>
                  <td align="center"
                      style="background:#334155;border-radius:8px;text-align:center;">
                    <a href="https://drive.google.com/file/d/1o5bII-a8W7oNWgGCSj5JLv9bapTnklsa/view?usp=sharing"
                       style="display:block;padding:16px 32px;color:#ffffff;
                              font-size:16px;font-weight:600;text-decoration:none;
                              letter-spacing:-0.01em;">
                      ⬇&nbsp;&nbsp;Download the GMC Survival Guide
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:15px;color:#64748b;line-height:1.6;">
                The guide covers the 10 most common reasons Google suspends Shopify stores,
                with copy-paste policy templates for each issue. Bookmark it — you'll reach
                for it every time you update your store policies.
              </p>

            </td>
          </tr>

          <tr>
            <td style="padding:0 40px;">
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0;" />
            </td>
          </tr>

          <tr>
            <td style="padding:36px 40px 40px; background:#ffffff;">
              <p style="margin:0 0 12px;font-size:12px;font-weight:800;color:#2563eb;
                         text-transform:uppercase;letter-spacing:0.08em;text-align:center;">
                Fast-Track Your Approval
              </p>
              <p style="margin:0 0 24px;font-size:16px;color:#334155;line-height:1.6;text-align:center;">
                Our <strong>Done-For-You GMC Compliance</strong> service handles every fix —
                policy rewrites, trust-signal updates, and GMC re-submission. We log into your store and fix it so you don't have to.
              </p>
              
              <table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;">
                <tr>
                  <td align="center" style="background:#2563eb;border-radius:8px;text-align:center;box-shadow:0 4px 12px rgba(37,99,235,0.3);">
                    <a href="https://plucoreuser.gumroad.com/l/shieldkit"
                       style="display:block;padding:20px 32px;color:#ffffff;
                              font-size:18px;font-weight:700;text-decoration:none;
                              letter-spacing:-0.01em;">
                      Need it fixed? Get the Done-For-You Service &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-size:14px;color:#64748b;text-align:center;">
                We handle the policies, the code, and the Google appeals. You run your business.
              </p>
            </td>
          </tr>

          <tr>
            <td style="background:#f8fafc;padding:24px 40px;text-align:center;
                        border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
                You received this email because you installed ShieldKit on
                <strong>${shopName}</strong>.<br />
                &copy; 2026 ShieldKit by Plucore. All rights reserved.<br />
                Abu Dhabi, United Arab Emirates
              </p>
              <p style="margin:12px 0 0;font-size:11px;color:#cbd5e1;">
                Don't want these emails? Reply "Unsubscribe" and we'll remove you.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}