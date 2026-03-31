/**
 * app/lib/policy-generator.server.ts
 *
 * AI-powered policy generation using Anthropic's Claude API.
 * Generates Shopify-compatible store policies (refund, shipping, privacy, terms)
 * based on shop metadata. Pro-tier feature only.
 *
 * Requires ANTHROPIC_API_KEY environment variable.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ShopInfo } from "./shopify-api.server";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export type PolicyType = "refund" | "shipping" | "privacy" | "terms";

export interface GeneratedPolicy {
  type: PolicyType;
  title: string;
  body: string;
  disclaimer: string;
}

const POLICY_TITLES: Record<PolicyType, string> = {
  refund: "Refund Policy",
  shipping: "Shipping Policy",
  privacy: "Privacy Policy",
  terms: "Terms of Service",
};

/**
 * Generates a Shopify-compatible store policy using Claude.
 *
 * The generated policy is returned as plain HTML suitable for pasting into
 * Shopify's legal policy editor. Includes a disclaimer that must be shown
 * alongside the generated content.
 */
export async function generatePolicy(
  type: PolicyType,
  shopInfo: ShopInfo
): Promise<GeneratedPolicy> {
  const systemPrompt = [
    `You are a policy writer for e-commerce stores. Generate a ${POLICY_TITLES[type]} for a Shopify store.`,
    `Store name: ${shopInfo.name}`,
    `Currency: ${shopInfo.currencyCode}`,
    shopInfo.billingAddress?.country
      ? `Country: ${shopInfo.billingAddress.country}`
      : "",
    "",
    "Requirements:",
    "- Output valid HTML suitable for Shopify's legal policy editor",
    "- Use <h2>, <p>, <ul>, <li> tags for structure",
    "- Be specific and substantive — no placeholder text",
    "- Include all sections that Google Merchant Center expects for compliance",
    "- Use the store name and currency throughout",
    "- Write in clear, professional English",
    "- Do NOT include <html>, <head>, or <body> tags — just the policy content",
  ]
    .filter(Boolean)
    .join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `Generate a complete ${POLICY_TITLES[type]} for my Shopify store.`,
      },
    ],
    system: systemPrompt,
  });

  // Extract the text content from the response
  const textBlock = message.content.find((block) => block.type === "text");
  const body = textBlock?.text ?? "";

  return {
    type,
    title: POLICY_TITLES[type],
    body,
    disclaimer:
      "AI-generated. Review before publishing. This is not legal advice.",
  };
}
