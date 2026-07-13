/**
 * app/lib/policy-generator.server.ts
 *
 * AI-powered policy generation using Anthropic's Claude API.
 * Generates Shopify-compatible store policies (refund, shipping, privacy, terms)
 * based on shop metadata. Pro-tier feature only.
 *
 * Requires ANTHROPIC_API_KEY environment variable.
 */

import type AnthropicClient from "@anthropic-ai/sdk";
import sanitizeHtml from "sanitize-html";
import type { ShopInfo } from "./shopify-api.server";
import { sentry } from "./sentry.server";
import { normalizeDashes } from "./text-normalize";

// Lazily import + construct the Anthropic client on first use. A static
// top-level import pulls the sizeable @anthropic-ai/sdk into the single server
// bundle's cold-start evaluation for EVERY route; deferring it keeps that cost
// off cold starts that never generate a policy (a paid, rare path). The
// `import type` above is erased at build time, so it adds no runtime cost.
let clientPromise: Promise<AnthropicClient> | null = null;
function getAnthropicClient(): Promise<AnthropicClient> {
  if (!clientPromise) {
    clientPromise = import("@anthropic-ai/sdk").then(
      ({ default: Anthropic }) => new Anthropic(), // reads ANTHROPIC_API_KEY from env
    );
  }
  return clientPromise;
}

export type PolicyType = "refund" | "shipping" | "privacy" | "terms";

export interface GeneratedPolicy {
  type: PolicyType;
  title: string;
  body: string;
  disclaimer: string;
}

/**
 * Server-resolved facts injected into every policy prompt (v4 quality pass).
 * The model must NOT invent either of these — a fabricated "Last updated" date
 * or a dead support email is itself a GMC misrepresentation risk.
 */
export interface PolicyContext {
  /**
   * Today's date, computed server-side (e.g. "2026-07-12"). The model is told
   * to use this verbatim wherever the policy shows a "Last updated" / effective
   * date, so it can't stamp a training-era date.
   */
  todayIso: string;
  /**
   * A real store contact email resolved server-side
   * (pro_settings.support_email -> merchants.contact_email -> shop email), or
   * null when none is on file. When null the model must emit a bracketed
   * placeholder and NEVER fabricate an address.
   */
  contactEmail: string | null;
}

/** Placeholder the model must use when no real contact email is available. */
export const CONTACT_PLACEHOLDER = "[add your support email]";

/**
 * Resolves the store's REAL contact email for a policy, in precedence order:
 * merchant pro_settings.support_email -> merchants.contact_email -> shop email.
 * Trims and treats blank as absent; returns null when nothing is on file, so
 * the prompt emits CONTACT_PLACEHOLDER instead of the model fabricating one.
 */
export function resolvePolicyContact(
  proSupportEmail: string | null | undefined,
  merchantContactEmail: string | null | undefined,
  shopEmail: string | null | undefined,
): string | null {
  const pick = (v: string | null | undefined): string | null => {
    const t = typeof v === "string" ? v.trim() : "";
    return t.length > 0 ? t : null;
  };
  return pick(proSupportEmail) ?? pick(merchantContactEmail) ?? pick(shopEmail);
}

const POLICY_TITLES: Record<PolicyType, string> = {
  refund: "Refund and Return Policy",
  shipping: "Shipping Policy",
  privacy: "Privacy Policy",
  terms: "Terms of Service",
};

const POLICY_INSTRUCTIONS: Record<PolicyType, string> = {
  refund: [
    "Generate a Refund and Return Policy. This document must cover:",
    "- Return window (e.g. 30 days from delivery)",
    "- Condition requirements for returns (unused, original packaging, tags attached)",
    "- Refund method (original payment method, store credit, or exchange)",
    "- Non-returnable items and exceptions",
    "- Process for initiating a return",
    "- Refund processing timeline",
  ].join("\n"),
  shipping: [
    "Generate a Shipping Policy. This document must cover:",
    "- Delivery timeframes for domestic and international orders",
    "- Shipping costs and free shipping thresholds (if any)",
    "- Available shipping methods",
    "- Order processing time",
    "- Tracking information",
    "- International shipping restrictions (if any)",
  ].join("\n"),
  privacy: [
    "Generate a Privacy Policy. This document must cover:",
    "- What personal data is collected and how",
    "- How personal data is used",
    "- Third-party services that receive data",
    "- Cookie policy",
    "- Data retention practices",
    "- Customer rights regarding their data",
    "- Contact information for privacy inquiries",
  ].join("\n"),
  terms: [
    "Generate Terms of Service. This document must cover:",
    "- Overview of the agreement between the store and customer",
    "- Account terms and responsibilities",
    "- Product descriptions and pricing accuracy",
    "- Payment terms",
    "- Intellectual property rights",
    "- Limitation of liability",
    "- Governing law and dispute resolution",
    "- Changes to terms",
  ].join("\n"),
};

