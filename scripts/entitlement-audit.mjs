/**
 * READ-ONLY entitlement audit. Writes nothing to Supabase or Shopify.
 *
 * Reconciles every merchants row against the Shopify Partner API's complete
 * app-event history, and reports mismatches in both directions.
 *
 * Method: an app subscription's CURRENT state is the latest event for its
 * charge id. ACTIVATED/UNFROZEN => active, FROZEN => frozen,
 * CANCELED/EXPIRED/DECLINED => terminal. A shop is "paying" if it has at least
 * one charge whose latest event is active AND amount > 0 AND test == false.
 */
import { readFileSync } from "node:fs";

const ENV = {};
for (const line of readFileSync("/Users/am/Projects/SK/shield-kit/.env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const PARTNER_URL = `https://partners.shopify.com/${ENV.SHOPIFY_PARTNER_ORG_ID}/api/2026-04/graphql.json`;
const APP_GID = `gid://partners/App/${ENV.SHOPIFY_PARTNER_APP_ID}`;

const EVENT_TYPES = [
  "SUBSCRIPTION_CHARGE_ACTIVATED", "SUBSCRIPTION_CHARGE_ACCEPTED",
  "SUBSCRIPTION_CHARGE_CANCELED", "SUBSCRIPTION_CHARGE_DECLINED",
  "SUBSCRIPTION_CHARGE_EXPIRED", "SUBSCRIPTION_CHARGE_FROZEN",
  "SUBSCRIPTION_CHARGE_UNFROZEN",
];
const STATE = {
  SUBSCRIPTION_CHARGE_ACTIVATED: "active",
  SUBSCRIPTION_CHARGE_UNFROZEN: "active",
  SUBSCRIPTION_CHARGE_ACCEPTED: "pending",
  SUBSCRIPTION_CHARGE_FROZEN: "frozen",
  SUBSCRIPTION_CHARGE_CANCELED: "cancelled",
  SUBSCRIPTION_CHARGE_DECLINED: "declined",
  SUBSCRIPTION_CHARGE_EXPIRED: "expired",
};

async function partner(query, variables) {
  const res = await fetch(PARTNER_URL, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": ENV.SHOPIFY_PARTNER_API_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error("Partner API: " + JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}

// Paginate so we cannot silently truncate history.
const events = [];
let cursor = null;
for (;;) {
  const d = await partner(
    `query($appId:ID!,$types:[AppEventTypes!]!,$first:Int!,$after:String){
       app(id:$appId){ events(first:$first,types:$types,after:$after){
         pageInfo{hasNextPage} edges{cursor node{ type occurredAt shop{myshopifyDomain}
           ... on AppSubscriptionEvent{ charge{ id name test amount{amount currencyCode} } } }}}}}`,
    { appId: APP_GID, types: EVENT_TYPES, first: 100, after: cursor },
  );
  const conn = d.app.events;
  for (const e of conn.edges) { events.push(e.node); cursor = e.cursor; }
  if (!conn.pageInfo.hasNextPage) break;
}

// Latest event wins per charge id.
const charges = new Map();
for (const e of events) {
  const c = e.charge;
  if (!c) continue;
  const id = String(c.id).split("/").pop();
  const prev = charges.get(id);
  if (!prev || e.occurredAt > prev.occurredAt) {
    charges.set(id, {
      id, shop: e.shop?.myshopifyDomain ?? "(unknown)", name: c.name,
      amount: Number(c.amount?.amount ?? 0), currency: c.amount?.currencyCode,
      test: c.test === true, occurredAt: e.occurredAt, state: STATE[e.type] ?? e.type,
    });
  }
}

// Roll up to shop level.
const shops = new Map();
for (const c of charges.values()) {
  if (!shops.has(c.shop)) shops.set(c.shop, []);
  shops.get(c.shop).push(c);
}

async function sb(path) {
  const res = await fetch(`${ENV.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: ENV.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  return res.json();
}
const merchants = await sb("merchants?select=shopify_domain,tier,shopify_subscription_id,billing_cycle,subscription_started_at,scans_remaining,scans_reset_at,created_at,uninstalled_at&order=created_at");
const byDomain = new Map(merchants.map((m) => [m.shopify_domain, m]));
const PAID_TIERS = new Set(["monitoring", "recovery", "pro"]);

const rows = [];
const allDomains = new Set([...byDomain.keys(), ...shops.keys()]);
for (const domain of allDomains) {
  const m = byDomain.get(domain);
  const cs = (shops.get(domain) ?? []).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const livePaid = cs.filter((c) => c.state === "active" && c.amount > 0 && !c.test);
  const frozenPaid = cs.filter((c) => c.state === "frozen" && c.amount > 0 && !c.test);
  const testActive = cs.filter((c) => c.state === "active" && c.test);
  const shopifySays = livePaid.length ? "PAYING" : frozenPaid.length ? "FROZEN" : testActive.length ? "TEST" : cs.length ? "not-paying" : "no-events";
  const ourTier = m ? m.tier : "(row deleted)";
  const weSay = m ? (PAID_TIERS.has(m.tier) ? "entitled" : "not-entitled") : "(row deleted)";

  let verdict = "ok";
  if (shopifySays === "PAYING" && weSay === "not-entitled") verdict = "*** PAYING BUT NOT ENTITLED ***";
  else if (shopifySays === "PAYING" && weSay === "(row deleted)") verdict = "PAYING BUT ROW DELETED";
  else if (weSay === "entitled" && shopifySays !== "PAYING") verdict = shopifySays === "TEST" ? "entitled on a TEST charge" : "ENTITLED BUT NOT PAYING";
  else if (shopifySays === "FROZEN" && weSay === "not-entitled") verdict = "frozen (not restorable yet)";

  const top = livePaid[0] ?? frozenPaid[0] ?? cs[0];
  rows.push({
    domain, verdict, shopifySays, ourTier,
    liveCharge: top ? `${top.id} ${top.name} ${top.amount}${top.currency ?? ""}${top.test ? " TEST" : ""} [${top.state}]` : "-",
    storedSubId: m?.shopify_subscription_id ? String(m.shopify_subscription_id).split("/").pop() : null,
    idAgrees: top && m?.shopify_subscription_id ? (String(m.shopify_subscription_id).split("/").pop() === top.id ? "yes" : "NO") : "-",
    nEvents: cs.length,
  });
}

const order = (v) => v.startsWith("***") ? 0 : v.startsWith("PAYING") ? 1 : v.startsWith("ENTITLED") ? 2 : v.startsWith("entitled on") ? 3 : v.startsWith("frozen") ? 4 : 5;
rows.sort((a, b) => order(a.verdict) - order(b.verdict) || a.domain.localeCompare(b.domain));

// --json: machine-readable summary for scripts/weekly-health.sh. Exit code is
// 1 when a PAYING merchant is unentitled, so a caller can alert on status alone.
if (process.argv.includes("--json")) {
  const payingNotEntitled = rows.filter((r) => r.verdict.startsWith("***") || r.verdict === "PAYING BUT ROW DELETED");
  const entitledNotPaying = rows.filter((r) => r.verdict === "ENTITLED BUT NOT PAYING");
  const frozen = rows.filter((r) => r.verdict.startsWith("frozen"));
  console.log(JSON.stringify({
    merchants: merchants.length,
    events: events.length,
    paying_not_entitled: payingNotEntitled.map((r) => ({ shop: r.domain, charge: r.liveCharge })),
    entitled_not_paying: entitledNotPaying.map((r) => ({ shop: r.domain, tier: r.ourTier, charge: r.liveCharge })),
    frozen: frozen.map((r) => ({ shop: r.domain, charge: r.liveCharge })),
    test_charge_entitled: rows.filter((r) => r.verdict === "entitled on a TEST charge").map((r) => r.domain),
    shops_paid_ever: [...new Set([...charges.values()].filter((c) => c.amount > 0 && !c.test).map((c) => c.shop))].length,
  }, null, 2));
  process.exit(payingNotEntitled.length > 0 ? 1 : 0);
}

console.log(`Partner API events fetched: ${events.length} | distinct charges: ${charges.size} | shops with events: ${shops.size}`);
console.log(`merchants rows: ${merchants.length}\n`);
console.log("=== MISMATCHES AND NOTABLES ===\n");
console.log(`${"shop".padEnd(30)} ${"verdict".padEnd(32)} ${"shopify".padEnd(12)} ${"ourTier".padEnd(13)} ${"id?".padEnd(4)} live charge`);
let clean = 0;
for (const r of rows) {
  if (r.verdict === "ok") { clean++; continue; }
  console.log(`${r.domain.slice(0,29).padEnd(30)} ${r.verdict.padEnd(32)} ${r.shopifySays.padEnd(12)} ${r.ourTier.padEnd(13)} ${String(r.idAgrees).padEnd(4)} ${r.liveCharge}`);
}
console.log(`\n${clean} rows agree (free in both systems, or correctly terminal).`);

const paidEver = [...charges.values()].filter((c) => c.amount > 0 && !c.test);
const shopsPaidEver = new Set(paidEver.map((c) => c.shop));
console.log(`\nDistinct shops with a REAL (non-test) paid subscription charge, ever: ${shopsPaidEver.size}`);
console.log("  " + [...shopsPaidEver].sort().join("\n  "));
