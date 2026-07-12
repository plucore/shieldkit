/**
 * app/content/fixes.ts
 *
 * Programmatic SEO content for /fix/<slug> pages, one entry per
 * specific Google Merchant Center error or suspension reason.
 *
 * Each entry produces a 600-900 word page when rendered by
 * app/routes/fix.$slug.tsx. Keep cause + step + FAQ prose specific
 * and dense; the page is short by design.
 */

export interface FixStep {
  title: string;
  body: string;
}

export interface FixFaq {
  question: string;
  answer: string;
}

export interface Fix {
  slug: string;
  errorCode: string;
  title: string;
  description: string;
  publishedAt: string;
  cause: string;
  steps: FixStep[];
  relatedFixes: string[];
  relatedPosts: string[];
  keywords: string[];
  faqs: FixFaq[];
  /** One outbound link to a Google official help URL, anchor + url. */
  outboundHelp: { label: string; url: string };
}

export const FIXES: Fix[] = [
  {
    slug: "missing-gtin",
    errorCode: "Missing identifier [gtin]",
    title: "How to Fix the \"Missing GTIN\" Error in Google Merchant Center",
    description:
      "Step-by-step fix for the \"Missing identifier [gtin]\" error in Google Merchant Center on Shopify. Populate, bulk-edit, or set identifier_exists to false.",
    publishedAt: "2025-11-12",
    cause:
      "Google's catalog requires a GTIN (UPC, EAN, JAN, ISBN) for any product Google detects as branded. Shopify maps the variant Barcode field to GTIN automatically when syncing through the Google channel app, so the error fires whenever a branded product has its variant Barcode field empty.",
    steps: [
      {
        title: "Populate the variant Barcode field in Shopify admin",
        body: "Open the product → Variants → click the affected variant → fill the Barcode field with the product's GTIN. Each variant needs its own value if SKUs differ.",
      },
      {
        title: "Bulk-edit via product CSV",
        body: "Products → Export → All products. Edit the Variant Barcode column for affected rows. Re-import via Products → Import. Cleanest path for catalogs over 50 SKUs.",
      },
      {
        title: "Bulk-edit via Matrixify for large catalogs",
        body: "For catalogs over a few thousand SKUs, Matrixify exports and imports with richer metafield handling and clearer error reporting than Shopify's native CSV.",
      },
      {
        title: "If no GTIN exists, set custom.identifier_exists to false",
        body: "For genuinely unidentified products (handmade, custom, private-label) create a `custom.identifier_exists` metafield and set it to `false`. Don't combine this with a populated GTIN.",
      },
      {
        title: "Wait 24-72 hours for feed re-sync, then verify in GMC Diagnostics",
        body: "The Shopify Google channel re-syncs every 24-72 hours. After the window passes, GMC → Products → Diagnostics → Item issues should show the error cleared.",
      },
    ],
    relatedFixes: ["missing-mpn", "missing-brand", "missing-identifier-exists", "condition-not-declared"],
    relatedPosts: ["missing-gtin-shopify-fix", "mpn-brand-metafields-shopify"],
    keywords: [
      "missing gtin shopify",
      "missing identifier gtin google merchant center",
      "shopify barcode gtin",
      "google merchant center gtin error",
    ],
    faqs: [
      {
        question: "What is a GTIN?",
        answer:
          "GTIN stands for Global Trade Item Number, an 8-14 digit barcode standard that includes UPC, EAN, JAN, and ISBN. Most branded retail products have one assigned at the manufacturer level.",
      },
      {
        question: "Where is GTIN stored in Shopify?",
        answer:
          "Shopify stores GTIN in each variant's Barcode field. The Google channel app maps Barcode to GTIN automatically when syncing the product feed.",
      },
      {
        question: "What if my products genuinely don't have GTINs?",
        answer:
          "Set `custom.identifier_exists` to `false` on the product. This tells Google the product doesn't have a standard barcode, which is acceptable for handmade or private-label items.",
      },
      {
        question: "How long after fixing does the error clear?",
        answer:
          "24-72 hours for the Shopify Google channel feed to re-sync, then up to 7 days for Google to fully re-index. Most stores see GMC Diagnostics clear within 2-3 business days.",
      },
      {
        question: "Will GMC suspend my account if I leave GTIN missing?",
        answer:
          "Not for GTIN alone. But missing GTIN combined with missing brand and missing MPN can escalate to a \"limited performance\" warning and, in repeat cases, a misrepresentation suspension.",
      },
    ],
    outboundHelp: {
      label: "Google's product identifiers specification",
      url: "https://support.google.com/merchants/answer/6324461",
    },
  },
  {
    slug: "missing-mpn",
    errorCode: "Missing identifier [mpn]",
    title: "How to Fix the \"Missing MPN\" Error on Shopify Google Channel",
    description:
      "Step-by-step fix for the \"Missing identifier [mpn]\" error in Google Merchant Center. Add MPN as a Shopify metafield or set identifier_exists to false.",
    publishedAt: "2025-11-17",
    cause:
      "When GTIN is unavailable, Google requires MPN (manufacturer part number) plus brand as the substitute identifier pair. Shopify doesn't ship a built-in MPN field, so most stores have it missing across the catalog by default, the error fires on every product Google decides should have an MPN.",
    steps: [
      {
        title: "Create a custom.mpn metafield definition",
        body: "Settings → Custom data → Products → Add definition. Namespace and key: `custom.mpn`. Type: Single line text. Save.",
      },
      {
        title: "Populate MPN per product manually for testing",
        body: "Open one product, scroll to Metafields, fill `custom.mpn`. Wait 24-72h and verify the value appears in the Google channel feed before bulk-editing.",
      },
      {
        title: "Bulk-populate via Matrixify or product CSV",
        body: "Export with metafields included, fill the `custom.mpn` column for every applicable product, re-import. Use Matrixify for large catalogs; Shopify's native CSV is fragile around metafields.",
      },
      {
        title: "If MPN doesn't exist, set custom.identifier_exists to false",
        body: "Don't fabricate MPNs. For products that have no manufacturer part number, handmade, custom, private-label, set `custom.identifier_exists` to `false` and leave MPN, GTIN, and brand empty.",
      },
      {
        title: "Verify after 24-72 hours",
        body: "Force a feed re-sync (Sales channels → Google → Sync now). GMC → Products → Diagnostics → Item issues should show the MPN error cleared on affected products.",
      },
    ],
    relatedFixes: ["missing-gtin", "missing-brand", "missing-identifier-exists"],
    relatedPosts: ["mpn-brand-metafields-shopify", "missing-gtin-shopify-fix"],
    keywords: [
      "missing mpn shopify",
      "missing identifier mpn google",
      "shopify mpn metafield",
      "google merchant center mpn error",
    ],
    faqs: [
      {
        question: "What is an MPN?",
        answer:
          "MPN stands for Manufacturer Part Number, the manufacturer's internal SKU for a product. Different from your store's SKU unless you're the manufacturer.",
      },
      {
        question: "Do I need MPN if I already have GTIN?",
        answer:
          "No. GTIN is the preferred identifier and overrides the MPN+brand requirement. MPN is only needed when GTIN is genuinely unavailable.",
      },
      {
        question: "Can I use my Shopify SKU as the MPN?",
        answer:
          "Only if you are the manufacturer. If you resell branded products, the MPN must be the manufacturer's part number, not your internal SKU.",
      },
      {
        question: "Why does Google want both MPN and brand?",
        answer:
          "MPN alone is ambiguous, different manufacturers reuse part numbers. Brand plus MPN together uniquely identifies a product when GTIN doesn't exist.",
      },
      {
        question: "Where does the Google channel app look for MPN?",
        answer:
          "Most current versions read `custom.mpn`. Some legacy versions read `mc_google_offer.mpn`. Test by populating one product and inspecting the resulting feed.",
      },
    ],
    outboundHelp: {
      label: "Google's product identifiers specification",
      url: "https://support.google.com/merchants/answer/6324461",
    },
  },
  {
    slug: "missing-brand",
    errorCode: "Missing required attribute [brand]",
    title: "How to Fix the \"Missing Brand\" Error on Shopify Google Channel",
    description:
      "Fix the \"Missing required attribute [brand]\" error in Google Merchant Center on Shopify. Populate the Vendor field or override with a brand metafield.",
    publishedAt: "2025-11-22",
    cause:
      "Google requires a brand attribute on almost every product. Shopify's built-in Vendor field maps to brand by default in the Google channel feed, but many stores leave Vendor empty during product import, especially when products come in from dropshipping apps that don't fill it.",
    steps: [
      {
        title: "Populate the Vendor field on each product",
        body: "Shopify Admin → Products → click product → Vendor field (right sidebar). For private-label products, use your store name. For branded resale, use the manufacturer name.",
      },
      {
        title: "Bulk-edit via product CSV",
        body: "Products → Export → All products. Fill the Vendor column for empty rows. Re-import. Quickest path for catalogs over 50 products.",
      },
      {
        title: "Use a custom.brand metafield to override Vendor",
        body: "If your Vendor field is wrong (legacy data, supplier name not brand name), create a `custom.brand` metafield and populate the correct brand. Some Google channel app versions read this metafield over Vendor.",
      },
      {
        title: "Bulk-populate metafields via Matrixify",
        body: "For large catalogs, export with metafields, fill `custom.brand`, re-import. Cleaner than native CSV for metafield-heavy edits.",
      },
      {
        title: "Verify in the Google channel feed after re-sync",
        body: "Wait 24-72 hours. GMC → Products → All products. The Brand column should show your value on every product.",
      },
    ],
    relatedFixes: ["missing-gtin", "missing-mpn", "missing-identifier-exists"],
    relatedPosts: ["mpn-brand-metafields-shopify"],
    keywords: [
      "missing brand shopify google",
      "google merchant center brand error",
      "shopify vendor brand mapping",
      "shopify brand metafield",
    ],
    faqs: [
      {
        question: "Where is brand stored on Shopify?",
        answer:
          "By default in the product Vendor field. The Google channel app maps Vendor to the brand attribute in the feed. Some app versions also read a `custom.brand` metafield as an override.",
      },
      {
        question: "Can I use my store name as the brand for private-label products?",
        answer:
          "Yes. That's the standard pattern for private label, sell under your own brand name, populate Vendor and `custom.brand` with that name.",
      },
      {
        question: "Why does Google require brand?",
        answer:
          "Brand is one of the primary signals for catalog matching and ranking. Without brand, Google can't reliably link your product to its master catalog.",
      },
      {
        question: "What if my product genuinely has no brand?",
        answer:
          "True unbranded commodity items (rare) can use `identifier_exists=false`. For everything else, use your store name as the brand.",
      },
      {
        question: "Should I populate both Vendor and custom.brand?",
        answer:
          "Yes if you're unsure which your channel app version reads. Match the values to avoid feeding contradictory data to Google.",
      },
    ],
    outboundHelp: {
      label: "Google's brand attribute specification",
      url: "https://support.google.com/merchants/answer/6324351",
    },
  },
  {
    slug: "missing-identifier-exists",
    errorCode: "Missing identifier [identifier_exists]",
    title: "How to Set identifier_exists on Shopify for Unbranded Products",
    description:
      "Fix the \"Missing identifier_exists\" error on Shopify by explicitly declaring that your products don't have GTINs, MPNs, or brand identifiers.",
    publishedAt: "2025-11-27",
    cause:
      "For genuinely unbranded products, Google requires you to declare `identifier_exists=false` explicitly so the catalog match knows not to expect GTIN/MPN/brand. Shopify doesn't set this field by default, so the error fires on handmade, custom, and private-label products that lack standard identifiers.",
    steps: [
      {
        title: "Create the custom.identifier_exists metafield definition",
        body: "Settings → Custom data → Products → Add definition. Namespace and key: `custom.identifier_exists`. Type: Single line text.",
      },
      {
        title: "Set the value to \"false\" for affected products",
        body: "Open each affected product → Metafields → fill `custom.identifier_exists` with `false`. Test on one product first to confirm the namespace works.",
      },
      {
        title: "Bulk-populate via Matrixify or CSV",
        body: "Export products with metafields, fill `custom.identifier_exists` to `false` on affected rows, re-import. Matrixify handles large catalogs reliably.",
      },
      {
        title: "Ensure GTIN, MPN, and brand are also empty for those products",
        body: "Setting `identifier_exists=false` while populating brand or MPN is contradictory and gets flagged. Either omit all three, or remove `identifier_exists` and provide brand+MPN instead.",
      },
      {
        title: "Verify after 24-72 hours",
        body: "GMC → Products → All products. The Identifier exists column should show \"No\" on affected products. Item issues for missing identifiers should clear.",
      },
    ],
    relatedFixes: ["missing-gtin", "missing-mpn", "missing-brand"],
    relatedPosts: ["identifier-exists-bulk-shopify"],
    keywords: [
      "identifier exists shopify",
      "google merchant center identifier_exists false",
      "shopify unbranded products gmc",
      "shopify private label gmc",
    ],
    faqs: [
      {
        question: "When should I set identifier_exists to false?",
        answer:
          "When your products genuinely have no GTIN, MPN, or brand, typically handmade, custom-order, or private-label items below the GTIN registration threshold.",
      },
      {
        question: "Will this hurt my Google Shopping rankings?",
        answer:
          "Slightly. Products without verified identifiers rank below otherwise-equivalent products on contested queries. The penalty is much smaller than the suspension risk of leaving the field undeclared.",
      },
      {
        question: "Can I set identifier_exists=false on branded resale?",
        answer:
          "No. That's misrepresentation, branded products have GTINs by definition. Setting `identifier_exists=false` on branded items can trigger account-level suspension.",
      },
      {
        question: "Does Shopify set identifier_exists automatically?",
        answer:
          "No. Without an explicit metafield, Google treats the field as undeclared and fires the missing-identifier error.",
      },
      {
        question: "What's the right namespace for the metafield?",
        answer:
          "`custom.identifier_exists` works for most current Google channel app versions. Some legacy versions use `mc_google_offer.identifier_exists` instead.",
      },
    ],
    outboundHelp: {
      label: "Google's identifier_exists specification",
      url: "https://support.google.com/merchants/answer/6324478",
    },
  },
  {
    slug: "condition-not-declared",
    errorCode: "Missing required attribute [condition]",
    title: "How to Fix \"Condition Not Declared\" on Shopify Google Channel",
    description:
      "Fix the \"Missing required attribute [condition]\" error on Shopify by declaring product condition (new, used, or refurbished) in your Google channel feed.",
    publishedAt: "2025-12-02",
    cause:
      "Google requires every product to declare condition, `new`, `used`, or `refurbished`. Shopify's default product schema doesn't include the field, so the Google channel app sends nothing unless you configure a default value or populate a metafield. The error fires on every product where the field is missing.",
    steps: [
      {
        title: "Set a default condition in Google channel settings",
        body: "Sales channels → Google → Settings → Default condition. Set to `new` if your store sells only new items. Quickest fix when the catalog is homogeneous.",
      },
      {
        title: "For mixed catalogs, create a google.condition metafield",
        body: "Settings → Custom data → Products → Add definition with namespace+key `google.condition`, type Single line text. Restrict allowed values to `new`, `used`, `refurbished` if your definition supports option lists.",
      },
      {
        title: "Populate the metafield per product",
        body: "Per-product condition value overrides any global default. Use this for stores with mixed-condition catalogs (e.g., new alongside refurbished electronics).",
      },
      {
        title: "Bulk-populate via Matrixify or CSV",
        body: "Export products with metafields, fill `google.condition`, re-import. Pair with a global default in the channel settings as a fallback.",
      },
      {
        title: "Verify after 24-72 hours",
        body: "GMC → Products → All products. The Condition column should show your declared value. Item issues for missing condition should clear.",
      },
    ],
    relatedFixes: ["missing-gtin", "missing-brand"],
    relatedPosts: ["condition-not-declared-shopify-fix"],
    keywords: [
      "condition not declared shopify",
      "google merchant center condition error",
      "shopify product condition google channel",
      "google.condition metafield shopify",
    ],
    faqs: [
      {
        question: "What values does Google accept for condition?",
        answer:
          "Exactly three: `new`, `used`, `refurbished`. Other values (e.g., `like new`, `pre-owned`) are rejected.",
      },
      {
        question: "Does Shopify send condition by default?",
        answer:
          "No. The default product schema doesn't include condition. You configure it via the Google channel app's settings or per-product metafield.",
      },
      {
        question: "What's the difference between used and refurbished?",
        answer:
          "Refurbished is restored to working condition by the manufacturer or an authorized refurbisher. Used is everything else, including merchant-reconditioned items and open-box.",
      },
      {
        question: "Should I use a global default or per-product metafield?",
        answer:
          "Global default for stores selling only new. Per-product metafield for mixed catalogs, paired with a global fallback default.",
      },
      {
        question: "Will my products be suspended if condition is missing?",
        answer:
          "Not suspended, disapproved. Affected products are blocked from Shopping until condition is declared, but the rest of your catalog continues running.",
      },
    ],
    outboundHelp: {
      label: "Google's condition attribute specification",
      url: "https://support.google.com/merchants/answer/6324469",
    },
  },
  {
    slug: "price-mismatch",
    errorCode: "Mismatching prices",
    title: "How to Fix Price Mismatch Errors Between Shopify and Google",
    description:
      "Fix the \"Mismatching prices\" error in Google Merchant Center on Shopify. Audit currency conversion apps, scheduled discounts, and feed sync.",
    publishedAt: "2025-12-08",
    cause:
      "Price mismatch fires when the price in your Google feed differs from the price on the live product page. Common causes on Shopify: third-party currency conversion apps that change displayed prices but not feed prices, scheduled discounts that updated the storefront before the feed re-sync, and price-modifying apps (member pricing, bulk-discount scripts) that the feed doesn't see.",
    steps: [
      {
        title: "Identify the mismatched products in GMC Diagnostics",
        body: "GMC → Products → Diagnostics → Item issues → filter for \"Mismatching prices.\" Note the SKUs and the specific feed-vs-page delta.",
      },
      {
        title: "Audit currency conversion app behavior",
        body: "If using a third-party currency converter, verify the rates it shows match what your feed sends. Aggressive rounding or hidden margins are common culprits, switch to Shopify's native multi-currency or audit the app for transparent rates.",
      },
      {
        title: "Check scheduled discounts and price-modifying apps",
        body: "Shopify Admin → Discounts. Verify no active discount is changing storefront prices without updating the feed. Audit installed apps for member pricing, bulk discounts, or price scripts.",
      },
      {
        title: "Force a feed re-sync",
        body: "Sales channels → Google → Sync now. The Google channel re-pushes current Shopify prices to GMC, resolving timing-related mismatches.",
      },
      {
        title: "Verify after 24-72 hours",
        body: "GMC Diagnostics should show the price-mismatch errors cleared. If they persist, the issue is structural (app behavior), revisit step 2 or 3.",
      },
    ],
    relatedFixes: ["availability-mismatch", "hidden-fees", "untrustworthy-promotions"],
    relatedPosts: ["untrustworthy-promotions-gmc-meaning", "hidden-gmc-triggers-shopify"],
    keywords: [
      "shopify price mismatch google",
      "mismatching prices google merchant center",
      "shopify google feed price discrepancy",
      "shopify currency conversion gmc",
    ],
    faqs: [
      {
        question: "Why does my Shopify feed have different prices than my product pages?",
        answer:
          "Most often a third-party app, currency converter, member-pricing app, or bulk-discount script, modifies storefront prices without updating the feed. Less often: scheduled discounts that took effect before the feed re-synced.",
      },
      {
        question: "How tolerant is Google of price differences?",
        answer:
          "Within ~3% Google generally tolerates rounding differences. Beyond that, the mismatch fires.",
      },
      {
        question: "Does tax count toward price mismatch?",
        answer:
          "In tax-inclusive regions (EU/UK), feed and storefront should both show tax-inclusive. In US tax-exclusive markets, tax is added at checkout and doesn't trigger price mismatch.",
      },
      {
        question: "How long does the fix take to propagate?",
        answer:
          "24-72 hours for the Google channel to re-sync, plus 24 hours for Diagnostics to refresh. Plan for 1-3 business days end to end.",
      },
      {
        question: "What if I use multi-currency on Shopify?",
        answer:
          "Use Shopify's native multi-currency, which converts at market rates without margin. Third-party currency apps are the most common cause of unexpected price mismatches.",
      },
    ],
    outboundHelp: {
      label: "Google's price specification",
      url: "https://support.google.com/merchants/answer/6324371",
    },
  },
  {
    slug: "availability-mismatch",
    errorCode: "Mismatching availability",
    title: "How to Fix Availability Mismatch on Shopify Google Channel",
    description:
      "Fix the \"Mismatching availability\" error on Shopify by syncing inventory between Shopify and Google's feed and ensuring themes respect inventory state.",
    publishedAt: "2025-12-13",
    cause:
      "Availability mismatch fires when your feed says one thing (in-stock or out-of-stock) and the live product page says another. Common causes: inventory sync delays from third-party stock-management apps, theme code that hides or shows buy buttons inconsistently, and variant-level inventory not propagating to the parent product feed.",
    steps: [
      {
        title: "Force an inventory sync",
        body: "Shopify Admin → Inventory → bulk action → Reconcile. For multi-location stores, ensure the Google channel sales channel is enabled at every location selling the affected products.",
      },
      {
        title: "Verify your theme respects inventory status on product pages",
        body: "Open an out-of-stock product in incognito. The page should clearly show \"Sold out\" and hide the Add to cart button. If buy buttons remain active on out-of-stock variants, that's a theme bug to fix.",
      },
      {
        title: "Hide buy buttons on out-of-stock variants",
        body: "As of April 2026 an active buy button on an out-of-stock product is an account-level violation. Fix in your theme's `product.liquid` or via theme settings, depends on theme version.",
      },
      {
        title: "Force a feed re-sync via the Google channel",
        body: "Sales channels → Google → Sync now. Republishes current inventory state to GMC, resolving timing-related mismatches.",
      },
      {
        title: "Verify after 24-72 hours",
        body: "GMC → Diagnostics → Item issues. Availability errors should clear. If they persist, audit installed inventory apps for sync lag.",
      },
    ],
    relatedFixes: ["price-mismatch", "products-not-showing"],
    relatedPosts: ["untrustworthy-promotions-gmc-meaning"],
    keywords: [
      "shopify availability mismatch google",
      "mismatching availability google merchant center",
      "shopify inventory sync gmc",
      "shopify out of stock buy button",
    ],
    faqs: [
      {
        question: "Why is my feed wrong about inventory?",
        answer:
          "Usually third-party inventory app lag. Shopify's native inventory updates the feed within minutes; some stock-management apps add hours of delay between Shopify and the feed.",
      },
      {
        question: "How quickly should the feed reflect inventory changes?",
        answer:
          "On native Shopify inventory, within 1-2 hours. On third-party stock apps, up to 24 hours depending on the app's sync schedule.",
      },
      {
        question: "Should I hide or gray out the buy button on out-of-stock products?",
        answer:
          "Hide. Google's policy as of 2026 treats a visible (even disabled) buy button on an out-of-stock product as a misrepresentation trigger.",
      },
      {
        question: "What about variant-level out-of-stock?",
        answer:
          "If a single variant is out of stock, hide its buy button while keeping other variants available. Most modern themes handle this; older custom themes may not.",
      },
      {
        question: "Will availability mismatch suspend my account?",
        answer:
          "Item-level disapprovals only for occasional mismatch. Persistent or systematic mismatch can escalate to account-level misrepresentation.",
      },
    ],
    outboundHelp: {
      label: "Google's availability attribute specification",
      url: "https://support.google.com/merchants/answer/6324448",
    },
  },
  {
    slug: "missing-product-image",
    errorCode: "Missing required attribute [image_link]",
    title: "How to Fix \"Missing Product Image\" on Shopify Google Channel",
    description:
      "Fix the \"Missing image_link\" error on Shopify by ensuring every product has an accessible primary image meeting Google's minimum requirements.",
    publishedAt: "2025-12-18",
    cause:
      "The error fires either because a product has no primary image at all, or because the image fails Google's quality requirements (minimum 100x100 for non-apparel, 250x250 for apparel; PNG or JPG; no excessive promotional overlays). It can also fire when robots.txt blocks Googlebot from your image host.",
    steps: [
      {
        title: "Verify every product has at least one image",
        body: "Shopify Admin → Products → look for products with no media. Filter or sort by image count. Every product needs a primary image to clear the error.",
      },
      {
        title: "Use minimum 800x800 PNG or JPG",
        body: "Google's published minimums are smaller, but 800x800 is the practical floor for AI Overview eligibility too. Square format works best for Shopping.",
      },
      {
        title: "Ensure no promotional overlays",
        body: "Images with text, prices, sale tags, or watermarks fail Google's quality check. Use clean product photography in the feed; keep marketing imagery for ads only.",
      },
      {
        title: "Check robots.txt isn't blocking image hosts",
        body: "Open `https://yourstore.com/robots.txt`. Verify no `Disallow: /cdn/` or similar rule blocks the image CDN. Shopify's CDN at `cdn.shopify.com` should always be reachable.",
      },
      {
        title: "Verify after re-sync",
        body: "Wait 24-72h. GMC Diagnostics → Item issues. Missing image errors should clear. If they persist, the cause is usually image quality (size, overlay, format).",
      },
    ],
    relatedFixes: ["dropshipping-cdn-images", "promotional-overlay-image"],
    relatedPosts: ["dropshipping-cdn-images-shopify-gmc"],
    keywords: [
      "missing product image shopify google",
      "google merchant center image_link error",
      "shopify product image gmc",
      "image_link missing google shopping",
    ],
    faqs: [
      {
        question: "What's Google's minimum image size?",
        answer:
          "100x100 pixels for non-apparel, 250x250 for apparel. Recommended is 800x800 or larger for ranking and AI Overview eligibility.",
      },
      {
        question: "What image formats does Google accept?",
        answer:
          "JPG, PNG, GIF (non-animated), BMP, and TIFF. PNG and JPG are the standard choices.",
      },
      {
        question: "Are watermarks allowed on product images?",
        answer:
          "Subtle copyright watermarks are tolerated. Visible promotional text, prices, or sale tags fail Google's quality check.",
      },
      {
        question: "Why is Google saying my image is missing when I can see it?",
        answer:
          "The crawler can't reach the URL. Check `robots.txt` for blocks on your image CDN, and verify the image returns HTTP 200 in incognito.",
      },
      {
        question: "Should I use the manufacturer's product images?",
        answer:
          "Only if you have authorization. Manufacturer press-kit images used without authorization can trigger counterfeit-policy issues, re-shoot or upload your own where possible.",
      },
    ],
    outboundHelp: {
      label: "Google's image_link specification",
      url: "https://support.google.com/merchants/answer/6324350",
    },
  },
  {
    slug: "dropshipping-cdn-images",
    errorCode: "Generic image",
    title: "How to Fix Dropshipping CDN Image Errors in Google Merchant Center",
    description:
      "Fix \"Generic image\" disapprovals on Shopify by replacing hot-linked dropshipping CDN images (AliExpress, Oberlo, DSers) with self-hosted Shopify images.",
    publishedAt: "2025-12-23",
    cause:
      "Google's AI crawler detects when product images are served from known dropshipping CDNs, alicdn.com, oberlo.com, dsers, spocket, and flags the store under misrepresentation policy. The reason: hot-linked supplier images signal a reseller hasn't built a differentiated merchant operation, and the images can change without the merchant's knowledge.",
    steps: [
      {
        title: "View source on a sample product page",
        body: "Right-click the page → View Page Source. Search for `alicdn`, `oberlo`, or `dsers`. Any matches mean you have hot-linked supplier images.",
      },
      {
        title: "Identify all non-Shopify CDN image URLs",
        body: "Bulk audit via products CSV, search the Image Src column for any URL not on `cdn.shopify.com`. Count occurrences to estimate cleanup scope.",
      },
      {
        title: "Download and re-upload images to Shopify",
        body: "Save images locally, upload via Products → [Product] → Media → Upload. Shopify's CDN auto-serves them at `cdn.shopify.com`. For volume, use Matrixify's bulk image upload.",
      },
      {
        title: "Bulk-replace via Matrixify",
        body: "Matrixify exports/imports image URLs and handles the re-host server-side. Cleanest path for catalogs over 200 products.",
      },
      {
        title: "Update import settings to prevent recurrence",
        body: "If using Oberlo, DSers, or Spocket, switch the import setting from \"hot-link\" to \"download to Shopify.\" New imports won't reintroduce the problem.",
      },
    ],
    relatedFixes: ["missing-product-image", "account-suspension-misrepresentation"],
    relatedPosts: ["dropshipping-cdn-images-shopify-gmc"],
    keywords: [
      "dropshipping cdn images google",
      "alicdn shopify gmc",
      "oberlo image hosting suspension",
      "shopify supplier image gmc disapproval",
    ],
    faqs: [
      {
        question: "Is dropshipping itself banned by Google?",
        answer:
          "No. Google penalizes the pattern of using stock supplier images and supplier descriptions verbatim. Drop ship as much as you want, just own your imagery.",
      },
      {
        question: "Which CDNs does Google flag?",
        answer:
          "Most commonly: alicdn.com, ae01.alicdn.com, cbu01.alicdn.com (Alibaba), oberlo.com, oberlocdn.com, cdn.dsers.com, assets.spocket.co. Free image hosts in general are suspect.",
      },
      {
        question: "How long does the cleanup take?",
        answer:
          "Manually for 200 products: 4-6 hours. With Matrixify: 30-60 minutes. For 1,000+ products, only Matrixify is realistic.",
      },
      {
        question: "What about variant-level images?",
        answer:
          "Variant images can be hot-linked too. Audit both product-level and variant-level image URLs in your CSV.",
      },
      {
        question: "Will replacing images automatically clear the suspension?",
        answer:
          "Clearing the trigger doesn't auto-clear the suspension. You still have to wait 7 days for recrawl, then submit a re-review appeal documenting the fix.",
      },
    ],
    outboundHelp: {
      label: "Google's misrepresentation policy",
      url: "https://support.google.com/merchants/answer/6150127",
    },
  },
  {
    slug: "promotional-overlay-image",
    errorCode: "Promotional overlay on image",
    title: "How to Fix Promotional Overlay on Image Errors",
    description:
      "Fix the \"Promotional overlay\" error in Google Merchant Center on Shopify by replacing product images with clean photography free of sale tags and watermarks.",
    publishedAt: "2025-12-28",
    cause:
      "Google rejects product images that contain promotional text, sale prices, percentage-off badges, brand watermarks, or marketing graphics. The catalog uses clean product photography to maintain consistency; merchants who include promotional overlays trigger this error per affected SKU.",
    steps: [
      {
        title: "Identify affected products in GMC Diagnostics",
        body: "GMC → Diagnostics → Item issues → filter for \"Promotional overlay\" or \"Image quality.\" Affected SKUs are listed individually.",
      },
      {
        title: "Replace with clean product images",
        body: "Use photography without text, badges, prices, or marketing graphics. The standard pattern: white-background or lifestyle shots, no overlay text.",
      },
      {
        title: "Keep marketing imagery for ads only, not the product feed",
        body: "Promotional images belong in Google Ads creatives, not in your product feed. Maintain two image sets, clean for the catalog, marketing for ad campaigns.",
      },
      {
        title: "Verify after re-sync",
        body: "Wait 24-72h. GMC Diagnostics should clear the overlay errors. Re-flagged products usually have subtle issues, small badges or text near corners; review carefully.",
      },
    ],
    relatedFixes: ["missing-product-image", "dropshipping-cdn-images"],
    relatedPosts: ["dropshipping-cdn-images-shopify-gmc"],
    keywords: [
      "promotional overlay image google",
      "google merchant center image overlay",
      "shopify product image text overlay",
      "shopify product image badge gmc",
    ],
    faqs: [
      {
        question: "What counts as a promotional overlay?",
        answer:
          "Any text, badge, price, percentage-off graphic, or marketing element added on top of the product photo. Clean product photography only, overlays belong in ad creatives, not the feed.",
      },
      {
        question: "Are subtle copyright watermarks allowed?",
        answer:
          "Subtle copyright text in a corner is tolerated. Visible promotional content (\"30% off,\" \"Best Seller,\" prices) fails the policy.",
      },
      {
        question: "Can I use a brand logo on the product image?",
        answer:
          "Discouraged. The product image should show the product, not branding. Subtle logos on the product itself (e.g., a Nike swoosh on a shoe) are fine; added logo overlays are not.",
      },
      {
        question: "How do I keep marketing creatives separate from the feed?",
        answer:
          "Maintain two image sets in your media library. Tag or organize them by purpose. Use clean product images for the feed; reserve promotional creatives for Google Ads campaigns.",
      },
      {
        question: "Will this affect my Shopping rankings?",
        answer:
          "Disapproved products are blocked from Shopping entirely until the overlay is removed. Other products are unaffected.",
      },
    ],
    outboundHelp: {
      label: "Google's image quality requirements",
      url: "https://support.google.com/merchants/answer/6324350",
    },
  },
  {
    slug: "excessive-capitalization",
    errorCode: "Excessive capitalization in title",
    title: "How to Fix \"Excessive Capitalization\" Errors on Google Shopping",
    description:
      "Fix \"Excessive capitalization\" errors on Shopify by rewriting product titles in title case, removing ALL CAPS and sale tags.",
    publishedAt: "2026-01-03",
    cause:
      "Google's product data policy treats titles using ALL CAPS, repeated punctuation, or sale tags like \"NEW!,\" \"BEST!,\" or \"HOT SALE\" as misleading or spammy. The error fires per affected SKU and disapproves the product from Shopping until the title is rewritten.",
    steps: [
      {
        title: "Bulk-audit titles via product CSV",
        body: "Products → Export → All products. In your spreadsheet, sort or filter the Title column for ALL CAPS, exclamation marks, or trigger words like NEW, BEST, SALE, HOT.",
      },
      {
        title: "Rewrite to title case",
        body: "Replace ALL CAPS with Title Case. \"BLACK COTTON HOODIE FOR MEN\" becomes \"Black Cotton Hoodie for Men.\" Bulk find-and-replace in your spreadsheet handles common patterns.",
      },
      {
        title: "Remove sale tags and exclamation marks",
        body: "\"Best Seller!,\" \"Hot Sale,\" \"NEW Arrival\" don't belong in titles. Move promotional context to product descriptions or sale collection pages.",
      },
      {
        title: "Re-import and verify after re-sync",
        body: "Re-import the cleaned CSV. Wait 24-72h for Google channel re-sync. GMC → Diagnostics → Item issues. Capitalization errors should clear.",
      },
    ],
    relatedFixes: ["products-not-showing", "missing-product-image"],
    relatedPosts: ["products-not-showing-google-shopping-shopify"],
    keywords: [
      "excessive capitalization google shopping",
      "shopify all caps product title",
      "google merchant center title quality",
      "shopify product title gmc error",
    ],
    faqs: [
      {
        question: "What capitalization is allowed in product titles?",
        answer:
          "Standard title case (capitalize main words). All caps for an entire word or title is rejected. Brand names with intentional caps (e.g., \"H&M\") are fine.",
      },
      {
        question: "Can I use exclamation marks in titles?",
        answer:
          "Avoid. They trigger title-quality flags even when the rest of the title is fine. Keep promotional language out of titles.",
      },
      {
        question: "Where should I put promotional language?",
        answer:
          "Product descriptions, sale collection pages, banner copy on the storefront, or Google Ads creative. Not in the title.",
      },
      {
        question: "Will fixing titles improve my rankings?",
        answer:
          "Often yes. Descriptive titles match more queries than promotional titles. Stores that rewrite to natural-language titles see citation rates 3-5x higher within two weeks.",
      },
      {
        question: "How long does the fix take to propagate?",
        answer:
          "24-72 hours for the Google channel to re-sync, then up to 7 days for Google to fully re-index titles in Shopping rankings.",
      },
    ],
    outboundHelp: {
      label: "Google's title attribute specification",
      url: "https://support.google.com/merchants/answer/6324415",
    },
  },
  {
    slug: "hidden-fees",
    errorCode: "Hidden fees",
    title: "How to Fix \"Hidden Fees\" Disapproval on Google Shopping",
    description:
      "Fix the \"Hidden fees\" disapproval on Shopify by exposing every checkout charge, handling, surcharges, fees, before the customer reaches checkout.",
    publishedAt: "2026-01-08",
    cause:
      "Google considers any fee a customer pays at checkout that wasn't visible on the product page or in the feed a hidden fee. Standard shipping shown as a separate line is the explicit exception. Everything else, handling fees, currency conversion margins, app-injected protection fees, restocking fees buried in fine print, must be disclosed pre-checkout or removed.",
    steps: [
      {
        title: "Walk through your own checkout as a real customer",
        body: "Open an incognito window. Add a representative product to cart. Note every fee, surcharge, or line item between product page and order confirmation.",
      },
      {
        title: "Identify any fee not shown pre-checkout",
        body: "Compare to your product page. If a fee appears at checkout but wasn't visible on the product page, it's a hidden fee under Google's policy.",
      },
      {
        title: "Expose fees on the product page or pre-checkout",
        body: "Add a notice near the price area or in a pre-checkout banner. \"$3 small-order fee under $25\" visibly disclosed clears the policy. Burying disclosure in a policy page doesn't.",
      },
      {
        title: "Remove unnecessary surprise fees",
        body: "Handling and processing fees can be folded into the product price. Insurance/protection apps can be set to opt-in. Restocking fees can be moved to clear pre-checkout disclosure.",
      },
      {
        title: "Verify after 7 days for recrawl",
        body: "Google needs 7 days to re-crawl your store. Then submit a re-review appeal if products were disapproved.",
      },
    ],
    relatedFixes: ["untrustworthy-promotions", "missing-checkout-transparency"],
    relatedPosts: ["hidden-fees-google-shopping-shopify"],
    keywords: [
      "hidden fees google shopping",
      "shopify checkout fee disapproval",
      "google merchant center hidden fees",
      "shopify handling fee gmc",
    ],
    faqs: [
      {
        question: "Are shipping fees considered hidden?",
        answer:
          "No, as long as they're calculated from a disclosed shipping policy and shown as a separate line at checkout. Standard shipping is the explicit exception in Google's hidden-fee rule.",
      },
      {
        question: "Can I disclose fees only in my refund policy?",
        answer:
          "No. Hidden-fee disclosure must happen before checkout, visibly, on the product page or in a pre-checkout banner. Policy pages alone don't satisfy the rule.",
      },
      {
        question: "What about US sales tax?",
        answer:
          "Sales tax shown as a separate checkout line is allowed because tax is jurisdiction-dependent. Display \"+ tax\" on product pages where tax materially affects total cost.",
      },
      {
        question: "Are shipping protection apps a hidden fee?",
        answer:
          "Only when set to opt-out. Opt-in shipping protection with the price disclosed pre-checkout is compliant.",
      },
      {
        question: "How long until disapproved products come back?",
        answer:
          "7 days for recrawl after the fix, then submit an appeal. Most clean fixes return products to Shopping within 1-2 weeks.",
      },
    ],
    outboundHelp: {
      label: "Google's misrepresentation policy",
      url: "https://support.google.com/merchants/answer/6150127",
    },
  },
  {
    slug: "untrustworthy-promotions",
    errorCode: "Untrustworthy promotions",
    title: "How to Fix \"Untrustworthy Promotions\" Disapproval",
    description:
      "Fix the \"Untrustworthy promotions\" disapproval on Shopify by auditing promo codes, fixing pricing claims, and removing expired or inaccurate offers.",
    publishedAt: "2026-01-13",
    cause:
      "Untrustworthy promotions covers deceptive marketing claims: promo codes that no longer work, \"up to X% off\" claims where X is true for almost no products, BOGO offers with hidden conditions, and expired or invalid promotions still appearing in your feed or storefront.",
    steps: [
      {
        title: "Audit every active promo code",
        body: "Try each promo code in incognito at checkout. Codes that no longer work must be removed from feed promotional metafields, banner copy, and ad assets.",
      },
      {
        title: "Use exact percentages instead of vague ranges",
        body: "\"Up to 50% off\" must be true for a meaningful share of the catalog. Either match the claim or rewrite to specific percentages: \"30% off most items, 50% off select clearance.\"",
      },
      {
        title: "Remove expired promotions across all surfaces",
        body: "Audit homepage banners, theme code, app-injected popups, the Google channel app's promotional fields, and Google Ads assets. Old codes hide everywhere.",
      },
      {
        title: "Make eligibility transparent",
        body: "If a promo applies only to loyalty members or new customers, disclose the eligibility in the banner. Promotions presented as universal but gated to a subset trigger the policy.",
      },
      {
        title: "Verify after 7 days for recrawl, then appeal",
        body: "Google's crawler needs to re-index your store. Wait 7 days, then submit an appeal documenting the specific promo codes removed and pages updated.",
      },
    ],
    relatedFixes: ["hidden-fees", "price-mismatch", "account-suspension-misrepresentation"],
    relatedPosts: ["untrustworthy-promotions-gmc-meaning"],
    keywords: [
      "untrustworthy promotions google",
      "google merchant center promotion policy",
      "shopify expired promo code gmc",
      "shopify gmc promotion violation",
    ],
    faqs: [
      {
        question: "What does Google mean by untrustworthy promotions?",
        answer:
          "Promotions Google considers deceptive, hidden eligibility rules, expired codes still in feeds, pricing mismatches, vague discount claims, or out-of-stock products in active offers.",
      },
      {
        question: "Can I run flash sales?",
        answer:
          "Yes if the timing is honest and the discount is real. A \"24-hour flash sale\" running for three weeks fails the policy.",
      },
      {
        question: "Are countdown timers allowed?",
        answer:
          "Real timers tied to genuine end dates: yes. Timers that reset every visit (\"Sale ends in 4:59:32!\"): no, the urgency is fabricated.",
      },
      {
        question: "What about \"members-only\" pricing?",
        answer:
          "Allowed if the eligibility is transparent. Banner copy must disclose: \"20% off site-wide for loyalty members.\" Universal-looking promos with hidden gating fail.",
      },
      {
        question: "How do I find leftover promo references?",
        answer:
          "Audit theme code (header.liquid, cart.liquid), installed apps (popup, urgency-bar, abandoned-cart), the Google channel promotional fields, and your Google Ads assets.",
      },
    ],
    outboundHelp: {
      label: "Google's misrepresentation policy",
      url: "https://support.google.com/merchants/answer/6150127",
    },
  },
  {
    slug: "counterfeit-goods",
    errorCode: "Counterfeit goods",
    title: "How to Fix \"Counterfeit Goods\" Suspension on Shopify",
    description:
      "Recover from a \"Counterfeit goods\" suspension on Shopify by auditing brand-name usage, removing unauthorized branding, and submitting documented appeals.",
    publishedAt: "2026-01-18",
    cause:
      "Google flags counterfeit when brand names appear in product titles or descriptions without authorized-reseller status, when manufacturer press-kit images are used without permission, or when \"inspired by [brand]\" framing appears anywhere on the product page. Categories like fragrance, fashion, watches, and electronics see this most.",
    steps: [
      {
        title: "Audit titles for unauthorized brand names",
        body: "Export products CSV. Search the Title column for any brand name. Flag any not on your authorized-reseller list. Rewrite or remove the affected products.",
      },
      {
        title: "Remove brand imagery you don't have authorization for",
        body: "Replace manufacturer press-kit images with your own product photography. Even authentic products require your own imagery to clear the policy.",
      },
      {
        title: "Rewrite descriptions to remove brand-comparison language",
        body: "Phrases like \"inspired by,\" \"alternative to,\" \"comparable to,\" \"dupe,\" or \"replica\" all trigger the policy. Describe products on their own merits.",
      },
      {
        title: "Pull supplier invoices proving authentic sourcing",
        body: "For branded resale, gather invoices, distributor agreements, or authorization letters. Provide them in your appeal, supplier documentation is the most-weighted appeal evidence.",
      },
      {
        title: "Submit a detailed appeal",
        body: "Use the appeal letter template, name the policy, document each fix with dates, attach supplier invoices. Wait 7 days for recrawl before appealing.",
      },
    ],
    relatedFixes: ["account-suspension-counterfeit", "business-information-mismatch"],
    relatedPosts: ["google-ads-counterfeit-shopify", "gmc-appeal-letter-template-shopify"],
    keywords: [
      "counterfeit goods google shopping shopify",
      "google merchant center counterfeit suspension",
      "shopify brand name product title gmc",
      "shopify replica gmc",
    ],
    faqs: [
      {
        question: "Can I sell branded products without authorization?",
        answer:
          "Some categories require explicit authorized-reseller status (luxury fragrance, watches, designer apparel). Others tolerate authentic resale with documented sourcing. Authorization documentation strengthens any appeal.",
      },
      {
        question: "Is \"compatible with [brand]\" allowed?",
        answer:
          "Generally yes for accessories (\"compatible with iPhone 15\") if the product is genuinely compatible. \"Inspired by\" or \"alternative to\" framing is not allowed.",
      },
      {
        question: "What documentation should I include in my appeal?",
        answer:
          "Supplier invoices showing authentic sourcing, distributor or brand authorization letters where applicable, and dated screenshots of the changes made on your store.",
      },
      {
        question: "Can I use manufacturer product images?",
        answer:
          "Only with explicit authorization. Even authentic products require your own photography unless you have written permission to use the manufacturer's images.",
      },
      {
        question: "How long does a counterfeit appeal take?",
        answer:
          "7-14 business days typically. Counterfeit appeals are slower than misrepresentation appeals because they involve brand verification.",
      },
    ],
    outboundHelp: {
      label: "Google's counterfeit goods policy",
      url: "https://support.google.com/merchants/answer/6150127",
    },
  },
  {
    slug: "restricted-product",
    errorCode: "Restricted product",
    title: "How to Fix \"Restricted Product\" Errors on Shopify",
    description:
      "Fix \"Restricted product\" errors in Google Merchant Center on Shopify by reviewing the specific category, excluding restricted regions, or removing affected products.",
    publishedAt: "2026-01-23",
    cause:
      "Google enforces category-specific restrictions: health and medical claims, weapons and ammunition, adult content, alcohol, tobacco, gambling, and CBD/cannabis products. Restrictions vary by destination country. The error fires when a product falls in a fully or partially restricted category for the regions you're targeting.",
    steps: [
      {
        title: "Review the specific category violation in GMC",
        body: "GMC → Diagnostics → Item issues. The error usually names the category, \"Restricted product: weapons,\" \"Restricted product: healthcare.\" Identify the exact policy hit.",
      },
      {
        title: "Remove fully banned products from the feed",
        body: "If the category is banned in your target region (e.g., CBD in regions where Google Shopping disallows it), remove those products from the Google channel feed. Keep them on your storefront if your region's regulations allow.",
      },
      {
        title: "For region-specific restrictions, exclude the restricted region",
        body: "Some categories are allowed in some regions, restricted in others. Configure region-specific feeds via the Google channel app to exclude restricted destinations while serving allowed ones.",
      },
      {
        title: "Check for false positives in Diagnostics",
        body: "Some products are mis-categorized by Google's classifier. If you sell a non-restricted product flagged as restricted, appeal with documentation showing the correct category.",
      },
    ],
    relatedFixes: ["counterfeit-goods", "account-suspension-misrepresentation"],
    relatedPosts: ["gmc-suspension-reasons-shopify"],
    keywords: [
      "restricted product google merchant center",
      "shopify gmc restricted category",
      "google shopping cbd restriction",
      "google merchant center health product",
    ],
    faqs: [
      {
        question: "What categories does Google restrict?",
        answer:
          "Healthcare with claims, weapons, ammunition, adult content, alcohol, tobacco, gambling, CBD/cannabis, and various pharmaceutical and medical-device categories. Restrictions vary by region.",
      },
      {
        question: "Can I sell CBD products on Google Shopping?",
        answer:
          "Region-dependent. Some regions allow topical CBD; most don't allow ingestible. Always check Google's current policy for your specific destination markets.",
      },
      {
        question: "What if Google misclassified my product?",
        answer:
          "Submit an appeal with documentation, product specs, ingredient lists, regulatory approvals, showing the product is in an allowed category. Misclassification is appeal-able.",
      },
      {
        question: "Can I sell restricted products in some regions?",
        answer:
          "Yes, configure region-specific feeds to include restricted products only in regions where they're allowed. The Google channel app supports per-region targeting.",
      },
      {
        question: "Will restricted product errors suspend my account?",
        answer:
          "Item-level only for occasional issues. Repeat or systematic restricted-product violations can escalate to account suspension.",
      },
    ],
    outboundHelp: {
      label: "Google's restricted products policy",
      url: "https://support.google.com/merchants/answer/6150006",
    },
  },
  {
    slug: "missing-shipping-policy",
    errorCode: "Missing shipping policy",
    title: "How to Fix \"Missing Shipping Policy\" on Shopify",
    description:
      "Fix the \"Missing shipping policy\" error on Shopify by creating a complete shipping policy page, linking it from the footer, and ensuring it's accessible without login.",
    publishedAt: "2026-01-28",
    cause:
      "Google requires a publicly accessible shipping policy that includes rates, regions, and delivery timing. The error fires when the page is missing entirely, password-protected, behind a login, or unlinked from the footer (which means Google's crawler can't find it).",
    steps: [
      {
        title: "Create a shipping policy at /policies/shipping",
        body: "Shopify Admin → Settings → Policies → Shipping policy → \"Create from template.\" Customize with your actual rates and timing, don't leave placeholders.",
      },
      {
        title: "Include rates, regions, and timing explicitly",
        body: "Vague language (\"we ship most orders quickly\") fails. Specify timeframes (\"orders ship within 1-2 business days\"), costs (\"$5.99 flat US shipping, free over $50\"), and regions served.",
      },
      {
        title: "Link from the footer on every page",
        body: "Most Shopify themes auto-link policies in the footer. Verify by viewing your live site in incognito and checking the footer. If missing, edit theme settings or `footer.liquid`.",
      },
      {
        title: "Verify accessible without login",
        body: "Open `https://yourstore.com/policies/shipping-policy` in incognito (signed out). The page must load with full content, not redirect to login or homepage.",
      },
    ],
    relatedFixes: ["missing-refund-policy", "missing-contact-information", "missing-checkout-transparency"],
    relatedPosts: ["gmc-suspension-shopify-checklist"],
    keywords: [
      "missing shipping policy shopify google",
      "google merchant center shipping policy error",
      "shopify shipping policy gmc",
      "shopify policy page accessible",
    ],
    faqs: [
      {
        question: "What must my shipping policy include?",
        answer:
          "Delivery timing in days, shipping costs (or how they're calculated), and regions served. \"Free shipping over $50\" with a costs table beats \"low shipping rates.\"",
      },
      {
        question: "Where should the policy live?",
        answer:
          "At `/policies/shipping-policy` (Shopify's standard URL). Linked from the footer on every page.",
      },
      {
        question: "Can my shipping policy be password-protected?",
        answer:
          "No. The policy must be reachable to Google's crawler without login or password.",
      },
      {
        question: "Is Shopify's template policy enough?",
        answer:
          "Only if you customize it. The default template has placeholder text that fails Google's review. Replace placeholders with your actual rates and timing.",
      },
      {
        question: "Does my shipping policy need to match what's at checkout?",
        answer:
          "Yes. Discrepancies between the policy and actual checkout behavior trigger misrepresentation. Free shipping in the policy must be free at checkout.",
      },
    ],
    outboundHelp: {
      label: "Google's shipping requirements",
      url: "https://support.google.com/merchants/answer/6324520",
    },
  },
  {
    slug: "missing-refund-policy",
    errorCode: "Missing refund policy",
    title: "How to Fix \"Missing Refund Policy\" on Shopify",
    description:
      "Fix the \"Missing refund policy\" error on Shopify by creating a complete return policy page with window, conditions, and process, accessible from the footer.",
    publishedAt: "2026-02-02",
    cause:
      "Google requires a publicly accessible refund/return policy that names a specific return window, item-condition requirements, and refund process. The error fires when the page is missing, behind a login, or so vague that the required signals can't be parsed.",
    steps: [
      {
        title: "Create a refund policy at /policies/refund-policy",
        body: "Shopify Admin → Settings → Policies → Refund policy → \"Create from template.\" Replace placeholders with your specifics.",
      },
      {
        title: "Include window, conditions, and process",
        body: "Window: \"30 days from delivery.\" Condition: \"unworn, with tags, in original packaging.\" Process: \"contact support@yourstore.com to initiate, ship at customer expense, refund issued to original payment method.\"",
      },
      {
        title: "Link from the footer",
        body: "Most Shopify themes auto-link policies in the footer. Verify in incognito. If missing, edit theme settings or `footer.liquid` to include the link.",
      },
      {
        title: "Verify accessible without login",
        body: "Open `https://yourstore.com/policies/refund-policy` signed out. Must load with full content, not redirect or fail.",
      },
    ],
    relatedFixes: ["missing-shipping-policy", "missing-contact-information"],
    relatedPosts: ["gmc-suspension-shopify-checklist"],
    keywords: [
      "missing refund policy shopify google",
      "google merchant center refund policy error",
      "shopify return policy gmc",
      "shopify refund policy template",
    ],
    faqs: [
      {
        question: "What must my refund policy include?",
        answer:
          "Three signals: a specific return window in days, item-condition requirements, and the refund process steps including how the refund is issued.",
      },
      {
        question: "Is \"all sales final\" a valid policy?",
        answer:
          "Allowed if disclosed clearly, but expect lower trust signals from Google and lower customer conversion. Most stores find a 14-30 day return window outperforms.",
      },
      {
        question: "Can I require customers to pay return shipping?",
        answer:
          "Yes if disclosed in the policy. Free returns are not required by Google's policy, disclosure of who pays is what matters.",
      },
      {
        question: "What about restocking fees?",
        answer:
          "Allowed but must be disclosed in the refund policy AND visibly on the product page. Restocking fees disclosed only in fine print trigger hidden-fee policy violations.",
      },
      {
        question: "How long until the policy fix clears the error?",
        answer:
          "7 days for Google's crawler to re-fetch the policy page. Then submit a re-review appeal if products were disapproved.",
      },
    ],
    outboundHelp: {
      label: "Google's return and refund policy requirements",
      url: "https://support.google.com/merchants/answer/10220442",
    },
  },
  {
    slug: "missing-contact-information",
    errorCode: "Missing contact information",
    title: "How to Fix \"Missing Contact Information\" on Shopify",
    description:
      "Fix the \"Missing contact information\" error on Shopify by adding email, phone, or address to your footer and contact page so Google's crawler can find them.",
    publishedAt: "2026-02-07",
    cause:
      "Google requires at least two of three contact methods to be publicly visible: domain email, phone number, and physical street address. The error fires when none are findable, typically because the footer doesn't include them and the contact page only has a contact form (which doesn't count).",
    steps: [
      {
        title: "Add a contact email to your footer",
        body: "Edit `footer.liquid` or theme settings to display a `mailto:` link. Use a real domain email (`support@yourstore.com`), Gmail or Outlook addresses don't count toward Google's threshold.",
      },
      {
        title: "Create a /pages/contact page with multiple methods",
        body: "Shopify Admin → Online Store → Pages → Add page. Include email, phone, address, and business hours. Link from main navigation, not just the footer.",
      },
      {
        title: "Ensure the email is monitored",
        body: "Google's crawler doesn't test if the email is monitored, but reviewers do. An unmonitored email that bounces or never responds can fail the appeal.",
      },
      {
        title: "Verify all methods work",
        body: "Send a test email. Call the phone number if listed. Confirm the address shows correctly on Google Maps. Each method must be functional.",
      },
    ],
    relatedFixes: ["missing-shipping-policy", "missing-refund-policy", "business-information-mismatch"],
    relatedPosts: ["gmc-suspension-shopify-checklist"],
    keywords: [
      "missing contact information shopify google",
      "google merchant center contact info error",
      "shopify contact page gmc",
      "shopify domain email gmc",
    ],
    faqs: [
      {
        question: "How many contact methods do I need?",
        answer:
          "At least two of three: domain email, phone number, physical street address. PO boxes and Gmail/Outlook addresses don't count toward the threshold.",
      },
      {
        question: "Is a contact form enough?",
        answer:
          "No. A contact form alone is treated as no contact disclosure because customers can't reach you outside the form.",
      },
      {
        question: "Where do contact methods need to appear?",
        answer:
          "Footer (every page) is required. Contact page linked from main navigation is also required. Both visible in incognito.",
      },
      {
        question: "Can I use a customer-service phone number that isn't a real local line?",
        answer:
          "Yes if the number is monitored. VoIP and customer-service lines are fine; numbers that go to dead voicemail or constantly disconnect fail review.",
      },
      {
        question: "Does Google verify the address?",
        answer:
          "Reviewers spot-check. Use a real street address. Some categories (regulated industries) require additional verification, but standard retail accepts a verified business address.",
      },
    ],
    outboundHelp: {
      label: "Google's misrepresentation policy",
      url: "https://support.google.com/merchants/answer/6150127",
    },
  },
  {
    slug: "missing-checkout-transparency",
    errorCode: "Missing checkout transparency",
    title: "How to Fix \"Missing Checkout Transparency\" Errors",
    description:
      "Fix \"Missing checkout transparency\" errors on Shopify by disclosing payment methods, shipping costs, and return windows pre-checkout.",
    publishedAt: "2026-02-12",
    cause:
      "Google's checkout transparency policy requires merchants to disclose accepted payment methods, return windows, contact info, and shipping costs before customers reach checkout. Most Shopify themes meet some but not all of these out of the box, and gaps cause disapprovals.",
    steps: [
      {
        title: "Show payment method logos in the footer",
        body: "Most modern Shopify themes (Dawn, etc.) include this section by default. Verify in your live footer. If missing, enable in theme settings or add the `payment-icons` Liquid include.",
      },
      {
        title: "Expose shipping costs on product or cart page",
        body: "Add a shipping calculator widget on the cart page, or a static \"$5.99 flat US shipping, free over $50\" notice on the product page. Footer-only disclosure isn't enough, costs must connect to the specific item being purchased.",
      },
      {
        title: "Show return window pre-checkout",
        body: "Add a \"30-day returns\" badge near the price, in an announcement bar, or in the cart page summary. Specific number of days is required, \"we accept returns\" without a number fails.",
      },
      {
        title: "Ensure contact info is visible",
        body: "Email and phone in the footer on every page. Contact page linked from main nav.",
      },
      {
        title: "Verify in incognito and submit appeal after 7 days",
        body: "Walk your store as a signed-out customer. Each disclosure must be visible without login. Wait 7 days for Google to recrawl, then appeal.",
      },
    ],
    relatedFixes: ["hidden-fees", "missing-shipping-policy", "missing-contact-information"],
    relatedPosts: ["google-shopping-checkout-transparency-shopify"],
    keywords: [
      "checkout transparency shopify google",
      "google merchant center checkout transparency error",
      "shopify pre-checkout disclosure gmc",
      "shopify payment method disclosure",
    ],
    faqs: [
      {
        question: "What four things must I disclose before checkout?",
        answer:
          "Payment methods (with logos visible), return window in specific days, contact methods (email/phone/address), and shipping costs (or a calculator).",
      },
      {
        question: "Is footer-only disclosure enough?",
        answer:
          "For payment methods and contact info, yes. For shipping costs and return windows, no, those need to appear on the product page or cart page where they connect to the specific purchase.",
      },
      {
        question: "Can I disclose shipping costs only on the cart page?",
        answer:
          "Acceptable if the cart shows costs before the customer enters checkout. Better to also show on product pages for higher-intent customers.",
      },
      {
        question: "What about EU/UK statutory rights?",
        answer:
          "Statutory return rights satisfy the disclosure if you cite the specific window. Don't rely on customer knowledge, name the 14-day window in your policy and pre-checkout.",
      },
      {
        question: "How long until disapprovals clear?",
        answer:
          "7 days for recrawl after fixes. Then submit an appeal naming the specific disclosures added.",
      },
    ],
    outboundHelp: {
      label: "Google's misrepresentation policy",
      url: "https://support.google.com/merchants/answer/6150127",
    },
  },
  {
    slug: "business-information-mismatch",
    errorCode: "Business information mismatch",
    title: "How to Fix Business Information Mismatch on Shopify",
    description:
      "Fix the \"Business information mismatch\" error by aligning your business name, address, and contact info across Shopify, Google Merchant Center, and Google Business Profile.",
    publishedAt: "2026-02-17",
    cause:
      "Google cross-references business identity across surfaces, Shopify settings, Merchant Center business information, Google Business Profile, and your storefront's About page. When the name, address, or contact info differs across these surfaces, Google treats the inconsistency as a misrepresentation signal.",
    steps: [
      {
        title: "Audit GMC settings vs Shopify settings",
        body: "GMC → Settings → Business information. Shopify Admin → Settings → Store details. The legal business name, address, and contact email should match exactly.",
      },
      {
        title: "Align with Google Business Profile if applicable",
        body: "If your business has a Google Business Profile (Maps listing), the name and address there must match GMC and Shopify. Mismatches across all three surfaces compound.",
      },
      {
        title: "Ensure store legal name matches WHOIS",
        body: "The domain registration's registrant name should match your store's legal name. WHOIS mismatches with the storefront's stated business identity are a flag.",
      },
      {
        title: "Update About page on the storefront",
        body: "Your `/pages/about-us` page should state the same legal name, founding date, and contact details as the rest of the surfaces. Inconsistency between your About page and your business settings is the most common version of this error.",
      },
    ],
    relatedFixes: ["missing-contact-information", "account-suspension-misrepresentation"],
    relatedPosts: ["gmc-suspension-reasons-shopify"],
    keywords: [
      "business information mismatch google",
      "google merchant center business identity",
      "shopify gmc business name mismatch",
      "google business profile shopify",
    ],
    faqs: [
      {
        question: "Where does Google check business information?",
        answer:
          "GMC business settings, Shopify store details, Google Business Profile, About page on the storefront, WHOIS registration, and any business directories Google indexes.",
      },
      {
        question: "Does my legal name need to match my brand name?",
        answer:
          "Acceptable if you trade as a different name (\"Acme Goods, a brand of Acme LLC\"). The legal entity name should appear consistently in all back-end settings.",
      },
      {
        question: "What if I just changed my business address?",
        answer:
          "Update all surfaces simultaneously: Shopify, GMC, Google Business Profile, About page. Allow 1-2 weeks for Google to reconcile across surfaces.",
      },
      {
        question: "Can I use a virtual mailbox as my address?",
        answer:
          "Allowed in many regions but flagged in some categories. A real business address is preferred. If using a virtual mailbox, ensure it accepts physical mail.",
      },
      {
        question: "Does WHOIS privacy hide my business identity?",
        answer:
          "Domain privacy is fine; the WHOIS registrant being a privacy service doesn't trigger the mismatch error. The mismatch error fires when the disclosed registrant differs from your stated business identity.",
      },
    ],
    outboundHelp: {
      label: "Google's misrepresentation policy",
      url: "https://support.google.com/merchants/answer/6150127",
    },
  },
  {
    slug: "account-suspension-misrepresentation",
    errorCode: "Account suspended for misrepresentation",
    title: "How to Recover from a Misrepresentation Account Suspension",
    description:
      "Step-by-step recovery from a Google Merchant Center account-level misrepresentation suspension. Identify the trigger, document fixes, submit a clean appeal.",
    publishedAt: "2026-02-22",
    cause:
      "An account-level misrepresentation suspension means Google's reviewers concluded your store violates the broader policy in a way that can't be isolated to specific products. Common sub-policies: self-misrepresentation (fake or unverifiable business info), product misrepresentation (false claims, hidden fees), or untrustworthy promotions.",
    steps: [
      {
        title: "Read the suspension email carefully",
        body: "The email cites a policy bucket but rarely names the specific issue. Note any URLs, products, or sub-policies referenced, those are your starting points.",
      },
      {
        title: "Identify which sub-policy applies",
        body: "Self-misrepresentation: business identity/contact info gaps. Product misrepresentation: feed-vs-page mismatches, hidden fees, false claims. Untrustworthy promotions: deceptive marketing.",
      },
      {
        title: "Audit all flagged areas",
        body: "Run a full compliance scan. Audit policy pages, contact info, feed-vs-page consistency, promotional content, and image hosting. The cause is almost always one of the issues in our compliance checklist.",
      },
      {
        title: "Document fixes with screenshots and dates",
        body: "Take dated screenshots of every change. Record exact dates of fixes. The appeal letter requires this documentation.",
      },
      {
        title: "Wait 7 days for recrawl",
        body: "Google's crawler needs time to re-index. Submitting before 7 days wastes the appeal, the reviewer sees your pre-fix state.",
      },
      {
        title: "Submit a detailed appeal",
        body: "Use the 5-paragraph appeal template: identify yourself, acknowledge the policy violated, list specific changes with dates, offer documentation, request re-review. Specificity is the difference between approval and rejection.",
      },
    ],
    relatedFixes: ["counterfeit-goods", "untrustworthy-promotions", "account-suspension-counterfeit"],
    relatedPosts: ["fix-gmc-misrepresentation-shopify-2026", "gmc-appeal-letter-template-shopify"],
    keywords: [
      "google merchant center account suspended misrepresentation",
      "shopify gmc account suspension recovery",
      "gmc misrepresentation appeal",
      "google shopping account suspended",
    ],
    faqs: [
      {
        question: "What's the difference between item-level and account-level misrepresentation?",
        answer:
          "Item-level affects specific products only. Account-level disapproves the entire account, halting all Shopping campaigns until reinstated.",
      },
      {
        question: "How long does account-level recovery take?",
        answer:
          "1-4 weeks for clean first appeals. 6-8 weeks for cases that go through multiple rejections. See the full timeline post for stage-by-stage breakdown.",
      },
      {
        question: "Should I make broad changes or targeted fixes?",
        answer:
          "Targeted. Reviewers respond better to specific identification + specific fixes than to wholesale catalog changes. Identify the trigger; fix only that; document precisely.",
      },
      {
        question: "What if Google rejects my appeal?",
        answer:
          "Read the rejection, it usually contains specific information the original suspension email omitted. Wait the cooldown period (7-14 days). Submit a revised appeal addressing the new specifics.",
      },
      {
        question: "Can I run Google Ads while suspended?",
        answer:
          "Yes for Search, Display, and YouTube. Shopping campaigns and Performance Max with feed components stop until reinstatement.",
      },
    ],
    outboundHelp: {
      label: "Google's misrepresentation policy",
      url: "https://support.google.com/merchants/answer/6150127",
    },
  },
  {
    slug: "account-suspension-counterfeit",
    errorCode: "Account suspended for counterfeit",
    title: "How to Recover from a Counterfeit Account Suspension",
    description:
      "Recover from a Google Merchant Center counterfeit suspension. Audit branding, document authentic sourcing, submit appeal with supplier invoices.",
    publishedAt: "2026-02-27",
    cause:
      "Account-wide counterfeit suspensions hit categories Google polices aggressively: fragrance, fashion, electronics, watches, jewelry. The trigger is typically brand names in titles without authorized-reseller status, manufacturer press-kit images used without permission, or \"inspired by\" framing across product descriptions.",
    steps: [
      {
        title: "Review the suspension reason",
        body: "The email cites \"counterfeit goods\" but rarely names the specific products. Note any sub-categories (fragrance, fashion, etc.), those narrow the audit.",
      },
      {
        title: "Audit titles for unauthorized brand names",
        body: "Export products CSV. Search Title column for any brand name. Flag any without documented authorization. Rewrite or remove.",
      },
      {
        title: "Pull supplier invoices proving authenticity",
        body: "Gather invoices, distributor agreements, authorization letters, and any documentation showing your products are genuinely sourced. This is the most-weighted appeal evidence.",
      },
      {
        title: "Rewrite descriptions to remove brand-comparison language",
        body: "Remove \"inspired by,\" \"alternative to,\" \"comparable to,\" \"dupe,\" \"replica.\" Describe products on their own merits.",
      },
      {
        title: "Remove products you can't verify",
        body: "If a SKU has no supplier documentation and contains brand language, remove it. Don't appeal with unverifiable products in the catalog, it weakens the entire appeal.",
      },
      {
        title: "Submit appeal with documentation",
        body: "Use the appeal template. Attach supplier invoices and authorization letters. Submit through Google Ads or Merchant Center support, counterfeit appeals can take 7-14 days.",
      },
    ],
    relatedFixes: ["counterfeit-goods", "account-suspension-misrepresentation"],
    relatedPosts: ["google-ads-counterfeit-shopify"],
    keywords: [
      "google merchant center account suspended counterfeit",
      "shopify counterfeit suspension recovery",
      "gmc counterfeit appeal",
      "google ads counterfeit shopify",
    ],
    faqs: [
      {
        question: "Which categories see counterfeit suspensions most?",
        answer:
          "Fragrance, designer fashion, watches, jewelry, electronics accessories. Anything where dupes and replicas are common in the broader market.",
      },
      {
        question: "What documentation should I submit with my appeal?",
        answer:
          "Supplier invoices, distributor agreements, authorized-reseller letters, and any communications with the brand directly. Multiple sources of authentication strengthen the appeal.",
      },
      {
        question: "Can I sell branded products without authorized-reseller status?",
        answer:
          "Some categories require it (luxury fragrance, watches). Others tolerate authentic resale with documentation. When in doubt, get authorization in writing.",
      },
      {
        question: "How long does a counterfeit appeal take?",
        answer:
          "7-14 business days typically. Longer than misrepresentation appeals because brand verification is involved.",
      },
      {
        question: "Should I appeal through GMC or Google Ads?",
        answer:
          "If the suspension is on the Merchant Center side, appeal through GMC. If Google Ads is also suspended, appeal there separately. The systems are separate.",
      },
    ],
    outboundHelp: {
      label: "Google Ads counterfeit goods policy",
      url: "https://support.google.com/adspolicy/answer/176017",
    },
  },
  {
    slug: "limited-performance-warning",
    errorCode: "Limited performance",
    title: "How to Fix \"Limited Performance\" Warnings in Merchant Center",
    description:
      "Fix \"Limited performance\" warnings on Shopify by completing identifier fields, improving title quality, and expanding product attributes.",
    publishedAt: "2026-03-04",
    cause:
      "Limited performance is a warning, not a suspension, products keep running but at reduced visibility. Common causes: missing identifiers (GTIN, brand, MPN), short or branded-only titles, sparse descriptions, and missing optional attributes (material, color, size, age group).",
    steps: [
      {
        title: "Populate all identifier fields",
        body: "Variant Barcode for GTIN, Vendor for brand, custom.mpn metafield for MPN. Each completed identifier improves catalog match confidence.",
      },
      {
        title: "Improve title quality",
        body: "Replace branded-only titles (\"Acme Hoodie\") with descriptive titles (\"Men's Black Cotton Hoodie by Acme, Slim Fit, Size M\"). Descriptive titles match more queries.",
      },
      {
        title: "Add complete product attributes",
        body: "Material, color, size, age group, pattern. Each attribute moves products from \"appears occasionally\" to \"appears reliably\" in Shopping.",
      },
      {
        title: "Expand descriptions to 200+ words",
        body: "Short descriptions correlate with limited performance. Expand to include use cases, materials, dimensions, and care instructions. AI Overviews favor factual, specific descriptions.",
      },
      {
        title: "Verify warning clears in 1-2 weeks",
        body: "Limited performance updates lag actual fixes by 1-2 weeks because Google needs traffic data to re-evaluate. Check GMC Diagnostics weekly.",
      },
    ],
    relatedFixes: ["missing-gtin", "missing-brand", "missing-mpn"],
    relatedPosts: ["missing-gtin-shopify-fix"],
    keywords: [
      "limited performance google merchant center",
      "google shopping limited performance warning",
      "shopify product visibility gmc",
      "gmc product attributes completeness",
    ],
    faqs: [
      {
        question: "Is limited performance a suspension?",
        answer:
          "No, it's a warning. Products keep running but at reduced visibility. Treat it as a leading indicator that catalog quality is hurting reach.",
      },
      {
        question: "How does Google decide \"limited performance\"?",
        answer:
          "Combination of completeness (which fields are populated) and traffic signals (impressions, clicks, conversions). Sparse catalogs and weak titles correlate strongly.",
      },
      {
        question: "Will fixing identifiers alone clear the warning?",
        answer:
          "Often yes, especially for new accounts. Mature accounts may also need title and description improvements to fully clear.",
      },
      {
        question: "How long until the warning clears after fixes?",
        answer:
          "1-2 weeks. The system needs traffic data to re-evaluate, which lags structural fixes.",
      },
      {
        question: "Does limited performance hurt rankings on the products that are running?",
        answer:
          "Yes. Affected products receive reduced impression share, especially on contested queries where competitors have more complete data.",
      },
    ],
    outboundHelp: {
      label: "Google's product data quality requirements",
      url: "https://support.google.com/merchants/answer/188494",
    },
  },
  {
    slug: "landing-page-not-working",
    errorCode: "Landing page not working",
    title: "How to Fix \"Landing Page Not Working\" Errors",
    description:
      "Fix \"Landing page not working\" errors on Shopify by checking robots.txt, server uptime, mobile rendering, and JavaScript-heavy themes that block Googlebot.",
    publishedAt: "2026-03-09",
    cause:
      "The error fires when Google's crawler can't successfully fetch your product page, 404 errors, slow timeouts, robots.txt blocks, Cloudflare bot challenges, broken redirects, or themes that render content client-side after Googlebot has given up. The crawler retries before flagging, so persistent issues are usually structural.",
    steps: [
      {
        title: "Verify URLs load in incognito",
        body: "Open the affected product URLs in a private/incognito window. They must return HTTP 200 with full content visible. Test on both desktop and mobile.",
      },
      {
        title: "Check robots.txt isn't blocking",
        body: "Open `https://yourstore.com/robots.txt`. Look for `Disallow: /products/`, `Disallow: /collections/`, or any rule blocking Googlebot. Each block kills Shopping eligibility for the affected paths.",
      },
      {
        title: "Check Cloudflare or CDN bot rules",
        body: "If proxied through Cloudflare, audit Bot Fight Mode and security rules. Aggressive settings can challenge Googlebot. Allow verified Google bots in Cloudflare's bot management.",
      },
      {
        title: "Verify mobile rendering",
        body: "Open a product URL in Chrome DevTools mobile emulation. The page should load fully without JavaScript errors. Themes that render content client-side after Googlebot has given up are a common silent failure.",
      },
      {
        title: "Force a feed re-crawl",
        body: "Sales channels → Google → Sync now. After fixes, force the channel to re-fetch the affected URLs.",
      },
    ],
    relatedFixes: ["products-not-showing", "missing-product-image"],
    relatedPosts: ["products-not-showing-google-shopping-shopify"],
    keywords: [
      "landing page not working google shopping",
      "shopify product page google crawler error",
      "google merchant center landing page error",
      "shopify googlebot blocked",
    ],
    faqs: [
      {
        question: "Why does Google say my landing page isn't working when it loads fine for me?",
        answer:
          "The crawler may be hitting a different rendering path than your browser. Common causes: Cloudflare bot challenges, robots.txt blocks, JavaScript-heavy themes, or 5xx errors during peak crawl times.",
      },
      {
        question: "How do I check what Googlebot sees?",
        answer:
          "Use Google Search Console → URL Inspection → Live Test. It shows exactly what Googlebot fetches when it requests your page.",
      },
      {
        question: "Will Cloudflare block Googlebot?",
        answer:
          "Aggressive Bot Fight Mode can. Configure Cloudflare to allow verified Google crawlers. Less aggressive settings (Super Bot Fight Mode with verified bots allowed) are usually safe.",
      },
      {
        question: "Can server downtime cause this error?",
        answer:
          "Yes. Persistent 5xx errors during the crawl window flag landing pages as not working. Check your server logs for Googlebot-specific 5xx responses.",
      },
      {
        question: "How long until errors clear after fixing?",
        answer:
          "24-72 hours after the crawler successfully re-fetches. Force a sync from the Google channel to speed up.",
      },
    ],
    outboundHelp: {
      label: "Google's landing page requirements",
      url: "https://support.google.com/merchants/answer/6098296",
    },
  },
  {
    slug: "feed-not-matching-website",
    errorCode: "Feed data does not match website",
    title: "How to Fix Feed-Site Mismatch Errors on Shopify",
    description:
      "Fix \"Feed data does not match website\" errors on Shopify by identifying the mismatching field, forcing feed re-sync, and verifying channel app version.",
    publishedAt: "2026-03-14",
    cause:
      "A catch-all error for any discrepancy between what your Google feed sends and what Google's crawler sees on your live storefront, price, availability, title, description, or image. Cause is usually one of: feed sync delay, third-party app modifying live storefront, theme rendering differently for Googlebot, or stale Google channel app version.",
    steps: [
      {
        title: "Identify the specific mismatching field",
        body: "GMC → Diagnostics → Item issues. The error often names the specific field (price, availability, image, title). That narrows the audit dramatically.",
      },
      {
        title: "Cross-check feed XML against the live page",
        body: "Sales channels → Google → preview feed (if available). Compare the flagged product's feed entry against the live product page state when viewed in incognito.",
      },
      {
        title: "Force a feed re-sync",
        body: "Sales channels → Google → Sync now. Republishes current Shopify state to GMC, resolving timing-related mismatches.",
      },
      {
        title: "Verify Google channel app version is current",
        body: "Outdated channel app versions sometimes send legacy feed shapes that don't match Google's current expectations. Update the app via the Shopify App Store.",
      },
      {
        title: "Submit a re-review after 24-72 hours",
        body: "Wait for re-sync, verify Diagnostics has cleared, then submit a re-review through GMC if products were disapproved.",
      },
    ],
    relatedFixes: ["price-mismatch", "availability-mismatch", "missing-product-image"],
    relatedPosts: ["products-not-showing-google-shopping-shopify"],
    keywords: [
      "feed data does not match website google",
      "shopify feed site mismatch gmc",
      "google merchant center feed mismatch",
      "shopify google channel sync error",
    ],
    faqs: [
      {
        question: "What does \"feed data does not match website\" mean specifically?",
        answer:
          "Any discrepancy between your feed and the live page Google's crawler fetched. The most common are price and availability; less common are title, description, or image.",
      },
      {
        question: "How do I know which field is mismatching?",
        answer:
          "GMC → Diagnostics → Item issues. The error usually names the specific field. If not, use the Google channel app's feed preview against your live product page.",
      },
      {
        question: "Why would feed and site differ if I haven't changed anything?",
        answer:
          "Third-party apps (currency, member pricing, urgency banners), scheduled discounts, or inventory app sync delays. Audit installed apps for any that modify the live storefront.",
      },
      {
        question: "Does this error affect rankings or just disapprove products?",
        answer:
          "Disapproves the affected products. Other products keep running normally. Persistent mismatch can escalate to limited performance or misrepresentation.",
      },
      {
        question: "How long until the error clears?",
        answer:
          "24-72 hours for feed re-sync. If structural (app behavior or theme issue), the error returns until the cause is fixed.",
      },
    ],
    outboundHelp: {
      label: "Google's feed quality documentation",
      url: "https://support.google.com/merchants/answer/7052112",
    },
  },
  {
    slug: "variants-not-matching-feed",
    errorCode: "Variant data inconsistency",
    title: "How to Fix Variant Data Inconsistency Errors",
    description:
      "Fix variant-level data inconsistency on Shopify by auditing variant identifiers, standardizing size/color values, and ensuring feed includes all variants.",
    publishedAt: "2026-03-19",
    cause:
      "Variant data inconsistency fires when variant-level fields (price, availability, GTIN, size, color) don't match what the feed sends, or when variants don't match Google's expected taxonomy. Most often: GTINs populated at product level but not variant level, size attributes using \"Small/Medium/Large\" instead of S/M/L, or color names spelled inconsistently across variants.",
    steps: [
      {
        title: "Audit variant-level identifier coverage",
        body: "Open affected products → Variants → check Barcode (GTIN) for each. Product-level identifiers don't fall through to variants, populate per variant.",
      },
      {
        title: "Standardize size and color values",
        body: "Size: use Google's expected codes (XS, S, M, L, XL) instead of \"Small/Medium/Large.\" Color: normalize spellings to one canonical name per color across the entire catalog.",
      },
      {
        title: "Ensure the feed includes every variant",
        body: "Some Google channel app versions skip variants under specific conditions. Verify in the feed preview that all variants appear with their own price and availability.",
      },
      {
        title: "Verify each variant page renders correctly",
        body: "Open a product page, click through each variant, view source. The page state (URL, JSON-LD, meta) must update on variant selection. Themes that don't update on variant selection cause silent inconsistencies.",
      },
      {
        title: "Force a feed re-sync",
        body: "Sales channels → Google → Sync now. Then verify in GMC Diagnostics after 24-72 hours.",
      },
    ],
    relatedFixes: ["price-mismatch", "availability-mismatch", "missing-gtin"],
    relatedPosts: ["shopify-variants-not-matching-google-feed"],
    keywords: [
      "shopify variant data inconsistency google",
      "shopify variants google merchant center",
      "shopify variant gtin gmc",
      "shopify size color attribute google",
    ],
    faqs: [
      {
        question: "Do all variants need their own GTIN?",
        answer:
          "If they have different manufacturer SKUs (red small T-shirt vs blue large T-shirt), yes. Pasting the same GTIN across variants gets flagged as duplicate listings.",
      },
      {
        question: "What size codes does Google expect?",
        answer:
          "XS, S, M, L, XL, XXL for letter-based. Numeric ranges (28, 30, 32) for waist sizes. \"Small,\" \"Medium,\" \"Large\" work but with lower catalog match confidence.",
      },
      {
        question: "Why are some variants missing from my feed?",
        answer:
          "Channel app version, sales-channel availability per variant, or inventory location issues. Verify each variant has the Google channel enabled and inventory available.",
      },
      {
        question: "What if my theme doesn't update the page on variant selection?",
        answer:
          "Most modern themes (Dawn, etc.) handle this. Older custom themes sometimes don't. Either upgrade the theme or have a developer add proper variant-state management.",
      },
      {
        question: "How long until variant fixes propagate?",
        answer:
          "24-72 hours for the Google channel to re-sync, plus another 24 hours for GMC Diagnostics to refresh.",
      },
    ],
    outboundHelp: {
      label: "Google's variant attribute specification",
      url: "https://support.google.com/merchants/answer/6324507",
    },
  },
  {
    slug: "products-not-showing",
    errorCode: "Products not showing in search",
    title: "How to Fix Shopify Products Not Showing in Google Shopping",
    description:
      "Fix Shopify products that pass GMC diagnostics but don't appear in Google Shopping, sync delays, weak titles, account quality, crawler access, schema gaps.",
    publishedAt: "2026-03-24",
    cause:
      "Products can pass feed sync and catalog matching but silently fail the third stage, ranking, which has no GMC diagnostic surface. Five common buckets: feed sync delay, branded-only titles that don't match many queries, low account quality (new store, sparse reviews), crawler access blocks (robots.txt, Cloudflare), and missing product schema.",
    steps: [
      {
        title: "Wait minimum 72h for new products to appear",
        body: "New products take 24-72 hours for feed sync, plus another 1-3 weeks for full Google indexing. Don't troubleshoot until 4+ weeks have passed for new products.",
      },
      {
        title: "Rewrite titles for descriptive language",
        body: "\"Acme Hoodie\" matches one query. \"Men's Black Cotton Hoodie by Acme, Slim Fit, Size M\" matches dozens. Bulk rewrite the top 50 products by traffic first.",
      },
      {
        title: "Verify robots.txt allows Googlebot",
        body: "Open `https://yourstore.com/robots.txt`. Look for any rule that blocks Googlebot from `/products/` or `/collections/`. Remove blocks unless you have a specific reason.",
      },
      {
        title: "Complete JSON-LD schema",
        body: "Add merchant listings extensions (gtin, brand, mpn, material, color, size) to your product JSON-LD. Most Shopify themes ship basic Product schema but skip these.",
      },
      {
        title: "Check account age and trust signals",
        body: "New accounts (< 6 months) and low-traffic stores have lower default visibility. Build organic traffic, accumulate reviews, age the account. Slow but real.",
      },
    ],
    relatedFixes: ["landing-page-not-working", "feed-not-matching-website", "limited-performance-warning"],
    relatedPosts: ["products-not-showing-google-shopping-shopify"],
    keywords: [
      "shopify products not showing google shopping",
      "google shopping not displaying products",
      "shopify gmc clean diagnostics no traffic",
      "shopify product visibility google",
    ],
    faqs: [
      {
        question: "Why are my products in GMC but not in Google Shopping?",
        answer:
          "Three steps separate \"in GMC\" from \"in Shopping\": feed sync, catalog matching, ranking. Products can pass the first two and silently fail ranking.",
      },
      {
        question: "How long should I wait before troubleshooting?",
        answer:
          "4+ weeks for new products. Below that, just wait, feed sync and Google indexing both take time.",
      },
      {
        question: "Does title quality really matter that much?",
        answer:
          "Yes. Descriptive titles get 5-10x the impressions of branded-only titles. The single biggest fix in terms of visibility delta.",
      },
      {
        question: "Can robots.txt blocks cause this?",
        answer:
          "Yes, and frequently. Audit your robots.txt for any rule blocking `/products/` or `/collections/` from Googlebot.",
      },
      {
        question: "What about Performance Max campaigns?",
        answer:
          "Performance Max can pay for impressions on products that don't rank organically, but it doesn't fix the underlying issue. Fix structural items first.",
      },
    ],
    outboundHelp: {
      label: "Google's Shopping ads policies",
      url: "https://support.google.com/merchants/answer/6149970",
    },
  },
  {
    slug: "google-ads-suspension",
    errorCode: "Google Ads account suspended",
    title: "How to Fix Google Ads Suspension When GMC Is Fine",
    description:
      "Fix Google Ads suspension on Shopify when Merchant Center is unaffected. Audit titles, descriptions, images for trademark and counterfeit policy violations.",
    publishedAt: "2026-03-29",
    cause:
      "Google Ads enforces a wider policy than GMC, counterfeit, trademark, restricted services. A clean GMC review doesn't mean a clean Ads review. Common pattern: the same store passes Merchant Center product review but fails Ads policy review on titles, descriptions, blog content, or alt text containing brand names.",
    steps: [
      {
        title: "Read the Ads suspension email separately from any GMC notice",
        body: "Ads and GMC are separate enforcement systems. The Ads email cites a different policy bucket than any concurrent GMC issue.",
      },
      {
        title: "Check for trademark or counterfeit policy issues",
        body: "Audit product titles for unauthorized brand names. Search descriptions for \"inspired by,\" \"alternative to,\" \"comparable to\" framing.",
      },
      {
        title: "Audit titles, descriptions, and images",
        body: "Export products CSV. Search for trigger phrases. Cross-check images for manufacturer press-kit usage.",
      },
      {
        title: "Audit old blog content",
        body: "Use site search: `site:yourstore.com \"dupe\"` and similar trigger queries. Old blog posts that mention \"best dupes\" or \"alternatives to [brand]\" trigger the policy too.",
      },
      {
        title: "Submit an Ads-specific appeal (not GMC)",
        body: "Help section in Google Ads → Contact us → Policy → submit appeal with supplier invoices proving authentic sourcing.",
      },
      {
        title: "Wait 7-21 days for Ads review",
        body: "Ads reviews take longer than GMC because brand verification is involved. Don't submit duplicate appeals.",
      },
    ],
    relatedFixes: ["counterfeit-goods", "account-suspension-counterfeit"],
    relatedPosts: ["google-ads-counterfeit-shopify"],
    keywords: [
      "google ads suspended gmc fine shopify",
      "google ads counterfeit suspension shopify",
      "shopify google ads policy violation",
      "google ads trademark suspension",
    ],
    faqs: [
      {
        question: "Why is my Google Ads suspended when GMC is fine?",
        answer:
          "Different enforcement systems with different scope. Ads scans more surfaces (titles, descriptions, blog content, alt text, customer reviews) and enforces counterfeit policy more aggressively than GMC.",
      },
      {
        question: "How do I appeal a Google Ads suspension?",
        answer:
          "Through Google Ads support, not GMC. Help section in the Ads UI → Contact us → Policy → submit appeal with documentation.",
      },
      {
        question: "What documentation strengthens an Ads appeal?",
        answer:
          "Supplier invoices, distributor agreements, brand authorization letters, and dated screenshots of any changes made to titles or descriptions.",
      },
      {
        question: "How long does Ads review take?",
        answer:
          "7-21 business days typically. Longer than GMC appeals because brand verification is involved.",
      },
      {
        question: "Can I run other Google Ads while suspended?",
        answer:
          "Account-level suspensions stop all Ads campaigns. Product-level Shopping disapprovals affect only Shopping; Search and Display continue.",
      },
    ],
    outboundHelp: {
      label: "Google Ads counterfeit goods policy",
      url: "https://support.google.com/adspolicy/answer/176017",
    },
  },
  {
    slug: "missing-tax-information",
    errorCode: "Missing tax information",
    title: "How to Fix \"Missing Tax Information\" Errors",
    description:
      "Fix the \"Missing tax information\" error in Google Merchant Center on Shopify by configuring per-state tax rules in GMC settings.",
    publishedAt: "2026-04-03",
    cause:
      "For US merchants, Google Merchant Center requires tax setup per state where you have nexus. Missing or incomplete configuration causes feed disapprovals on affected products. Non-US merchants see this less often because most regions use tax-inclusive pricing that doesn't require GMC tax setup.",
    steps: [
      {
        title: "Configure tax in GMC settings",
        body: "GMC → Settings → Tax. Add every US state where you have nexus. Use \"Custom\" rates if Shopify charges per-state rates that differ from Google's defaults.",
      },
      {
        title: "Match GMC settings to Shopify tax configuration",
        body: "Shopify Admin → Settings → Taxes and duties. The states configured in Shopify should match the states configured in GMC. Mismatches cause disapproval.",
      },
      {
        title: "For international, set destination-based tax rules",
        body: "EU/UK/Canada merchants typically use tax-inclusive pricing on the storefront. Configure GMC's tax setting to \"Tax included in product price\" for those regions.",
      },
      {
        title: "Verify after re-sync",
        body: "Wait 24-72h. GMC Diagnostics → Item issues. Tax errors should clear. If they persist, recheck your state-by-state coverage in GMC settings.",
      },
    ],
    relatedFixes: ["missing-shipping-policy", "missing-checkout-transparency"],
    relatedPosts: ["gmc-suspension-shopify-checklist"],
    keywords: [
      "missing tax information google merchant center",
      "shopify gmc tax setup",
      "google merchant center us state tax",
      "shopify google channel tax error",
    ],
    faqs: [
      {
        question: "Do all US merchants need to configure GMC tax?",
        answer:
          "Yes if selling to US customers. Configure every state where you have nexus. Failure to configure causes feed disapproval for affected products.",
      },
      {
        question: "What about EU/UK merchants?",
        answer:
          "Most EU/UK regions require tax-inclusive pricing. Set GMC's tax setting to \"included in product price\" rather than configuring per-jurisdiction rates.",
      },
      {
        question: "Should GMC tax rates match Shopify's?",
        answer:
          "Yes. Discrepancies between what Shopify charges at checkout and what GMC sends cause price mismatches in addition to the tax error.",
      },
      {
        question: "What if my nexus changes?",
        answer:
          "Update both Shopify and GMC simultaneously. Wait 24-72h for re-sync.",
      },
      {
        question: "Does tax setup affect shipping configuration?",
        answer:
          "Separate settings, but both must be configured. Missing shipping setup or missing tax setup each cause disapprovals.",
      },
    ],
    outboundHelp: {
      label: "Google's US tax configuration help",
      url: "https://support.google.com/merchants/answer/6324470",
    },
  },
  {
    slug: "insufficient-product-data",
    errorCode: "Insufficient product data",
    title: "How to Fix \"Insufficient Product Data\" Errors",
    description:
      "Fix the \"Insufficient product data\" error on Shopify by populating GTIN, brand, condition, and category attributes simultaneously across affected products.",
    publishedAt: "2026-04-08",
    cause:
      "Insufficient product data fires when multiple required attributes are missing simultaneously, usually GTIN, brand, condition, and clear product category. The error is account-impactful: products are disapproved and the broader account quality signal drops.",
    steps: [
      {
        title: "Identify all missing attributes per product",
        body: "Export products CSV. Audit each row for empty Vendor (brand), empty Variant Barcode (GTIN), missing condition metafield, and unclear product category.",
      },
      {
        title: "Populate in priority order, identifiers first",
        body: "Start with GTIN (most-weighted), then brand (second-most), then MPN as fallback. Condition third. Each populated identifier improves catalog match confidence.",
      },
      {
        title: "Use bulk metafields for condition and brand overrides",
        body: "Create `google.condition` and `custom.brand` metafield definitions. Bulk-populate via Matrixify. Pair with global defaults in the Google channel settings as fallbacks.",
      },
      {
        title: "Force a feed re-sync",
        body: "Sales channels → Google → Sync now. Republishes the populated data to GMC.",
      },
      {
        title: "Verify after 24-72 hours",
        body: "GMC → Diagnostics → Item issues. Insufficient-data errors should clear on products with newly-populated attributes.",
      },
    ],
    relatedFixes: ["missing-gtin", "missing-brand", "condition-not-declared", "limited-performance-warning"],
    relatedPosts: ["missing-gtin-shopify-fix"],
    keywords: [
      "insufficient product data google",
      "shopify gmc insufficient data error",
      "google merchant center missing attributes",
      "shopify product data completeness",
    ],
    faqs: [
      {
        question: "Which attributes does Google consider \"required\"?",
        answer:
          "Title, description, link, image, price, availability, GTIN (or MPN+brand or identifier_exists=false), brand, and condition. Missing any combination of these fires insufficient-data.",
      },
      {
        question: "Should I prioritize one attribute over another?",
        answer:
          "Identifiers first (GTIN, MPN, brand), they're highest-weighted. Condition second. Category third.",
      },
      {
        question: "What if my product genuinely lacks some attributes?",
        answer:
          "Use `identifier_exists=false` for products without GTIN/MPN/brand. Use a default condition of `new` if your store sells only new items. Don't fabricate values.",
      },
      {
        question: "Will fixing this clear limited-performance warnings too?",
        answer:
          "Often. Limited performance warnings often share underlying causes with insufficient-data errors. Fixing identifiers usually clears both.",
      },
      {
        question: "How long until the error clears?",
        answer:
          "24-72 hours for feed re-sync, plus 24 hours for Diagnostics to refresh. Total 1-3 business days.",
      },
    ],
    outboundHelp: {
      label: "Google's product data quality requirements",
      url: "https://support.google.com/merchants/answer/188494",
    },
  },
];

/** Lookup helper used by the route loader. */
export function getFixBySlug(slug: string): Fix | undefined {
  return FIXES.find((f) => f.slug === slug);
}
