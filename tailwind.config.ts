import type { Config } from "tailwindcss";

export default {
  // Scope tailwind classes to marketing-related files. The embedded app under
  // /app/* uses Polaris and is intentionally excluded so we don't poison
  // existing styles.
  content: [
    "./app/components/marketing/**/*.{ts,tsx}",
    "./app/routes/_index/**/*.{ts,tsx}",
    "./app/routes/scan*.{ts,tsx}",
    "./app/routes/scan/**/*.{ts,tsx}",
    "./app/routes/explainer*.{ts,tsx}",
    "./app/routes/explainer/**/*.{ts,tsx}",
    "./app/routes/blog*.{ts,tsx}",
    "./app/routes/blog/**/*.{ts,tsx}",
    "./app/content/blog/**/*.{md,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          "bg-from": "#dceaf5",
          "bg-to": "#b8d4e8",
          navy: "#0f1f3d",
          green: "#2e9c5b",
          red: "#d63b3b",
          amber: "#f4a14a",
          "gray-text": "#5b6779",
          "card-border": "#e1e8ef",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 4px 12px rgba(15, 31, 61, 0.08)",
      },
      maxWidth: {
        prose: "720px",
      },
    },
  },
  plugins: [],
} satisfies Config;
