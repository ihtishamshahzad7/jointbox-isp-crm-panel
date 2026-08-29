"use client";

import * as React from "react";
import { motion, AnimatePresence, SPRING, useCalm, DUR, EASE } from "./motion";

/**
 * NOTIFICATION CENTRE — grouped, swipe-to-dismiss, screen-reader correct.
 *
 * WHY THIS EXISTS ALONGSIDE react-hot-toast
 * A toast is fire-and-forget: it appears, it goes, and if you were looking at
 * another tab you never knew. That is fine for "Saved". It is wrong for the
 * things this product actually needs to tell an operator — an area has gone
 * down, forty subscribers expire tomorrow, a payment settled — because those
 * are events you must still be able to find five minutes later. So these
 * persist in a centre, and only the newest surfaces as a transient card.
 *
 * GROUPING IS THE FEATURE
 * A network event is never singular. One upstream fault produces fifty
 * "subscriber offline" notifications, and fifty cards is not information, it
 * is a denial-of-service on the operator's attention. Items sharing a
 * `groupKey` collapse into one entry with a count, newest message showing.
 * That turns a flood into a line.
 *
 * ACCESSIBILITY
 * The live region is `polite`, never `assertive`: assertive interrupts a
 * screen reader mid-sentence, which for a steady trickle of network events is
 * unusable. Only the text is announced; the swipe affordance is decorative
 * and hidden. Every card is dismissible by keyboard as well as by drag,
 * because a drag gesture that has no keyboard equivalent is simply a control
 * some people cannot operate.
 */

export type NoteTone = "info" | "success" | "warning" | "danger";

export type Note = {
  id: string;
  title: string;
  body?: string;
  tone?: NoteTone;
  /** Items sharing this collapse into one row with a count. */
  groupKey?: string;
  at: number;
  /** Auto-dismiss ms. Omit or 0 to make it stay until dismissed. */
  ttl?: number;
  href?: string;
};

type Grouped = Note & { count: number; ids: string[] };

const TONE: Record<NoteTone, { bar: string; label: string }> = {
  info: { bar: "var(--accent)", label: "Notification" },
  success: { bar: "var(--online)", label: "Success" },
  warning: { bar: "var(--warning)", label: "Warning" },
  danger: { bar: "var(--danger)", label: "Alert" },
};

// ── Store ──────────────────────────────────────────────────────
const NotifyCtx = React.createContext<{
  notes: Note[];
  push: (n: Omit<Note, "id" | "at"> & { id?: string }) => string;
  dismiss: (id: string) => void;
  dismissGroup: (ids: string[]) => void;
  clear: () => void;
} | null>(null);

export function NotifyProvider({ children }: { children: React.ReactNode }) {
  const [notes, setNotes] = React.useState<Note[]>([]);
  const timers = React.useRef(new Map<string, number>());

  const dismiss = React.useCallback((id: string) => {
    setNotes((n) => n.filter((x) => x.id !== id));
    const t = timers.current.get(id);
    if (t) {
      window.clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const push = React.useCallback(
    (n: Omit<Note, "id" | "at"> & { id?: string }) => {
      const id = n.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const note: Note = { tone: "info", ...n, id, at: Date.now() };
      setNotes((prev) => {
        // Cap the store. An unbounded list is a memory leak on a panel left
        // open for a week, which is exactly how these are used.
        const next = [note, ...prev];
        return next.length > 200 ? next.slice(0, 200) : next;
      });
      if (note.ttl && note.ttl > 0) {
        timers.current.set(id, window.setTimeout(() => dismiss(id), note.ttl));
      }
      return id;
    },
    [dismiss],
  );

  const dismissGroup = React.useCallback((ids: string[]) => {
    const set = new Set(ids);
    setNotes((n) => n.filter((x) => !set.has(x.id)));
  }, []);

  const clear = React.useCallback(() => setNotes([]), []);

  // Clear pending timers on unmount so a dismissed-then-remounted provider
  // does not fire callbacks into a dead tree.
  React.useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => window.clearTimeout(t));
      map.clear();
    };
  }, []);

  const value = React.useMemo(
    () => ({ notes, push, dismiss, dismissGroup, clear }),
    [notes, push, dismiss, dismissGroup, clear],
  );

  return (
    <NotifyCtx.Provider value={value}>
      {children}
      <ToastStack />
    </NotifyCtx.Provider>
  );
}

