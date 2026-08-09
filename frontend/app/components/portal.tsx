"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Portal — render children as a direct child of <body>.
 *
 * WHY MODALS KEEP HIDING UNDER THE HEADER
 * A `position: fixed` box is only fixed to the VIEWPORT when no ancestor has a
 * transform, filter, backdrop-filter, or its own stacking context. The shell
 * has several of those (the topbar's blur, the page entrance animation), so a
 * dialog rendered inside the page becomes fixed to the CONTENT AREA instead —
 * which starts below the header. That is the clipped-under-header bug, and no
 * z-index can fix it because the dialog is fixed to the wrong box in the first
 * place. Moving it to <body> removes every ancestor at once.
 *
 * The wrapper carries `jb-portal` so the light-theme colour rules, which are
 * scoped to `.main`, also reach modal content that now lives outside `.main`.
 */
export default function Portal({ children }: { children: React.ReactNode }) {
  const [el] = useState(() =>
    typeof document !== "undefined" ? document.createElement("div") : null,
  );
  useEffect(() => {
    if (!el) return;
    el.className = "jb-portal";
    document.body.appendChild(el);
    return () => { document.body.removeChild(el); };
  }, [el]);
  if (!el) return null;
  return createPortal(children, el);
}
