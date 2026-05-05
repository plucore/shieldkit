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
    "Tone: empathetic but professional. Acknowledge the suspension reason directly without excuses, list the specific fixes the merchant has made, and politely request a re-review.",
    "",
    "Format: 200–400 words. Plain text only — no markdown, no bullet syntax (•, -, *), no HTML.",
    "Use prose paragraphs. Address the letter to 'Google Merchant Center Review Team'.",
    "Sign off with the store name only — do NOT invent a person's name.",
    "",
    "Do not promise specific outcomes; do not threaten escalation; do not reference Google's policies you are not certain apply. Stick to the facts the merchant supplied.",
  ]
    .filter(Boolean)
    .join("\n");

  const userMessage = [
    `My Google Merchant Center account for "${shopInfo.name}" was suspended.`,
    "",
    "Suspension reason as stated by Google:",
    suspensionReason.trim(),
    "",
    "Fixes I have made since the suspension:",
    fixesMade.trim(),
    "",
    "Please draft my re-review request letter.",
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
