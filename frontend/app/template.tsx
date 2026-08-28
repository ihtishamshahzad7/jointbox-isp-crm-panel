"use client";

import { motion } from "framer-motion";
import { fadeUp, usePrefersReducedMotion } from "../lib/motion";

/**
 * Cross-page transition (motion #1).
 *
 * Next.js re-mounts a <template>'s children on every navigation, so this
 * wrapper animates each freshly-routed page in from below (rise + fade) using
 * the shared `fadeUp` catalog variant — one tween, the same rhythm everywhere.
 *
 * Reduced-motion users get `initial={false}`, mounting directly at `animate`
 * with no tween at all.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.div
      initial={reduced ? false : "hidden"}
      animate="show"
      variants={fadeUp}
    >
      {children}
    </motion.div>
  );
}
