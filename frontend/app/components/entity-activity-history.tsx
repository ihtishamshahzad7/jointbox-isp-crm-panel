"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import API from "./api";

type ActivityRow = {
  id: string | number;
  action: string;
  entity: string;
  entityId: number;
  details?: string | null;
  createdAt: string;
  userId?: number | null;
  user?: { id: number; name?: string | null; email?: string | null; role?: string | null } | null;
  ipAddress?: string | null;
  traceId?: string | null;
};

type ActivityResponse = {
  latestActivity: ActivityRow | null;
  logs: ActivityRow[];
  hasMore: boolean;
};

const when = (value?: string) => {
  if (!value) return "Timestamp not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Timestamp not recorded" : date.toLocaleString();
};

function actorName(row?: ActivityRow | null) {
  if (row?.user) return [row.user.name || row.user.email, row.user.role].filter(Boolean).join(" · ") || "Account";
  return "Actor not recorded";
}

function description(row?: ActivityRow | null) {
  return row?.details?.trim() || row?.action || "Description not recorded";
}

function outcome(row: ActivityRow) {
  if (/_FAILED$/i.test(row.action)) return "Failed";
  return "Not recorded";
}

export function EntityActivityHistory({
  entity,
  entityId,
  label,
}: {
  entity: "subscriber" | "nas" | "ip-pool" | "user" | "payment";
  entityId: number;
  label: string;
}) {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const requestId = useRef(0);
  const pageSize = 25;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    const currentRequest = ++requestId.current;
    const timer = window.setTimeout(() => {
      const token = localStorage.getItem("token");
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
      if (debouncedSearch) params.set("q", debouncedSearch);
      setLoading(true);
      setError("");
      setData(null);

      fetch(`${API}/logs/entity/${encodeURIComponent(entity)}/${entityId}?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error(body?.message || `Could not load activity (HTTP ${response.status}).`);
          return body as ActivityResponse;
        })
        .then((body) => {
          if (requestId.current === currentRequest) setData(body);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || requestId.current !== currentRequest) return;
          setError(cause instanceof Error ? cause.message : "Could not load activity.");
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false);
        });
    }, 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [entity, entityId, offset, debouncedSearch]);

  const centralAuditHref = useMemo(() => {
    const params = new URLSearchParams({
      logTab: "audit",
      logFeature: "changes",
      entity,
      entityId: String(entityId),
    });
    return `/logs?${params}`;
  }, [entity, entityId]);

  const latest = data?.latestActivity ?? null;
  const rows = data?.logs ?? [];

  return (
    <section
      aria-label={`${label} activity history`}
      style={{
        display: "grid",
        gap: 12,
        minWidth: 0,
        padding: 14,
        color: "var(--text)",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
      }}
    >
      <header style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 14 }}>Activity history</h2>
          <div style={{ marginTop: 3, color: "var(--muted)", fontSize: 11 }}>{label} #{entityId}</div>
        </div>
        <a href={centralAuditHref} style={{ color: "var(--accent)", fontSize: 12, fontWeight: 700 }}>
          Open in Audit Trail
        </a>
      </header>

      <div style={{ border: "1px solid var(--border)", borderRadius: 9, padding: 11, background: "var(--surface-2)" }}>
        <div style={{ color: "var(--muted)", fontSize: 10, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase" }}>
          Last activity
        </div>
        {loading && !data ? (
          <p role="status" style={{ margin: "6px 0 0", fontSize: 12 }}>Loading activity…</p>
        ) : latest ? (
          <div style={{ display: "grid", gap: 4, marginTop: 6, overflowWrap: "anywhere" }}>
            <strong style={{ fontSize: 12 }}>{description(latest)}</strong>
            <span style={{ color: "var(--muted)", fontSize: 11 }}>
              {when(latest.createdAt)} · {actorName(latest)} · {latest.action} · Outcome: {outcome(latest)}
            </span>
            <details style={{ marginTop: 3, fontSize: 11 }}>
              <summary style={{ cursor: "pointer", minHeight: 24 }}>Open full event details</summary>
              <div style={{ paddingTop: 6, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
                {latest.details || "Details not recorded"}
              </div>
              {latest.traceId && <div style={{ paddingTop: 5, color: "var(--muted)" }}>Request ID: {latest.traceId}</div>}
            </details>
          </div>
        ) : (
          <p style={{ margin: "6px 0 0", fontSize: 12 }}>No activity recorded</p>
        )}
      </div>

      <input
        aria-label={`Search ${label} activity`}
        value={search}
        onChange={(event) => { setSearch(event.target.value); setOffset(0); }}
        placeholder="Search this record's activity"
        maxLength={120}
        style={{
          width: "100%",
          boxSizing: "border-box",
          minWidth: 0,
          minHeight: 38,
          padding: "8px 10px",
          color: "var(--text)",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          font: "inherit",
          fontSize: 12,
        }}
      />

      {error ? (
        <div role="alert" style={{ color: "#ef4444", fontSize: 12 }}>{error}</div>
      ) : loading ? (
        <div role="status" style={{ color: "var(--muted)", fontSize: 12 }}>Loading history…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 12 }}>
          {debouncedSearch ? "No events match this search." : "No activity recorded"}
        </div>
      ) : (
        <ol style={{ display: "grid", gap: 8, listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((row) => (
            <li key={String(row.id)} style={{ minWidth: 0, border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 4 }}>
                <strong style={{ fontSize: 12, overflowWrap: "anywhere" }}>{row.action || "Action not recorded"}</strong>
                <time style={{ color: "var(--muted)", fontSize: 11 }}>{when(row.createdAt)}</time>
              </div>
              <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 11, overflowWrap: "anywhere" }}>
                {actorName(row)} · Outcome: {outcome(row)}
                {row.ipAddress ? ` · Source IP: ${row.ipAddress}` : ""}
              </div>
              <details style={{ marginTop: 7, fontSize: 11 }}>
                <summary style={{ cursor: "pointer", minHeight: 24 }}>Event details</summary>
                <div style={{ paddingTop: 6, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
                  {row.details || "Details not recorded"}
                </div>
                {row.traceId && <div style={{ paddingTop: 5, color: "var(--muted)" }}>Request ID: {row.traceId}</div>}
              </details>
            </li>
          ))}
        </ol>
      )}

      <footer style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
        <button
          type="button"
          disabled={loading || offset === 0}
          onClick={() => setOffset((value) => Math.max(0, value - pageSize))}
          style={{ minHeight: 36, padding: "6px 12px", color: "var(--text)", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 7 }}
        >
          Previous
        </button>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>Page {Math.floor(offset / pageSize) + 1}</span>
        <button
          type="button"
          disabled={loading || !data?.hasMore}
          onClick={() => setOffset((value) => value + pageSize)}
          style={{ minHeight: 36, padding: "6px 12px", color: "var(--text)", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 7 }}
        >
          Next
        </button>
      </footer>
    </section>
  );
}
