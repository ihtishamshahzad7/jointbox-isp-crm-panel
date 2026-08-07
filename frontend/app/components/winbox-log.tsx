"use client";

import React from "react";

/**
 * WinBoxLog — the classic MikroTik WinBox "Log" window: a dense, monospace,
 * auto-scrolling console. Each line is timestamp · topic · severity · message,
 * colour-coded by severity. Filter by severity and topic, toggle auto-scroll,
 * and clear the current view.
 *
 * Fed the already-fetched log entries so it stays presentation-only. Field
 * names vary across the panel's log sources, so it reads several aliases.
 */

type Entry = any;

const SEV = (e: Entry): string =>
  String(e.severity || e.level || e.status || "INFO").toUpperCase();

const sevClass = (s: string) =>
  s.includes("ERR") || s.includes("FAIL") || s.includes("CRIT") ? "err"
  : s.includes("WARN") ? "warn"
  : s.includes("OK") || s.includes("SUCCESS") || s.includes("ACCEPT") ? "ok"
  : "info";

const ts = (e: Entry) => {
  const raw = e.timestamp || e.createdAt || e.time || e.date;
  if (!raw) return "—";
  const d = new Date(raw);
  return isNaN(d.getTime()) ? String(raw) : d.toLocaleString(undefined, {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
};

const topicOf = (e: Entry) =>
  (e.source || e.topic || e.type || e.category || e.action || "system").toString().toLowerCase();

const msgOf = (e: Entry) =>
  e.message || e.details || e.action ||
  [e.user || e.username || e.email, e.ipAddress || e.nasName].filter(Boolean).join(" · ") || "—";

export function WinBoxLog({ entries }: { entries: Entry[] }) {
  const [sev, setSev] = React.useState("ALL");
  const [topic, setTopic] = React.useState("ALL");
  const [q, setQ] = React.useState("");
  const [autoscroll, setAutoscroll] = React.useState(true);
  const [cleared, setCleared] = React.useState<number>(0); // hide entries before this index-count
  const endRef = React.useRef<HTMLDivElement>(null);

  const topics = React.useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => set.add(topicOf(e)));
    return ["ALL", ...Array.from(set).sort()];
  }, [entries]);

  const shown = React.useMemo(() => {
    const list = cleared > 0 ? entries.slice(0, Math.max(0, entries.length - cleared)) : entries;
    return list.filter((e) => {
      if (sev !== "ALL" && sevClass(SEV(e)) !== sev) return false;
      if (topic !== "ALL" && topicOf(e) !== topic) return false;
      if (q) {
        const hay = `${ts(e)} ${topicOf(e)} ${SEV(e)} ${msgOf(e)}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [entries, sev, topic, q, cleared]);

  React.useEffect(() => {
    if (autoscroll) endRef.current?.scrollIntoView({ block: "end" });
  }, [shown.length, autoscroll]);

  return (
    <div className="wblog">
      <style>{CSS}</style>

      <div className="wblog-bar">
        <select value={sev} onChange={(e) => setSev(e.target.value)} title="Severity">
          {["ALL", "info", "warn", "err", "ok"].map((s) => (
            <option key={s} value={s}>{s === "ALL" ? "All severity" : s.toUpperCase()}</option>
          ))}
        </select>
        <select value={topic} onChange={(e) => setTopic(e.target.value)} title="Topic">
          {topics.map((tpc) => <option key={tpc} value={tpc}>{tpc === "ALL" ? "All topics" : tpc}</option>)}
        </select>
        <span className="wblog-find">
          <span>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" />
        </span>
        <span className="wblog-spacer" />
        <button className={`wblog-toggle ${autoscroll ? "on" : ""}`} onClick={() => setAutoscroll((v) => !v)}
          title="Follow new entries">
          <span className="pd" /> Auto-scroll
        </button>
        <button className="wblog-clear" onClick={() => setCleared(entries.length)} title="Clear the view (does not delete stored logs)">
          Clear
        </button>
        <span className="wblog-count">{shown.length} lines</span>
      </div>

      <div className="wblog-body">
        {shown.length === 0 ? (
          <div className="wblog-empty">No log entries match the current filter.</div>
        ) : (
          shown.map((e, i) => {
            const s = sevClass(SEV(e));
            return (
              <div key={i} className={`wblog-row ${s}`}>
                <span className="wblog-ts">{ts(e)}</span>
                <span className="wblog-topic">{topicOf(e)}</span>
                <span className={`wblog-sev ${s}`}>{SEV(e)}</span>
                <span className="wblog-msg">{msgOf(e)}</span>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

const CSS = `
.wblog{border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--surface)}
.wblog-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;
  background:var(--surface-2);border-bottom:1px solid var(--border)}
.wblog-bar select{background:var(--surface);color:var(--text);border:1px solid var(--border);
  border-radius:6px;font-size:11.5px;padding:4px 8px;font-family:inherit;cursor:pointer}
.wblog-find{display:inline-flex;align-items:center;gap:5px;padding:0 8px;height:28px;
  background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--muted)}
.wblog-find input{background:transparent;border:none;outline:none;color:var(--text);
  font-family:inherit;font-size:11.5px;width:140px}
.wblog-spacer{flex:1 1 auto}
.wblog-toggle,.wblog-clear{display:inline-flex;align-items:center;gap:6px;font-family:inherit;
  font-size:11.5px;font-weight:700;cursor:pointer;padding:4px 10px;border-radius:6px;
  background:var(--surface);border:1px solid var(--border);color:var(--muted)}
.wblog-toggle .pd{width:7px;height:7px;border-radius:50%;background:#64748B}
.wblog-toggle.on{color:#6EE7B7;border-color:rgba(16,185,129,.4)}
.wblog-toggle.on .pd{background:#10B981;box-shadow:0 0 7px rgba(16,185,129,.9)}
.wblog-clear:hover{color:#FCA5A5;border-color:#EF4444}
.wblog-count{font-size:10.5px;color:var(--muted);padding-left:2px}

.wblog-body{max-height:60vh;overflow:auto;padding:4px 0;
  font-family:'JetBrains Mono',ui-monospace,'Cascadia Code',monospace;font-size:11.5px;line-height:1.6}
.wblog-row{display:flex;gap:10px;padding:2px 12px;white-space:nowrap;border-left:2px solid transparent}
.wblog-row:hover{background:rgba(255,255,255,.04)}
.wblog-row.err{border-left-color:#f44336}
.wblog-row.warn{border-left-color:#ff9800}
.wblog-row.ok{border-left-color:#4caf50}
.wblog-row.info{border-left-color:#4a9eff}
.wblog-ts{color:var(--muted);flex:none;width:120px}
.wblog-topic{color:#7cc0ff;flex:none;width:120px;overflow:hidden;text-overflow:ellipsis}
.wblog-sev{flex:none;width:64px;font-weight:700}
.wblog-sev.err{color:#f88}
.wblog-sev.warn{color:#FCD34D}
.wblog-sev.ok{color:#6EE7B7}
.wblog-sev.info{color:#85B7EB}
.wblog-msg{color:var(--text);white-space:pre-wrap;word-break:break-word}
.wblog-empty{padding:30px;text-align:center;color:var(--muted);font-size:12px}
`;
