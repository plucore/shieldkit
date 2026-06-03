/**
 * app/lib/llm/appeal-letter.server.ts
 *
 * Generates a polished GMC re-review request letter via Claude Sonnet.
 * Mirrors the auth + model + extraction pattern from policy-generator.server.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ShopInfo } from "../shopify-api.server";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

export interface AppealLetterInput {
  shopInfo: ShopInfo;
  suspensionReason: string;
  fixesMade: string;
}

export async function generateAppealLetter(
  input: AppealLetterInput,
): Promise<string> {
  const { shopInfo, suspensionReason, fixesMade } = input;

  const systemPrompt = [
    "You are a customer-success writer drafting a Google Merchant Center re-review request letter on behalf of a Shopify store owner.",
    "",
    `Store name: ${shopInfo.name}`,
    shopInfo.billingAddress?.country
      ? `Country: ${shopInfo.billingAddress.country}`
      : "",
    "",
    "Tone: factual, specific, and concise. Acknowledge the suspension reason directly without excuses, state the specific fixes the merchant has made, and politely request a re-review.",
    "",
    "STRICT GROUNDING RULES — these override every other instruction. This is a Misrepresentation appeal: claiming an on-site fix that is not actually present manufactures a fresh misrepresentation inside the appeal itself, which is worse than saying nothing.",
    "1. Reference ONLY the fixes the merchant explicitly listed in their input below. NEVER invent, infer, embellish, or add a fix the merchant did not state. Do NOT add customer testimonials, reviews, trust badges or other trust signals, 'About' or other page copy, product descriptions, navigation or design changes, or any other on-site change that is not in the merchant's list. If the list is short, the letter is short.",
    "2. For each listed fix that lives at a URL (for example a refund, shipping, privacy, or terms policy page, or a contact or about page), insert a bracketed placeholder the merchant can replace with the real link, e.g. '[paste the link to your refund policy]' or '[paste the link to your contact page]'. Reviewers verify links, so never fabricate, guess, or omit the link — always leave the placeholder.",
    "3. Do NOT add persuasion filler. Do NOT cite how long the business has operated ('operated successfully for X months/years', 'long-standing'). Do NOT use vague trust language ('highest standards', 'committed to trust', 'we take compliance seriously', 'valued customers'). Every sentence must carry a concrete, verifiable fact.",
    "4. Ground the entire letter in exactly these things and nothing else: what happened (the account was suspended), the stated suspension reason / the exact notice text Google provided (quote or paraphrase it faithfully, do not soften or reinterpret it), and the merchant's listed fixes. If you lack information for something, omit it — never fill the gap with invented detail.",
    "",
    "Format: 200–400 words. Plain text only — no markdown, no bullet syntax (•, -, *), no HTML.",
    "Use prose paragraphs. Address the letter to 'Google Merchant Center Review Team'.",
    "Sign off with the store name only — do NOT invent a person's name.",
    "",
    "Do not promise specific outcomes; do not threaten escalation; do not reference Google's policies you are not certain apply. Stick strictly to the facts the merchant supplied.",
  ]
    .filter(Boolean)
    .join("\n");

  const userMessage = [
    `My Google Merchant Center account for "${shopInfo.name}" was suspended.`,
    "",
    "Suspension reason / notice text exactly as stated by Google:",
    suspensionReason.trim(),
    "",
    "Fixes I have made since the suspension (use ONLY these — do not add any fix I did not write):",
    fixesMade.trim(),
    "",
    "Please draft my re-review request letter. Use only the fixes listed above; do not invent or embellish any others. For any fix that points to a page on my store, leave a bracketed placeholder such as \"[paste the link to your refund policy]\" for me to fill in. Do not mention how long my business has operated and do not add generic trust statements.",
  ].join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  return textBlock?.text?.trim() ?? "";
}
