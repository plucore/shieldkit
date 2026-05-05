/**
 * Phase 7.2 — AI visibility tracking tests.
 * Pure-function tests for identifyCrawler + WoW delta plus a
 * file-content sanity check on the proxy route wiring.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  identifyCrawler,
  wowDeltaPct,
} from "../app/lib/ai-visibility/identify-crawler.server";

describe("identifyCrawler", () => {
  it("identifies GPTBot from a typical OpenAI UA", () => {
    expect(identifyCrawler("Mozilla/5.0 (compatible; GPTBot/1.0)")).toBe("GPTBot");
  });

  it("identifies ClaudeBot", () => {
    expect(
      identifyCrawler(
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)",
      ),
    ).toBe("ClaudeBot");
  });

  it("identifies PerplexityBot", () => {
    expect(identifyCrawler("PerplexityBot/1.0 +https://perplexity.ai/perplexitybot")).toBe(
      "PerplexityBot",
    );
  });

  it("returns 'other' for unknown UA", () => {
    expect(identifyCrawler("Mozilla/5.0 (Windows NT 10.0)")).toBe("other");
  });

  it("returns 'other' for null UA", () => {
    expect(identifyCrawler(null)).toBe("other");
  });

  it("returns 'other' for empty string", () => {
    expect(identifyCrawler("")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(identifyCrawler("CCBOT/2.0")).toBe("CCBot");
  });
});

describe("wowDeltaPct", () => {
  it("returns 100 when doubled", () => {
    expect(wowDeltaPct(20, 10)).toBe(100);
  });

  it("returns -50 when halved", () => {
    expect(wowDeltaPct(5, 10)).toBe(-50);
  });

  it("returns 0 when prior week was 0 (no baseline)", () => {
    expect(wowDeltaPct(50, 0)).toBe(0);
  });

  it("returns 0 when both are 0", () => {
    expect(wowDeltaPct(0, 0)).toBe(0);
  });

  it("returns 0 when unchanged", () => {
    expect(wowDeltaPct(7, 7)).toBe(0);
  });
});

describe("api.proxy.llms-txt wiring", () => {
  const root = join(__dirname, "..");

  it("imports identifyCrawler and writes to llms_txt_requests", () => {
    const src = readFileSync(
      join(root, "app", "routes", "api.proxy.llms-txt.ts"),
      "utf8",
    );
    expect(src).toContain("identifyCrawler");
    expect(src).toContain("llms_txt_requests");
    expect(src).toContain("createHash");
    expect(src).toContain("hashIp");
  });

  it("schema declares llms_txt_requests with UUID merchant_id", () => {
    const sql = readFileSync(join(root, "supabase", "schema.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS llms_txt_requests");
    expect(sql).toMatch(/merchant_id\s+UUID/);
  });
});
