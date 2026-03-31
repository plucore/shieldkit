/**
 * CHECK 5 — product_data_quality
 *
 * Evaluates product listing quality across four dimensions required by GMC:
 * description length, images, pricing, and SKU/identifier data.
 * Severity scales with the percentage of flagged products.
 */

import type { Product } from "../shopify-api.server";
import type { CheckResult, Severity, ProductIssue, FlaggedProduct } from "./types";
import { stripHtml } from "./helpers.server";

export function checkProductDataQuality(products: Product[]): CheckResult {
  const CHECK_NAME = "product_data_quality";

  if (products.length === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Product Data Quality",
      description: "No products found to evaluate.",
      fix_instruction: "No action required.",
      raw_data: { total_products: 0, flagged_count: 0, flagged_products: [] },
    };
  }

  const flagged: FlaggedProduct[] = [];

  for (const product of products) {
    const issues: ProductIssue[] = [];

    // Description quality
    const descText = stripHtml(product.descriptionHtml ?? "");
    if (!descText) {
      issues.push("empty_description");
    } else if (descText.length < 100) {
      issues.push("short_description");
    }

    // Image presence
    if (!product.images || product.images.length === 0) {
      issues.push("no_images");
    }

    // Pricing — flag any variant with a zero or missing price
    const hasZeroOrNullPrice = product.variants.some(
      (v) => !v.price || v.price === "0.00"
    );
    if (hasZeroOrNullPrice) {
      issues.push("zero_price");
    }

    // SKU — flag if ALL variants have no SKU (GMC uses SKU as an identifier)
    const allVariantsNoSku =
      product.variants.length > 0 &&
      product.variants.every((v) => !v.sku || v.sku.trim() === "");
    if (allVariantsNoSku) {
      issues.push("missing_sku");
    }

    if (issues.length > 0) {
      flagged.push({ title: product.title, handle: product.handle, issues });
    }
  }

  const totalProducts = products.length;
  const flaggedCount = flagged.length;
  const flaggedPct = (flaggedCount / totalProducts) * 100;

  const raw_data = {
    total_products: totalProducts,
    flagged_count: flaggedCount,
    flagged_percentage: Math.round(flaggedPct * 10) / 10,
    // Cap sample at 15 products to keep the JSONB payload reasonable.
    flagged_products: flagged.slice(0, 15),
  };

  if (flaggedCount === 0) {
    return {
      check_name: CHECK_NAME,
      passed: true,
      severity: "info",
      title: "Product Data Quality",
      description: `All ${totalProducts} products pass data quality checks.`,
      fix_instruction: "No action required.",
      raw_data,
    };
  }

  const severity: Severity = flaggedPct > 20 ? "warning" : "info";

  // Build a human-readable summary of what issue types were found.
  const issueTypeCounts: Partial<Record<ProductIssue, number>> = {};
  for (const fp of flagged) {
    for (const issue of fp.issues) {
      issueTypeCounts[issue] = (issueTypeCounts[issue] ?? 0) + 1;
    }
  }
  const issueSummary = (
    Object.entries(issueTypeCounts) as [ProductIssue, number][]
  )
    .map(([issue, count]) => {
      const label: Record<ProductIssue, string> = {
        empty_description: "empty description",
        short_description: "description under 100 characters",
        no_images: "no product images",
        zero_price: "zero or missing price",
        missing_sku: "all variants missing SKU",
      };
      return `${count} with ${label[issue]}`;
    })
    .join(", ");

  return {
    check_name: CHECK_NAME,
    passed: false,
    severity,
    title: "Product Data Quality Issues",
    description:
      `${flaggedCount} of ${totalProducts} products (${flaggedPct.toFixed(1)}%) ` +
      `have data quality issues: ${issueSummary}.`,
    fix_instruction:
      "For each flagged product in Shopify Admin → Products:\n" +
      "1. Empty/short description: Write at least 100 characters describing " +
      "the product's features, materials, dimensions, and use case.\n" +
      "2. No images: Upload at least one high-quality product image " +
      "(minimum 800×800px, white or clean background recommended by GMC).\n" +
      "3. Zero/missing price: Set a valid selling price on each variant. " +
      "Free products should be listed as $0.00 intentionally, but verify this.\n" +
      "4. Missing SKU: Add a unique SKU to each variant. GMC uses SKUs as " +
      "item identifiers — duplicates or blanks cause feed rejections.",
    raw_data,
  };
}
