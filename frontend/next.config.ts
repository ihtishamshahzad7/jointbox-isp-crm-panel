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

  /**
   * SAME-ORIGIN API PROXY — this is what lets the panel work on any address.
   *
   * THE BUG IT FIXES
   * `NEXT_PUBLIC_BACKEND_URL` is compiled into the JS bundle at BUILD time, so
   * whatever address it names is the address every browser is told to call —
   * forever, from everywhere. install.sh writes the server's own LAN IP, which
   * is correct on the LAN and unreachable from anywhere else. Reaching the
   * panel over a public IP therefore loads the page from port 3000 and then
   * fails every API call against a private 10.x address the browser cannot
   * route to. The symptom is exactly this: the login screen appears, and
   * signing in says "unable to connect".
   *
   * With this rewrite the browser only ever talks to the origin it loaded the
   * page from, and Next forwards to the backend over the loopback. One NAT
   * rule, one open port, and the same build works on a LAN IP, a public IP, a
   * hostname, HTTP or HTTPS, with no rebuild.
   *
   * 127.0.0.1 deliberately, not the LAN IP: the hop is inside the box, so it
   * neither leaves the host nor depends on the host knowing its own address.
   *
   * The backend sets no global prefix, so `/api` is stripped here —
   * /api/auth/login reaches the backend as /auth/login.
   */
  async rewrites() {
    const backend = process.env.BACKEND_ORIGIN || "http://127.0.0.1:3001";
    return [{ source: "/api/:path*", destination: `${backend}/:path*` }];
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
