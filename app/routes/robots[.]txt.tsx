import { SITE } from "../lib/brand";

/**
 * /robots.txt — allow all marketing crawlers; explicitly block embedded
 * admin paths and API endpoints.
 */
export async function loader() {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /app",
    "Disallow: /app/",
    "Disallow: /api/",
    "Disallow: /auth/",
    "Disallow: /webhooks/",
    "",
    `Sitemap: ${SITE.url}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
