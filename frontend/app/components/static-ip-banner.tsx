"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { money } from "./currency";
import { silent } from "./silent";

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

/**
 * Static IP renewal banner.
 *
 * A static address is a recurring charge that is easy to forget — the customer
 * keeps using it whether or not anyone raises the invoice, so unbilled months
 * are lost revenue nobody notices. This sits at the top of every page until
 * the overdue ones are dealt with.
 *
 * Shows nothing at all when there is nothing to chase, so it never becomes
 * furniture people learn to ignore.
 */
export default function StaticIpBanner() {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) return;

    const load = () => {
      fetch(`${API}/static-ips/alerts`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then(setData)
        .catch(silent("staticIpAlertsFetch"));
    };

    load();
    const iv = setInterval(load, 300_000); // every 5 minutes
    return () => clearInterval(iv);
  }, []);

  if (!data || dismissed) return null;

  const overdue = data.overdue?.length ?? 0;
  const dueToday = data.dueToday?.length ?? 0;
  const dueSoon = data.dueSoon?.length ?? 0;

  // Nothing pressing — stay out of the way entirely.
  if (!overdue && !dueToday && !dueSoon) return null;

  // Overdue money is red; anything else is a heads-up, not an alarm.
  const urgent = overdue > 0;
  const colour = urgent ? "#ef4444" : dueToday > 0 ? "#f59e0b" : "#0ea5e9";
  const tint = urgent
    ? "rgba(239,68,68,.10)"
    : dueToday > 0
      ? "rgba(245,158,11,.10)"
      : "rgba(14,165,233,.10)";

  const parts: string[] = [];
  if (overdue) parts.push(`${overdue} overdue`);
  if (dueToday) parts.push(`${dueToday} due today`);
  if (dueSoon) parts.push(`${dueSoon} due this week`);

  const amount = [...(data.overdue || []), ...(data.dueToday || [])]
    .reduce((s: number, r: any) => s + Number(r.monthlyPrice || 0), 0);

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        background: tint, border: `1px solid ${colour}`, borderRadius: 12,
        padding: "11px 15px", marginBottom: 16,
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: "50%", background: colour, flexShrink: 0,
      }} />

      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: colour }}>
          Static IP charges — {parts.join(", ")}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>
          {amount > 0
            ? `${money(amount)} of monthly add-on revenue waiting to be collected.`
            : "Monthly add-on renewals are coming up."}
        </div>
      </div>

      <button
        onClick={() => router.push("/static-ips")}
        style={{
          background: colour, color: "#fff", border: "none", borderRadius: 8,
          padding: "6px 14px", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
        }}
      >
        Review
      </button>

      {/* Only the non-urgent version can be dismissed — overdue money should
          keep asking until somebody acts on it. */}
      {!urgent && (
        <button
          onClick={() => setDismissed(true)}
          style={{
            background: "transparent", color: "var(--muted)", border: "none",
            fontSize: 17, lineHeight: 1, cursor: "pointer", padding: "0 4px",
          }}
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}
