/**
 * REGRESSION: the public /scan funnel must never report a policy as MISSING
 * because the fetch for it FAILED.
 *
 * This is the §11a defect, on the surface §11a was written about — the first
 * number a prospect ever sees about their own store. It shipped because the
 * degrade gate for the two-page privacy_and_terms check used `&&`:
 *
 *     privacyFetch.availability === "unavailable"
 *  && termsFetch.availability   === "unavailable"
 *
 * justified in a comment by "either one alone is enough for the check to render
 * a real verdict". That is false: `privacyPresent` is derived from the PRIVACY
 * fetch specifically, so a readable terms page says nothing about whether a
 * privacy policy exists. With `&&`, the single most likely failure — one page
 * throttled, the other fine — left the check un-degraded and it emitted
 * CRITICAL "Missing Privacy Policy" from a fetch that never landed.
 *
 * These are BEHAVIOURAL tests: they execute runPublicScan against a stubbed
 * network. The whole suite passed while the bug was live, because every
 * assertion about this file was a regex over its source text.
 *
 * The second test is the one that stops an over-correction: a real 404 MUST
 * still produce the CRITICAL. Degrading everything would be just as wrong.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:dns/promises", () => ({
  default: { lookup: async () => [{ address: "93.184.216.34" }] },
  lookup: async () => [{ address: "93.184.216.34" }],
}));

const PRIVACY_BODY =
  "<html><body><h1>Privacy Policy</h1><p>We collect your data and process it lawfully under GDPR.</p></body></html>";
const TERMS_BODY =
  "<html><body><h1>Terms of Service</h1><p>These terms govern your use of the store.</p></body></html>";
const GENERIC = "<html><body><p>Shop</p></body></html>";

/**
 * @param privacyStatus HTTP status the privacy policy URL should answer with.
 *                      503 = "we could not look"; 404 = "genuinely absent".
 */
function stubNetwork(privacyStatus: number) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    const reply = (status: number, body: string) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    });
    if (url.includes("/policies/privacy-policy")) {
      return reply(privacyStatus, privacyStatus === 200 ? PRIVACY_BODY : "");
    }
    if (url.includes("/policies/terms-of-service")) return reply(200, TERMS_BODY);
    if (url.includes("/policies/")) return reply(200, GENERIC);
    if (url.includes("products.json")) return reply(200, JSON.stringify({ products: [] }));
    if (url.includes("googleapis.com")) return reply(500, "{}");
    return reply(200, GENERIC);
  });
}

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function scanWithPrivacyStatus(status: number) {
  globalThis.fetch = stubNetwork(status) as unknown as typeof globalThis.fetch;
  const { runPublicScan } = await import("../app/lib/checks/public-scanner.server");
  const res = await runPublicScan("https://example.com");
  if (!res.ok) throw new Error(`scan failed: ${res.error}`);
  const check = res.results.find((r) => r.check_name === "privacy_and_terms");
  if (!check) throw new Error("privacy_and_terms check missing from results");
  return { res, check };
}

describe("public /scan — privacy policy fabrication", () => {
  it("does NOT report a missing privacy policy when the privacy page is rate-limited (503)", async () => {
    const { check } = await scanWithPrivacyStatus(503);

    // The exact fabricated output this guards against.
    expect(check.severity).not.toBe("critical");
    expect(check.title).not.toMatch(/Missing Privacy Policy/i);

    // It must be reported as unverifiable and excluded from the score.
    expect(check.passed).toBe(true);
    expect(check.scorable).toBe(false);
    expect(check.title).toMatch(/Not Checked/i);
    expect(check.raw_data).toMatchObject({ degraded: true });
  });

  it("a 503 on the privacy page does not inflate the prospect's critical count", async () => {
    const { res } = await scanWithPrivacyStatus(503);
    const fabricated = res.results.filter(
      (r) => r.severity === "critical" && /privacy/i.test(r.title),
    );
    expect(fabricated).toEqual([]);
    // Asserted as an explicit list rather than a snapshot: a snapshot invites a
    // blind `vitest -u`, which is precisely how a fabricated critical would get
    // re-blessed. "Incomplete Refund Policy" is a REAL finding from this fixture
    // (the refund page returns 200 with no return window / condition / method),
    // so it is expected. A privacy-shaped title appearing here is the bug back.
    const criticalTitles = res.results
      .filter((r) => r.severity === "critical")
      .map((r) => r.title)
      .sort();
    expect(criticalTitles).toEqual(["Incomplete Refund Policy"]);
  });

  it("STILL reports a genuinely missing privacy policy (404) as critical", async () => {
    // The over-correction guard. `absent` is a real finding and must survive:
    // degrading every non-200 would hide true failures just as badly.
    const { check } = await scanWithPrivacyStatus(404);
    expect(check.severity).toBe("critical");
    expect(check.title).toMatch(/Missing Privacy Policy/i);
    expect(check.scorable).not.toBe(false);
  });

  it("passes cleanly when both policy pages are readable", async () => {
    const { check } = await scanWithPrivacyStatus(200);
    expect(check.passed).toBe(true);
    expect(check.severity).toBe("info");
  });
});
