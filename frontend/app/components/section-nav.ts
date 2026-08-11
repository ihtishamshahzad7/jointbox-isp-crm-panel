"use client";

/**
 * A tiny store so the mobile bottom bar can show the CURRENT section's tabs
 * instead of the same global menu everywhere.
 *
 * On a phone, "where can I go from here" matters more than "where can I go in
 * the whole app". A hub page (Network, Billing, My Work…) publishes its tabs
 * here; the bottom bar renders them so a NAS screen shows NAS tabs and a
 * billing screen shows billing tabs. When no hub is mounted, the bar falls
 * back to the four top-level destinations.
 *
 * Deliberately a plain pub/sub, not React context: the publisher (Hub) and the
 * subscriber (BottomNav) live in different branches of the tree, and a context
 * would force a shared provider around both.
 */

export type SectionTab = { id: string; label: string };
export type Section = { basePath: string; tabs: SectionTab[]; activeId?: string } | null;

let current: Section = null;
const listeners = new Set<(s: Section) => void>();

export function publishSection(s: Section) {
  current = s;
  listeners.forEach((fn) => fn(current));
}

export function clearSection(basePath?: string) {
  // Only clear if we still own it — avoids a just-mounted hub being wiped by an
  // unmounting one during a route change.
  if (!basePath || current?.basePath === basePath) {
    current = null;
    listeners.forEach((fn) => fn(current));
  }
}

export function getSection(): Section {
  return current;
}

export function subscribeSection(fn: (s: Section) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
