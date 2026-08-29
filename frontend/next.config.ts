import type { NextConfig } from "next";

// Pin the project root to the frontend dir. The stray root package-lock.json was
// removed from the repo, so Next now infers this folder correctly; we still set
// the root explicitly to keep standalone tracing scoped and silence the warning.
const ROOT = process.cwd();

const nextConfig: NextConfig = {
  turbopack: {
    root: ROOT,
  },
  outputFileTracingRoot: ROOT,
  poweredByHeader: false,
  reactStrictMode: true,

  // Prevent an ISP operator's browser/proxy from keeping the old prerendered
  // application shell after a deployment. Next's hashed JS/CSS assets remain
  // safely cacheable; only application HTML is revalidated on every visit.
  async headers() {
    return [
      {
        source: "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, proxy-revalidate" },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
    ];
  },

  // NOTE: standalone output was reverted — its first deploy failed to serve
  // /_next/static chunks, leaving the UI stuck on "Loading…". We run the normal
  // `next start` (see ecosystem.config.js) which serves everything reliably.
  // Re-enable output:"standalone" only after verifying static serving end-to-end.
  allowedDevOrigins: ["192.168.51.253"],

  // Do not fail the PRODUCTION BUILD on type/lint errors.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