/**
 * De-emphasis instruction for the defensive international / customs framing the
 * model tends to over-produce (2026-07-13). Applied to the shipping, refund, and
 * terms prompts only, NOT privacy.
 *
 * CRITICAL: this SOFTENS the framing, it does not switch the policy to
 * domestic-only. The app does not know the store's shipping regions at prompt
 * time (ShopInfo carries no ship-to data), so the model must never assert a
 * domestic-only scope. A false "we ship only within <country>" claim is itself a
 * GMC misrepresentation for a store that actually ships worldwide.
 */
export const INTERNATIONAL_FRAMING_RULE: string = [
  "International framing (applies to this policy):",
  '- Write for a store that may ship both domestically and internationally. Do NOT state or imply the store ships only within one country, and do NOT add a "domestic orders only" scope. A false domestic-only claim is itself a misrepresentation for a store that ships worldwide.',
  "- If a store Country is shown above, it is the store's registration country, not a statement of where the store ships. Never treat it as evidence the store ships domestically only.",
  "- Where the store ships internationally, keep that coverage accurate and present: delivery times, available methods, and a brief, factual note that customs duties or import taxes may apply.",
  "- Do NOT lead with defensive international disclaimers and do NOT over-stress them. Do NOT open the policy, or its shipping or returns section, with customs-duties-are-the-customer's-responsibility language, with sanctions / embargo / denied-party clauses, or with a restocking fee charged when a customer refuses a delivery over customs. Keep any such terms short, neutral, and placed after the core terms, never as the headline.",
].join("\n");

/** Policy types that receive the softened international-framing rule above. */
const INTERNATIONAL_FRAMING_TYPES: ReadonlySet<PolicyType> =
  new Set<PolicyType>(["shipping", "refund", "terms"]);

/**
 * Builds the system prompt for a policy generation. Pure + exported so the
 * date/contact grounding can be unit-tested without an Anthropic call.
 */
