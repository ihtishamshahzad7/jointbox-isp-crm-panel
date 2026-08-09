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
  // An explicit override always wins (set NEXT_PUBLIC_BACKEND_URL at build time).
  if (process.env.NEXT_PUBLIC_BACKEND_URL) return process.env.NEXT_PUBLIC_BACKEND_URL;

  // Server-side rendering: no window, talk to the backend on the loopback.
  if (typeof window === "undefined") return "http://localhost:3001";

  // Served over HTTPS → same-origin, proxied. Never cross-protocol.
  if (window.location.protocol === "https:") return `${window.location.origin}/api`;

  // Plain HTTP (LAN / direct IP, no TLS yet) → the backend port directly.
  return `http://${window.location.hostname}:3001`;
}

const API_BASE = resolveApiBase();

export default API_BASE;
export { resolveApiBase };
