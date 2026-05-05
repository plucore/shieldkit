/**
 * app/lib/emails/weekly-digest.ts
 *
 * Plain-HTML weekly digest renderer. Returns a string suitable for the
 * Resend `html` parameter. Inline styles only — Gmail/Outlook strip <style>
 * blocks. Includes a Shield Max ("Pro This Week") section that renders only
 * when tier='pro'; Phase 5 fills it in with real data, this scaffold gates
 * it so adding content later doesn't require touching the digest pipeline.
 */

// HTML-escape helper. We intentionally don't use querystring.escape — it
// URL-escapes, not HTML-escapes.
function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface IssueChange {
  check_name: string;
  title: string;
}

export interface WeeklyDigestData {
  shopName: string;
  shopDomain: string;
  appUrl: string;
  tier: "shield" | "pro";
  scoreThisWeek: number | null;
  scorePreviousWeek: number | null;
  newIssues: IssueChange[];
  fixesConfirmed: IssueChange[];
  paymentIconHealthy: boolean;
  customerPrivacyApiWired: boolean | null; // null = not yet measured
  /**
   * Phase 5 "Shield Max — This Week" payload. Optional — when undefined the
   * Pro section falls back to the Phase 3.3 placeholder copy.
   */
  proThisWeek?: {
    productsEnrichedCount: number;
    productsWithFullSchema: number;
    totalProducts: number;
    llmsTxtRefreshedAt: string | null; // ISO
    aiReadinessScore: number; // 0-100
  };
}

export function renderWeeklyDigest(data: WeeklyDigestData): string {
  const {
    shopName,
    shopDomain,
    appUrl,
    tier,
    scoreThisWeek,
    scorePreviousWeek,
    newIssues,
    fixesConfirmed,
    paymentIconHealthy,
    customerPrivacyApiWired,
  } = data;

  const scoreLine =
    scoreThisWeek === null
      ? "Score: <em>no scan completed yet</em>"
      : scorePreviousWeek === null
        ? `Score this week: <strong>${esc(scoreThisWeek)}%</strong>`
        : `Score: <strong>${esc(scorePreviousWeek)}% → ${esc(scoreThisWeek)}%</strong>`;

  const newIssuesBlock =
    newIssues.length === 0
      ? `<p style="margin:0 0 12px;color:#1a9e5c;"><strong>✓ No new issues caught this week.</strong></p>`
      : `<p style="margin:0 0 8px;font-weight:600;">${newIssues.length} new issue${newIssues.length === 1 ? "" : "s"} caught:</p>
         <ul style="margin:0 0 16px 20px;padding:0;color:#303030;line-height:1.6;">
           ${newIssues.map((i) => `<li>${esc(i.title)}</li>`).join("")}
         </ul>`;

  const fixesBlock =
    fixesConfirmed.length === 0
      ? ""
      : `<p style="margin:0 0 8px;font-weight:600;color:#1a9e5c;">${fixesConfirmed.length} fix${fixesConfirmed.length === 1 ? "" : "es"} confirmed:</p>
         <ul style="margin:0 0 16px 20px;padding:0;color:#303030;line-height:1.6;">
           ${fixesConfirmed.map((i) => `<li>${esc(i.title)}</li>`).join("")}
         </ul>`;

  const paymentRow = paymentIconHealthy
    ? `<li style="margin:6px 0;">✓ Payment icons healthy on storefront</li>`
    : `<li style="margin:6px 0;color:#e51c00;">✗ Payment icons missing — Google Merchant Center expects these</li>`;

  const privacyRow =
    customerPrivacyApiWired === null
      ? `<li style="margin:6px 0;color:#6d7175;">— Customer Privacy API: not yet measured</li>`
      : customerPrivacyApiWired
        ? `<li style="margin:6px 0;">✓ Customer Privacy API wired</li>`
        : `<li style="margin:6px 0;color:#e51c00;">✗ Customer Privacy API not detected</li>`;

  let proSection = "";
  if (tier === "pro") {
    if (data.proThisWeek) {
      const p = data.proThisWeek;
      const refreshedLabel = p.llmsTxtRefreshedAt
        ? new Date(p.llmsTxtRefreshedAt).toISOString().slice(0, 10)
        : "not yet generated";
      const schemaPct =
        p.totalProducts > 0
          ? Math.round((p.productsWithFullSchema / p.totalProducts) * 100)
          : 0;
      proSection = `<div style="margin-top:24px;padding:16px;background:#f6f6f7;border-radius:8px;">
           <p style="margin:0 0 12px;font-weight:700;color:#0f172a;">Shield Max — This Week</p>
           <ul style="margin:0;padding:0 0 0 20px;line-height:1.7;color:#303030;">
             <li><strong>${esc(p.productsEnrichedCount)}</strong> product${p.productsEnrichedCount === 1 ? "" : "s"} auto-enriched this week</li>
             <li>Full Merchant Listings schema on <strong>${esc(p.productsWithFullSchema)}</strong> of <strong>${esc(p.totalProducts)}</strong> products (${esc(schemaPct)}%)</li>
             <li>llms.txt last refreshed: <strong>${esc(refreshedLabel)}</strong></li>
             <li>AI Readiness Score: <strong>${esc(p.aiReadinessScore)} / 100</strong></li>
           </ul>
         </div>`;
    } else {
      proSection = `<div style="margin-top:24px;padding:16px;background:#f6f6f7;border-radius:8px;">
           <p style="margin:0 0 8px;font-weight:700;color:#0f172a;">Shield Max — This Week</p>
           <p style="margin:0;color:#303030;line-height:1.6;">
             Detailed AI-readiness reporting (auto-enriched products, schema status,
             llms.txt freshness, AI Readiness Score) is preparing — first numbers
             will appear here once the Auto-Filler has run.
           </p>
         </div>`;
    }
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ShieldKit weekly health check</title>
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#303030;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fafafa;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
          <tr>
            <td style="padding:24px 32px;border-bottom:1px solid #e1e3e5;">
              <p style="margin:0;font-size:14px;color:#6d7175;">ShieldKit weekly health check</p>
              <p style="margin:4px 0 0;font-size:20px;font-weight:700;color:#0f172a;">${esc(shopName)}</p>
              <p style="margin:0;font-size:13px;color:#6d7175;">${esc(shopDomain)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;">
              <p style="margin:0 0 16px;font-size:16px;">${scoreLine}</p>
              ${newIssuesBlock}
              ${fixesBlock}
              <p style="margin:16px 0 8px;font-weight:600;">Continuous monitor</p>
              <ul style="margin:0 0 0 20px;padding:0;list-style:none;line-height:1.6;">
                ${paymentRow}
                ${privacyRow}
              </ul>
              ${proSection}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 24px;border-top:1px solid #e1e3e5;">
              <a href="${esc(appUrl)}/app" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:6px;">Open dashboard</a>
              <p style="margin:16px 0 0;font-size:12px;color:#6d7175;">
                You're receiving this because ${esc(shopDomain)} is on a paid ShieldKit plan.
                <br>To stop these emails, cancel your subscription in the app.
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

export function digestSubject(shopName: string): string {
  return `ShieldKit weekly health check — ${shopName}`;
}
