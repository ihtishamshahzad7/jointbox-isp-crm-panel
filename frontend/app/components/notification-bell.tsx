"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import API from "./api";
import Avatar from "./avatar";

/**
 * The header bell — TailAdmin's notification dropdown, with the actor's
 * profile picture on every row.
 *
 * Read state lives in localStorage as "the last time I opened this". Anything
 * newer is unread. That deliberately avoids a per-user read table: the badge
 * only has to answer "is there something new since I looked", and a timestamp
 * answers it exactly, with no write on every open and no migration.
 */

type Item = {
  id: number;
  title: string;
  detail?: string | null;
  entity?: string;
  entityId?: number | null;
  actor: { id: number | null; name: string; photoUrl: string | null };
  createdAt: string;
  unread: boolean;
};

const SEEN_KEY = "jb_notifications_seen";

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

/** Where a notification takes you when clicked. */
function hrefFor(it: Item): string | null {
  if (!it.entityId) return null;
  const e = (it.entity || "").toLowerCase();
  if (e.includes("subscriber")) return `/subscribers/${it.entityId}`;
  if (e.includes("user")) return `/users/${it.entityId}`;
  if (e.includes("payment") || e.includes("invoice")) return `/billing-center?tab=payments`;
  if (e.includes("nas")) return `/network-center?tab=nas`;
  return null;
}

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
    if (!token) return;
    const since = localStorage.getItem(SEEN_KEY) || "";
    try {
      const r = await fetch(`${API}/communication/feed?since=${encodeURIComponent(since)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const d = await r.json();
      setItems(d.items || []);
      setUnread(d.unread || 0);
    } catch { /* offline or backend restarting — leave the last list up */ }
  };

  useEffect(() => {
    load();
    // A minute is often enough to feel live without adding meaningful load:
    // this is one indexed query per user per minute, not a websocket.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // Close when clicking anywhere else — a dropdown that traps the page is worse
  // than no dropdown.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      // Opening marks everything currently listed as read.
      localStorage.setItem(SEEN_KEY, new Date().toISOString());
      setUnread(0);
    }
  };

  const go = (it: Item) => {
    const href = hrefFor(it);
    setOpen(false);
    if (href) router.push(href);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        onClick={toggle}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        title="Notifications"
        style={{
          position: "relative", width: 40, height: 40, borderRadius: "50%",
          border: "1px solid var(--border)", background: "var(--surface)",
          color: "var(--text)", cursor: "pointer", display: "inline-flex",
          alignItems: "center", justifyContent: "center", fontSize: 17, fontFamily: "inherit",
        }}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && (
          <span
            style={{
              position: "absolute", top: 6, right: 7, minWidth: 8, height: 8,
              borderRadius: 999, background: "#D34053",
              boxShadow: "0 0 0 2px var(--surface)",
            }}
          />
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute", right: 0, top: 48, zIndex: 999,
            width: 340, maxWidth: "calc(100vw - 32px)",
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 8, boxShadow: "0px 8px 13px -3px rgba(0,0,0,0.07)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>
              Notifications
            </div>
          </div>

          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {items.length === 0 ? (
              <div style={{ padding: "26px 16px", textAlign: "center", fontSize: 13, color: "var(--muted)" }}>
                Nothing yet. Activity from your team appears here.
              </div>
            ) : (
              items.map((it) => (
                <button
                  key={it.id}
                  onClick={() => go(it)}
                  style={{
                    display: "flex", gap: 11, alignItems: "flex-start", width: "100%",
                    textAlign: "left", padding: "11px 16px", cursor: hrefFor(it) ? "pointer" : "default",
                    background: it.unread ? "var(--surface-2)" : "transparent",
                    border: "none", borderTop: "1px solid var(--border)",
                    color: "var(--text)", fontFamily: "inherit",
                  }}
                >
                  <Avatar name={it.actor.name} photoUrl={it.actor.photoUrl} size={36} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontSize: 13, lineHeight: 1.5 }}>{it.title}</span>
                    {it.detail && (
                      <span style={{
                        display: "block", fontSize: 12, color: "var(--muted)", lineHeight: 1.5,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>{it.detail}</span>
                    )}
                    <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                      {ago(it.createdAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>

          <button
            onClick={() => { setOpen(false); router.push("/logs?tab=actrec"); }}
            style={{
              width: "100%", padding: "10px 16px", borderTop: "1px solid var(--border)",
              background: "transparent", border: "none", color: "var(--accent)",
              fontSize: 12.5, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            View all activity
          </button>
        </div>
      )}
    </div>
  );
}
