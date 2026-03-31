/**
 * app/utils/email-templates/welcome.ts
 *
 * HTML template for the welcome email sent after a merchant's first scan.
 */

export function buildWelcomeHtml(shopName: string): string {
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
                \u{1F6E1}&nbsp; ShieldKit
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
