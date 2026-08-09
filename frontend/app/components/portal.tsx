"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Portal — render children as a direct child of <body>, not where they sit in
 * the tree.
 *
 * WHY MODALS KEEP HIDING UNDER THE SIDEBAR
 * A `position: fixed` overlay is only fixed to the VIEWPORT if none of its
 * ancestors has a transform, filter, or its own stacking context. The
 * subscriber dialog lives deep inside the page, under the shell wrapper, so
 * every attempt to lift it with z-index fought the shell and lost — the dialog
 * was sealed inside the page's layer. Moving it to <body> removes every one of
 * those ancestors at once, so `inset: 0; z-index: N` finally means the whole
 * screen, above everything. This is the standard way to render a modal, and it
 * ends the recurring "trapped under the sidebar" bug for good.
 */
export default function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
