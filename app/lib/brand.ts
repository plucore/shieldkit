/**
 * app/lib/brand.ts
 *
 * Brand tokens for the ShieldKit marketing site (public-facing pages).
 * The embedded admin app under /app/* keeps Polaris styling and does NOT
 * use these tokens.
 */

export const BRAND = {
  colors: {
    bgGradientFrom: "#dceaf5",
    bgGradientTo: "#b8d4e8",
    navy: "#0f1f3d",
    green: "#2e9c5b",
    red: "#d63b3b",
    amber: "#f4a14a",
    white: "#ffffff",
    grayText: "#5b6779",
    cardBorder: "#e1e8ef",
  },
  fonts: { sans: '"Inter", system-ui, -apple-system, sans-serif' },
  shadows: { card: "0 4px 12px rgba(15, 31, 61, 0.08)" },
} as const;

export const SITE = {
  url: "https://shieldkit.vercel.app",
  name: "ShieldKit",
  tagline: "GMC compliance for Shopify",
  ogImage: "/og-default.png",
  installUrl: "https://apps.shopify.com/shieldkit",
} as const;