export function useNotify() {
  const ctx = React.useContext(NotifyCtx);
  if (!ctx) throw new Error("useNotify must be used inside <NotifyProvider>");
  return ctx;
}

/** Collapse by groupKey, newest first, keeping the most recent message. */
export function groupNotes(notes: Note[]): Grouped[] {
  const out: Grouped[] = [];
  const index = new Map<string, number>();
  for (const n of notes) {
    if (!n.groupKey) {
      out.push({ ...n, count: 1, ids: [n.id] });
      continue;
    }
    const at = index.get(n.groupKey);
    if (at === undefined) {
      index.set(n.groupKey, out.length);
      out.push({ ...n, count: 1, ids: [n.id] });
    } else {
      out[at].count += 1;
      out[at].ids.push(n.id);
    }
  }
  return out;
}

// ── Transient stack ────────────────────────────────────────────
/**
 * Only the newest three surface as cards. Beyond that the centre is the right
 * place to look — a screenful of stacked toasts obscures the very UI the
 * operator needs in order to act on them.
 */
function ToastStack() {
  const { notes, dismiss, dismissGroup } = useNotify();
  const grouped = React.useMemo(() => groupNotes(notes).slice(0, 3), [notes]);

  return (
    <>
      {/* The announcer is separate from the visual stack: it must exist in the
          DOM from first render, empty, or a screen reader will not announce
          the first message injected into it. */}
      <div aria-live="polite" aria-atomic="false" className="ds-sr-only">
        {grouped.map((g) => (
          <p key={g.id}>{`${TONE[g.tone ?? "info"].label}: ${g.title}${g.count > 1 ? ` (${g.count})` : ""}`}</p>
        ))}
      </div>

      <div
        style={{
          position: "fixed",
          right: "var(--s-4)",
          bottom: "var(--s-4)",
          zIndex: 200,
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-2)",
          width: "min(360px, calc(100vw - 32px))",
          pointerEvents: "none",
        }}
      >
        <AnimatePresence initial={false}>
          {grouped.map((g) => (
            <ToastCard
              key={g.id}
              note={g}
              onDismiss={() => (g.count > 1 ? dismissGroup(g.ids) : dismiss(g.id))}
            />
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}

function ToastCard({ note, onDismiss }: { note: Grouped; onDismiss: () => void }) {
  const calm = useCalm();
  const tone = TONE[note.tone ?? "info"];

  return (
    <motion.div
      layout={!calm}
      initial={calm ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.97 }}
      animate={calm ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
      exit={calm ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.97 }}
      transition={SPRING.snappy}
      // SWIPE TO DISMISS. Constrained to one axis so a vertical scroll
      // gesture that starts on a card does not drag it sideways.
      drag={calm ? false : "x"}
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.06, right: 0.9 }}
      onDragEnd={(_e, info) => {
        // Velocity as well as distance: a fast flick should dismiss even if
        // it travelled barely any distance, which is how the gesture feels on
        // every native platform.
        if (info.offset.x > 90 || info.velocity.x > 550) onDismiss();
      }}
      className="ds-glass"
      style={{
        pointerEvents: "auto",
        padding: "var(--s-3) var(--s-4)",
        display: "flex",
        gap: "var(--s-3)",
        alignItems: "flex-start",
        cursor: calm ? "default" : "grab",
        touchAction: "pan-y",
      }}
    >
      <span
        aria-hidden
        style={{ width: 3, alignSelf: "stretch", borderRadius: 3, background: tone.bar, flex: "none" }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <strong style={{ fontSize: "var(--t-sm)", fontWeight: 650, color: "var(--text)" }}>
            {note.title}
          </strong>
          {note.count > 1 && (
            <span
              style={{
                fontSize: "var(--t-xs)",
                fontWeight: 700,
                padding: "1px 7px",
                borderRadius: "var(--r-pill)",
                background: tone.bar,
                color: "var(--bg)",
              }}
            >
              {note.count}
            </span>
          )}
        </div>
        {note.body && (
          <p style={{ margin: "3px 0 0", fontSize: "var(--t-xs)", color: "var(--muted)", lineHeight: 1.5 }}>
            {note.body}
          </p>
        )}
      </div>
      {/* The keyboard route to the same action as the swipe. */}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Dismiss: ${note.title}`}
        style={{
          background: "none",
          border: "none",
          color: "var(--muted)",
          cursor: "pointer",
          padding: 2,
          lineHeight: 1,
          flex: "none",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </motion.div>
  );
}

// ── The centre ─────────────────────────────────────────────────
/** Bell + panel. Drop into the top bar. */
export function NotifyCentre() {
  const { notes, dismiss, dismissGroup, clear } = useNotify();
  const [open, setOpen] = React.useState(false);
  const calm = useCalm();
  const grouped = React.useMemo(() => groupNotes(notes), [notes]);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);

  // Escape closes and returns focus to the trigger — without the return, a
  // keyboard user is dumped at the top of the document.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onClickAway = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClickAway);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClickAway);
    };
  }, [open]);

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={notes.length ? `Notifications, ${notes.length} unread` : "Notifications"}
        style={{
          position: "relative",
          background: "var(--glass-2)",
          border: "1px solid var(--glass-border)",
          borderRadius: "var(--r-md)",
          width: 36,
          height: 36,
          display: "grid",
          placeItems: "center",
          color: "var(--text)",
          cursor: "pointer",
        }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {notes.length > 0 && (
          <motion.span
            initial={calm ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            transition={SPRING.bouncy}
            aria-hidden
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              minWidth: 17,
              height: 17,
              padding: "0 4px",
              borderRadius: "var(--r-pill)",
              background: "var(--danger)",
              color: "#fff",
              fontSize: 10,
              fontWeight: 800,
              display: "grid",
              placeItems: "center",
              border: "2px solid var(--bg)",
            }}
          >
            {notes.length > 99 ? "99+" : notes.length}
          </motion.span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            initial={calm ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={calm ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={calm ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={SPRING.snappy}
            className="ds-glass"
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 8px)",
              width: "min(380px, calc(100vw - 24px))",
              maxHeight: "min(70vh, 520px)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              zIndex: 150,
              transformOrigin: "top right",
            }}
          >
            <header
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "var(--s-3) var(--s-4)",
                borderBottom: "1px solid var(--glass-border)",
              }}
            >
              <strong style={{ fontSize: "var(--t-sm)", fontWeight: 700 }}>Notifications</strong>
              {notes.length > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--muted)",
                    fontSize: "var(--t-xs)",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Clear all
                </button>
              )}
            </header>

            <div style={{ overflowY: "auto", padding: "var(--s-2)" }}>
              {grouped.length === 0 && (
                <p style={{ padding: "var(--s-6) var(--s-4)", textAlign: "center", color: "var(--muted)", fontSize: "var(--t-sm)" }}>
                  Nothing to report.
                </p>
              )}
              <AnimatePresence initial={false}>
                {grouped.map((g) => (
                  <motion.div
                    key={g.id}
                    layout={!calm}
                    initial={calm ? { opacity: 0 } : { opacity: 0, x: -8 }}
                    animate={calm ? { opacity: 1 } : { opacity: 1, x: 0 }}
                    exit={calm ? { opacity: 0 } : { opacity: 0, x: 40, height: 0 }}
                    transition={{ duration: DUR.base, ease: EASE }}
                    style={{
                      display: "flex",
                      gap: "var(--s-3)",
                      padding: "var(--s-3)",
                      borderRadius: "var(--r-md)",
                      alignItems: "flex-start",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 7,
                        height: 7,
                        marginTop: 5,
                        borderRadius: "50%",
                        background: TONE[g.tone ?? "info"].bar,
                        flex: "none",
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <strong style={{ fontSize: "var(--t-sm)", fontWeight: 600 }}>{g.title}</strong>
                        {g.count > 1 && (
                          <span style={{ fontSize: "var(--t-xs)", color: "var(--muted)", fontWeight: 700 }}>
                            ×{g.count}
                          </span>
                        )}
                      </div>
                      {g.body && (
                        <p style={{ margin: "2px 0 0", fontSize: "var(--t-xs)", color: "var(--muted)", lineHeight: 1.5 }}>
                          {g.body}
                        </p>
                      )}
                      <time
                        dateTime={new Date(g.at).toISOString()}
                        style={{ fontSize: 10.5, color: "var(--muted)", opacity: 0.75 }}
                      >
                        {relative(g.at)}
                      </time>
                    </div>
                    <button
                      type="button"
                      onClick={() => (g.count > 1 ? dismissGroup(g.ids) : dismiss(g.id))}
                      aria-label={`Dismiss: ${g.title}`}
                      style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", flex: "none" }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function relative(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
