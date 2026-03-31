/**
 * app/lib/checks/helpers.server.ts
 *
 * Utility functions shared by multiple compliance checks.
 */

import dns from "node:dns/promises";
import { PRIVATE_IP_PATTERNS } from "./constants";

/** Strips all HTML tags from a string and collapses whitespace. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Extracts the registrable domain from a hostname (e.g. "store.com" from "www.store.com"). */
export function extractDomain(host: string): string {
  const parts = host.replace(/^https?:\/\//, "").split(".");
  if (parts.length >= 2) return parts.slice(-2).join(".");
  return host;
}

export function isPrivateAddress(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some((re) => re.test(ip));
}

/**
 * Resolves all A/AAAA records for a hostname and rejects any that point to
 * private/loopback/link-local addresses. Returns true if safe to fetch.
 */
export async function isHostSafe(hostname: string): Promise<boolean> {
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        console.warn(
          `[SSRF] Blocked fetch: "${hostname}" resolves to private address ${address}`
        );
        return false;
      }
    }
    return true;
  } catch {
    // DNS resolution failed — treat as unsafe
    return false;
  }
}

/**
 * Fetches a public URL with a configurable timeout.
 * Returns null on network failure or timeout; never throws.
 * Includes SSRF protection via DNS pre-check.
 */
export async function fetchPublicPage(
  url: string,
  timeoutMs = 10_000
): Promise<{ status: number; html: string } | null> {
  try {
    const hostname = new URL(url).hostname;
    if (!(await isHostSafe(hostname))) {
      return null;
    }

    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "ShieldKit-Compliance-Scanner/1.0 (+https://shieldkit.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    const html = await res.text();
    return { status: res.status, html };
  } catch {
    return null;
  }
}
