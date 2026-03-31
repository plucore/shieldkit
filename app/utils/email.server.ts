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

// ─── HTML builder ─────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 80) return "#1a9e5c";
  if (score >= 50) return "#e8820c";
  return "#e51c00";
}

function buildComplianceAlertHtml(
  shopName: string,
  oldScore: number,
  newScore: number,
  newIssues: Array<{ check_name: string; severity: string; title: string }>,
): string {
  const issuesHtml = newIssues.length > 0
    ? `<table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;margin-bottom:24px;">
        ${newIssues.map((issue) => {
          const sevColor = issue.severity === "critical" ? "#e51c00" : "#e8820c";
          const sevLabel = issue.severity.charAt(0).toUpperCase() + issue.severity.slice(1);
          return `<tr>
            <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
              <span style="display:inline-block;padding:2px 8px;border-radius:4px;
                           font-size:11px;font-weight:700;color:#fff;background:${sevColor};
                           text-transform:uppercase;letter-spacing:0.04em;margin-right:8px;">
                ${sevLabel}
              </span>
              <span style="font-size:14px;color:#334155;">${issue.title}</span>
            </td>
          </tr>`;
        }).join("")}
      </table>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ShieldKit Compliance Alert</title>
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
                &#x1f6e1;&nbsp; ShieldKit
              </div>
              <div style="color:#94a3b8;font-size:12px;margin-top:8px;
                          letter-spacing:0.06em;text-transform:uppercase;">
                Weekly Compliance Monitoring
              </div>
            </td>
          </tr>

          <tr>
            <td style="background:#fff4f4;padding:32px 40px;border-bottom:1px solid #e2e8f0;">
              <div style="font-size:24px;font-weight:800;color:#0f172a;
                          line-height:1.3;letter-spacing:-0.02em;">
                Your compliance score dropped
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:36px 40px 32px;">

              <p style="margin:0 0 16px;font-size:16px;color:#334155;line-height:1.6;">
                Hi ${shopName},
              </p>

              <p style="margin:0 0 24px;font-size:16px;color:#334155;line-height:1.6;">
                Our weekly automated scan detected changes in your store's
                Google Merchant Center compliance status.
              </p>

              <table cellpadding="0" cellspacing="0" role="presentation"
                     style="width:100%;margin-bottom:24px;">
                <tr>
                  <td style="text-align:center;padding:20px;background:#f8fafc;
                             border-radius:8px;border:1px solid #e2e8f0;">
                    <div style="font-size:14px;color:#6d7175;margin-bottom:8px;">
                      Compliance Score
                    </div>
                    <div>
                      <span style="font-size:36px;font-weight:800;color:${scoreColor(oldScore)};">
                        ${oldScore}%
                      </span>
                      <span style="font-size:24px;color:#94a3b8;padding:0 12px;">
                        &rarr;
                      </span>
                      <span style="font-size:36px;font-weight:800;color:${scoreColor(newScore)};">
                        ${newScore}%
                      </span>
                    </div>
                  </td>
                </tr>
              </table>

              ${issuesHtml}

              <table cellpadding="0" cellspacing="0" role="presentation"
                     style="width:100%;margin-bottom:32px;">
                <tr>
                  <td align="center"
                      style="background:#2563eb;border-radius:8px;text-align:center;
                             box-shadow:0 4px 12px rgba(37,99,235,0.3);">
                    <a href="https://shieldkit.vercel.app/app"
                       style="display:block;padding:16px 32px;color:#ffffff;
                              font-size:16px;font-weight:600;text-decoration:none;
                              letter-spacing:-0.01em;">
                      View Full Report &rarr;
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <tr>
            <td style="background:#f8fafc;padding:24px 40px;text-align:center;
                        border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
                This is an automated weekly compliance alert for
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
                Your 10-point compliance audit is live.
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
                Upgrade to <strong>Pro ($39/mo)</strong> for unlimited re-scans, AI-powered
                policy generation, and full scan history.
              </p>

              <table cellpadding="0" cellspacing="0" role="presentation"
                     style="width:100%;margin-bottom:32px;">
                <tr>
                  <td align="center"
                      style="background:#2563eb;border-radius:8px;text-align:center;
                             box-shadow:0 4px 12px rgba(37,99,235,0.3);">
                    <a href="https://shieldkit.vercel.app/app"
                       style="display:block;padding:16px 32px;color:#ffffff;
                              font-size:16px;font-weight:600;text-decoration:none;
                              letter-spacing:-0.01em;">
                      View Your Results &rarr;
                    </a>
                  </td>
                </tr>
              </table>

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