export function buildPolicySystemPrompt(
  type: PolicyType,
  shopInfo: ShopInfo,
  context: PolicyContext,
  extraInstruction?: string,
): string {
  const contactRule = context.contactEmail
    ? `The store's only contact email is ${context.contactEmail}. Use ONLY this address anywhere the policy references a support/contact email. Do NOT invent, guess, or derive any other email address, domain, phone number, or mailing address.`
    : `No store contact email is on file. Wherever the policy needs a support/contact email, insert the literal placeholder "${CONTACT_PLACEHOLDER}" for the merchant to fill in. Do NOT invent, guess, or derive an email address, domain, phone number, or mailing address — a fabricated contact is itself a compliance risk.`;

  return [
    `You are a policy writer for e-commerce stores. You are writing a ${POLICY_TITLES[type]} for a Shopify store.`,
    "",
    `Store name: ${shopInfo.name}`,
    `Currency: ${shopInfo.currencyCode}`,
    shopInfo.billingAddress?.country
      ? `Country: ${shopInfo.billingAddress.country}`
      : "",
    "",
    POLICY_INSTRUCTIONS[type],
    "",
    INTERNATIONAL_FRAMING_TYPES.has(type) ? INTERNATIONAL_FRAMING_RULE : null,
    INTERNATIONAL_FRAMING_TYPES.has(type) ? "" : null,
    "Grounding rules (these override formatting preferences):",
    `- Today's date is ${context.todayIso}. Wherever the policy shows a "Last updated" or effective date, use EXACTLY this date. Do NOT use any other date, and do NOT rely on your training data for the current date.`,
    `- ${contactRule}`,
    "",
    "Format requirements:",
    "- Output valid HTML suitable for Shopify's legal policy editor",
    "- Output ONLY the raw HTML — do NOT wrap it in a Markdown code fence (no ```html)",
    "- Use <h2>, <p>, <ul>, <li> tags for structure",
    "- Do NOT use em dashes (—) or en dashes (–). Use commas, periods, or parentheses to separate clauses, and a plain hyphen (-) for ranges (e.g. 1-3 business days)",
    `- Be specific and substantive, no placeholder text, except the contact placeholder "${CONTACT_PLACEHOLDER}" when and only when no contact email is on file`,
    "- Include all sections that Google Merchant Center expects for compliance",
    "- Use the store name and currency throughout",
    "- Write in clear, professional English",
    "- Do NOT include <html>, <head>, or <body> tags — just the policy content",
    `- The document title must be "${POLICY_TITLES[type]}"`,
    extraInstruction ? "" : null,
    extraInstruction ? `IMPORTANT: ${extraInstruction}` : null,
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

/** Strips a leading/trailing Markdown code fence the model sometimes adds. */
export function stripCodeFence(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, "");
  t = t.replace(/\n?```\s*$/, "");
  return t.trim();
}

/**
 * Generates a Shopify-compatible store policy using Claude.
 *
 * The generated policy is returned as plain HTML suitable for pasting into
 * Shopify's legal policy editor. Includes a disclaimer that must be shown
 * alongside the generated content.
 */
export async function generatePolicy(
  type: PolicyType,
  shopInfo: ShopInfo,
  context: PolicyContext,
  /**
   * Optional extra instruction appended to the system prompt. Used by the
   * self-consistency validator retry path (v4 §5) to nudge the model to
   * include specific content signals it missed on the first pass —
   * e.g. "MUST explicitly state: return window, item condition".
   */
  extraInstruction?: string,
): Promise<GeneratedPolicy> {
  const systemPrompt = buildPolicySystemPrompt(
    type,
    shopInfo,
    context,
    extraInstruction,
  );

  const message = await (await getAnthropicClient()).messages
    .create({
      // max_tokens raised from 2048 -> 8192: a full ToS/refund policy overran
      // 2048 and ended mid-sentence in production. The AI cap counts generations,
      // not tokens, so the larger ceiling costs the merchant nothing extra.
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: `Generate a complete ${POLICY_TITLES[type]} for my Shopify store "${shopInfo.name}".`,
        },
      ],
      system: systemPrompt,
    })
    .catch((err: unknown) => {
      // Report Anthropic API failures to Sentry from the source. The route-level
      // catch only turns a throw into a 500 for the merchant, so without this a
      // model-not-found 404 (message contains "not_found_error" + "model:", the
      // SHIELDKIT-1 class) never reaches Sentry and the model-not-found alert has
      // nothing to match. Re-throw so the caller's existing handling is unchanged.
      sentry.captureException(err, {
        tags: { area: "policy-generator", policy_type: type },
      });
      throw err;
    });

  // A truncated policy is a real merchant-facing defect (mid-sentence cutoff),
  // so surface it. Non-fatal — the partial policy is still returned; the
  // merchant reviews before publishing.
  if (message.stop_reason === "max_tokens") {
    sentry.captureMessage(
      `Policy generation hit max_tokens for type=${type}`,
      "warning",
      { tags: { area: "policy-generator", policy_type: type } },
    );
  }

  // Extract the text content from the response
  const textBlock = message.content.find((block) => block.type === "text");
  const rawBody = stripCodeFence(textBlock?.text ?? "");
  // Defense-in-depth: sanitize at the source before the HTML is stored.
  // Use sanitize-html (pure JS, no jsdom) instead of DOMPurify on the server.
  // Vercel's Rust-based Node runtime doesn't support require()-ing ESM modules,
  // and jsdom's transitive dep tree triggers that error chain. The client still
  // runs DOMPurify before rendering as a second layer.
  // normalizeDashes strips em/en dashes the model uses despite the prompt rule.
  const body = normalizeDashes(
    sanitizeHtml(rawBody, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(["h1", "h2"]),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        "*": ["class", "id"],
      },
    }),
  );

  return {
    type,
    title: POLICY_TITLES[type],
    body,
    disclaimer:
      "AI-generated. Review before publishing. This is not legal advice.",
  };
}
