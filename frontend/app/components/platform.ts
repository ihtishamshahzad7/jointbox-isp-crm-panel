/**
 * The platform account (SUPER_ADMIN) runs the panel, not a business: it
 * manages companies, the licence, the server and the defaults companies start
 * from. It never sees subscribers, routers or billing — the backend refuses
 * those routes, and the panel never offers them. To help a client, it signs
 * in AS the company (Companies → Sign in).
 */

/** Screens the platform account can open. Everything else sends it to Companies. */
export const PLATFORM_PATHS = [
  "/companies",
  "/licence",
  "/communication",
  "/packages/taxes",
  "/packages/policies",
  "/packages/allocations",
  "/settings",
  "/security",
  "/jobs",
  "/console",
  "/radius-admin",
  "/docs",
  "/my-profile",
  "/change-password",
];

export const PLATFORM_HOME = "/companies";

/** Screens only the platform account has; a company is sent to its dashboard. */
export const PLATFORM_ONLY_PATHS = ["/companies", "/licence", "/console", "/radius-admin"];

export function isPlatformOnlyPath(path: string): boolean {
  const p = (path || "").split("?")[0];
  return PLATFORM_ONLY_PATHS.some((x) => p === x || p.startsWith(`${x}/`));
}

export function tokenPayload(): Record<string, any> | null {
  try {
    if (typeof window === "undefined") return null;
    const t = localStorage.getItem("token");
    if (!t) return null;
    return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/** Signed in as the platform account itself (not acting as a company). */
export function isPlatformSession(): boolean {
  return tokenPayload()?.role === "SUPER_ADMIN";
}

export function isPlatformPath(path: string): boolean {
  const p = (path || "").split("?")[0];
  return PLATFORM_PATHS.some((x) => p === x || p.startsWith(`${x}/`));
}
