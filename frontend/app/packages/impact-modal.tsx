"use client";

/**
 * Impact-aware destruction modal for packages.
 *
 * Spec: a package with subscribers must not be permanently deletable — the
 * operator archives it instead (existing customers keep running, new sign-ups
 * stop). The modal fetches the overview's real impact counts so the operator
 * sees EXACTLY who/what the action touches before confirming:
 *
 *   - subscribers (with status breakdown + expiring-soon)
 *   - reseller price assignments
 *   - access groups
 *
 * Delete is offered only when the backend will accept it (0 subscribers, 0
 * reseller rows). Archive is offered when subscribers or reseller rows exist.
 */
import { useEffect, useState } from "react";
import Portal from "../components/portal";
import API from "../components/api";
import { PackageRow } from "./lib";

export default function PackageImpactModal({ pkg, token, intent = "delete", onClose, onArchived, onDeleted, onConfirmEdit }: {
  pkg: PackageRow;
  token: string | null;
  /** "delete" → archive only when in use; "archive" → always archive (Disable);
   *  "edit" → confirm a plan change knowing who it affects. */
  intent?: "delete" | "archive" | "edit";
  onClose: () => void;
  onArchived: () => void;
  onDeleted: () => void;
  onConfirmEdit?: () => void;
}) {
  const [impact, setImpact] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"archive" | "delete" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(`${API}/packages/${pkg.id}/overview`, { headers: { Authorization: `Bearer ${token || ""}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`unable to load impact data (HTTP ${r.status})`);
        return r.json();
      })
      .then((d) => { if (live) { setImpact(d?.impact ?? d); setErr(null); } })
      .catch((e) => { if (live) setErr(e?.message || "failed to load impact data"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [pkg.id, token]);

  const subscribers = impact?.subscribers ?? 0;
  const resellers = impact?.resellers ?? 0;
  const groups = impact?.groups ?? 0;
  const expiringSoon = impact?.expiringSoon ?? 0;
  const canDelete = !loading && !err && subscribers === 0 && resellers === 0;

  const act = async (kind: "archive" | "delete") => {
    setBusy(kind);
    setErr(null);
    try {
      const url = kind === "archive" ? `${API}/packages/${pkg.id}/archive` : `${API}/packages/${pkg.id}`;
      const res = await fetch(url, {
        method: kind === "archive" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token || ""}` },
      });
      if (!res.ok) {
        const body: any = await res.json().catch(() => null);
        const msg = Array.isArray(body?.message) ? body.message.join(" ") : body?.message;
        throw new Error(msg || `Failed (HTTP ${res.status})`);
      }
      if (kind === "archive") onArchived(); else onDeleted();
    } catch (e: any) {
      setErr(e?.message || "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const statusRows = Object.entries(impact?.subStatus || {})
    .filter(([k]) => k !== "total" && k !== "active" && Number((impact?.subStatus as any)[k]) > 0);

  const isArchiveRequest = intent === "archive";
  const isEditRequest = intent === "edit";
  const offerArchive = isArchiveRequest || subscribers > 0 || resellers > 0;

  return (
    <Portal>
      <div style={{ position: "fixed", inset: 0, zIndex: 2100, background: "rgba(0,0,0,.7)", backdropFilter: "blur(8px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }} onClick={onClose}>
        <div style={{ background: "var(--surface)", border: "1px solid rgba(255,255,255,.06)", borderRadius: "20px",
          padding: "28px", maxWidth: "560px", width: "100%", maxHeight: "90vh", overflowY: "auto" }}
          onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
            <h2 style={{ fontSize: "18px", fontWeight: "800", color: "var(--text)", margin: 0 }}>
              {subscribers > 0 ? "Archive package?" : "Delete package?"}
            </h2>
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: "20px", cursor: "pointer" }}>✕</button>
          </div>

          <p style={{ fontSize: "13.5px", color: "var(--muted)", lineHeight: 1.7, margin: "0 0 16px" }}>
            What happens to <b style={{ color: "var(--text)" }}>{pkg.name}</b> touches real customers.
            {isEditRequest
              ? " Saving changes to a plan in use affects the subscribers below. Existing customers keep their current plan until renewal or change — but this is who is on it."
              : isArchiveRequest
                ? " Disabling keeps existing subscribers running (they keep their plan until renewal or change) and blocks new sign-ups."
                : subscribers > 0
                  ? " Deleting is blocked by the backend while subscribers are on it — archiving keeps them running and stops new sign-ups."
                  : " No subscribers are on this plan, so it can be permanently deleted."}
          </p>

          {loading && <div style={{ color: "var(--muted)", fontSize: "13px" }}>Checking who this affects…</div>}
          {err && !loading && (
            <div style={{ padding: "10px 14px", borderRadius: "10px", background: "rgba(255,112,112,.1)", border: "1px solid rgba(255,112,112,.3)",
              color: "#ff7070", fontSize: "13px", marginBottom: "12px" }}>{err}</div>
          )}

          {!loading && impact && (
            <div style={{ border: "1px solid var(--border)", borderRadius: "14px", overflow: "hidden", marginBottom: "14px" }}>
              <Row k="Subscribers " v={String(subscribers)} strong />
              {statusRows.map(([k, v]) => (
                <Row key={k as string} k={`↳ ${String(k).toLowerCase()}`} v={String(v)} muted />
              ))}
              {expiringSoon > 0 && (
                <Row k={`↳ expiring within 7 days`} v={String(expiringSoon)}
                  warn={expiringSoon > 0} />
              )}
              <Row k="Reseller price assignments" v={String(resellers)} muted />
              <Row k="Access groups" v={String(groups)} muted />
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", flexWrap: "wrap" }}>
            <button onClick={onClose} style={{ padding: "10px 22px", borderRadius: "10px", fontSize: "13px", fontWeight: "600",
              border: "1px solid var(--border)", cursor: "pointer", background: "transparent", color: "var(--muted)" }}>
              Cancel
            </button>
            {isEditRequest ? (
              <button onClick={() => onConfirmEdit?.()} disabled={busy !== null}
                style={{ padding: "10px 22px", borderRadius: "10px", fontSize: "13px", fontWeight: "700", cursor: "pointer",
                  border: "none", background: "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)", color: "#fff" }}>
                Yes — save changes ({subscribers > 0 ? `${subscribers} subscriber${subscribers === 1 ? "" : "s"} on this plan` : "no subscribers"})
              </button>
            ) : offerArchive ? (
              <button onClick={() => act("archive")} disabled={busy !== null}
                style={{ padding: "10px 22px", borderRadius: "10px", fontSize: "13px", fontWeight: "700", cursor: busy ? "wait" : "pointer",
                  border: "none", background: "linear-gradient(135deg,#B45309,#D97706)", color: "#fff" }}>
                {busy === "archive" ? "Archiving…" : isArchiveRequest ? "Disable (keep customers running)" : "Archive (keep customers running)"}
              </button>
            ) : (
              <button onClick={() => act("delete")} disabled={busy !== null || !canDelete}
                style={{ padding: "10px 22px", borderRadius: "10px", fontSize: "13px", fontWeight: "700", cursor: busy ? "wait" : "pointer",
                  border: "none", background: "rgba(127,29,29,.9)", color: "#fecaca", opacity: canDelete ? 1 : .5 }}>
                {busy === "delete" ? "Deleting…" : "Delete forever"}
              </button>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

function Row({ k, v, muted, strong, warn }: { k: string; v: string; muted?: boolean; strong?: boolean; warn?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px",
      borderBottom: "1px solid var(--border)", fontSize: "13px",
      fontWeight: strong ? "800" : "500", color: muted ? "var(--muted)" : warn ? "#F59E0B" : "var(--text)",
      background: warn ? "rgba(245,158,11,.06)" : "transparent",
    }}>
      <span>{k}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
    </div>
  );
}