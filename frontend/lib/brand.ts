/**
 * WHITE-LABEL BRAND CONFIG
 *
 * Every piece of user-facing identity in the panel resolves through this one
 * module, so a deployment can ship under ANY company name without touching
 * code. Set these in the frontend .env to rebrand:
 *
 *   NEXT_PUBLIC_BRAND_NAME        → the product/company name (sidebar, login, landing)
 *   NEXT_PUBLIC_BRAND_SUBTITLE    → one-line descriptor under the mark
 *   NEXT_PUBLIC_SUPPORT_EMAIL     → "Need help?" mailto on login + landing
 *   NEXT_PUBLIC_PRODUCT_TAGLINE   → hero line on the public landing page
 *
 * All values are NEXT_PUBLIC_* so they are inlined at build time and work in
 * both server components (metadata) and client components. The defaults keep
 * the original "Jointbox" identity, so an unconfigured build looks unchanged.
 */

export const BRAND = {
  /** Company / product name shown in the shell, login, and landing footer. */
  name: process.env.NEXT_PUBLIC_BRAND_NAME || "Jointbox",
  /** Short descriptor below the logo mark. */
  subtitle: process.env.NEXT_PUBLIC_BRAND_SUBTITLE || "ISP Management",
  /** Fallback support inbox for "Need help?" links. */
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "ehtisham@jointbox.net",
  /** Hero headline for the public landing page. */
  tagline: process.env.NEXT_PUBLIC_PRODUCT_TAGLINE || "",
} as const;

/** <title> for the document, e.g. "Jointbox — ISP Management". */
export const DOC_TITLE = `${BRAND.name} — ${BRAND.subtitle}`;