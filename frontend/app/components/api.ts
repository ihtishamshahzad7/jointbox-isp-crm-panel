/**
 * The one place that decides where API calls go.
 *
 * WHY THIS MATTERS UNDER HTTPS
 * Every screen used to build its own `http://<host>:3001`. That is fine on a
 * plain-HTTP LAN install and fatal the moment the panel is served over HTTPS:
 * a secure page is not allowed to call an insecure URL, so the browser blocks
 * every single request as mixed content and the panel looks completely dead —
 * no error, no data, just empty screens.
 *
 * So when the page is secure we send API calls to a same-origin `/api` path
 * and let the TLS terminator forward them to the backend. That also means only
 * 80/443 ever need to be open to the internet; port 3001 can stay firewalled.
 *
 * Plain-HTTP installs are unaffected — they keep talking to :3001 exactly as
 * before, so upgrading a server does not require touching any client.
 */
function resolveApiBase(): string {
  const override = process.env.NEXT_PUBLIC_BACKEND_URL;

  // Server-side rendering: no window, talk to the backend on the loopback.
  if (typeof window === "undefined") return override || "http://localhost:3001";

  const secure = window.location.protocol === "https:";

  if (override) {
    /**
     * An override normally wins — but NOT when it would break the page.
     *
     * install.sh writes NEXT_PUBLIC_BACKEND_URL=http://<ip>:3001 at install
     * time. Turn on TLS later and that value silently kills the whole panel:
     * an https page may not call http, so every request is blocked as mixed
     * content and the user sees empty screens with no error. Ignoring a
     * plain-http override on a secure page is always the right call — the
     * same-origin proxy below reaches the same backend anyway.
     */
    if (secure && override.startsWith("http://")) {
      return `${window.location.origin}/api`;
    }
    /**
     * Third trap, and the one that actually bit a customer: the override names
     * a PRIVATE address (install.sh writes the server's own LAN IP) and the
     * panel is then reached through NAT from outside. The bundle tells every
     * browser on the internet to call 10.x.x.x:3001, which it cannot route to,
     * so the login page renders and signing in fails.
     *
     * If the override points somewhere OTHER than the origin the page was
     * served from, the same-origin proxy is the safer answer: it is reachable
     * by definition, because the page itself just came through it.
     */
    try {
      const u = new URL(override, window.location.origin);
      if (u.host !== window.location.host) {
        return `${window.location.origin}/api`;
      }
    } catch { /* unparsable — fall through */ }
    /**
     * Second trap: someone sets the override to the site root
     * (https://<ip>) instead of https://<ip>/api. Requests then land on the
     * frontend and 404. If the override points at THIS origin with no path
     * of its own, add the /api prefix the proxy expects.
     */
    try {
      const u = new URL(override, window.location.origin);
      if (u.origin === window.location.origin && (u.pathname === "" || u.pathname === "/")) {
        return `${window.location.origin}/api`;
      }
    } catch { /* not a parsable URL — fall through and use it as given */ }
    return override.replace(/\/+$/, "");
  }

  // Served over HTTPS → same-origin, proxied. Never cross-protocol.
  if (secure) return `${window.location.origin}/api`;

  /**
   * Plain HTTP → the same-origin proxy, NOT the backend port.
   *
   * This used to return `http://<hostname>:3001`, which works on a LAN and
   * breaks the moment the panel is reached through NAT: the browser can get to
   * the panel's port because that is the one forwarded, and nothing else. The
   * page loads and every API call fails.
   *
   * `/api` is rewritten to the backend inside next.config.ts, so it needs no
   * second port, no second NAT rule, and no CORS — the request never leaves
   * the origin the page came from.
   */
  return `${window.location.origin}/api`;
}

const API_BASE = resolveApiBase();

export default API_BASE;
export { resolveApiBase };
