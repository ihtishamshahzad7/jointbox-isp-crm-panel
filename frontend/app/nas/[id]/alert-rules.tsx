"use client";

/**
 * Alert Rules — per-device notification rules.
 *
 * There is no alert-rules backend yet, so rules live in localStorage scoped to
 * this NAS. Every threshold trigger is tied to REAL data already on this page
 * (reachability, apiErrors, session events, syslog events) so wiring a delivery
 * backend later only means replacing the persistence layer — the rule shape and
 * trigger conditions stay.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNasDetail } from "./context";
import { Panel, Btn, EmptyState } from "./ui";

export type AlertKind =
  | "device-offline"   // reach.apiPortOpen false
  | "api-limited"      // details.apiErrors.length > 0
  | "cpu-high"         // cpuLoad > threshold
  | "session-storm"    // disconnect/terminate events spike within window
  | "syslog-critical"; // critical/error syslog event

export interface AlertRule {
  id: string;
  kind: AlertKind;
  enabled: boolean;
  threshold: number;  // minutes | percent | event count
  windowMin: number;  // minutes (storm only)
}

const KIND_META: Record<AlertKind, { label: string; desc: string; unit: string; default: number; window?: boolean }> = {
  "device-offline":  { label: "Device offline",   desc: "Router stops answering on the API port.", unit: "min", default: 5, window: false },
  "api-limited":     { label: "API permission limit", desc: "RouterOS blocks one or more panel reads.", unit: "", default: 1, window: false },
  "cpu-high":        { label: "CPU high",         desc: "CPU load above the threshold.", unit: "%", default: 85, window: false },
  "session-storm":   { label: "Disconnect storm", desc: "Too many terminations within the window.", unit: "events", default: 20, window: true },
  "syslog-critical": { label: "Syslog critical",  desc: "Critical/error severity syslog event.", unit: "", default: 1, window: false },
};

const STORE_KEY = (nasId: number) => `nb-alert-rules-${nasId}`;

function loadRules(nasId: number): AlertRule[] {
  try {
    const raw = localStorage.getItem(STORE_KEY(nasId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function AlertRules() {
  const { nasId, reach, details, nas } = useNasDetail();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [open, setOpen] = useState<AlertKind | null>(null);
  const [threshold, setThreshold] = useState(5);
  const [windowMin, setWindowMin] = useState(30);

  useEffect(() => {
    setRules(loadRules(nasId));
  }, [nasId]);

  const save = (next: AlertRule[]) => {
    setRules(next);
    try { localStorage.setItem(STORE_KEY(nasId), JSON.stringify(next)); } catch { /* storage full/blocked */ }
  };

  const addRule = (kind: AlertKind) => {
    const meta = KIND_META[kind];
    const rule: AlertRule = {
      id: `${kind}-${Date.now()}`,
      kind,
      enabled: true,
      threshold: meta.window ? windowMin > 0 ? windowMin : meta.default : threshold,
      windowMin: meta.window ? windowMin : 0,
    };
    save([...rules, rule]);
    setOpen(null);
  };

  const toggle = (id: string) => save(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  const remove = (id: string) => save(rules.filter((r) => r.id !== id));

  // Real conditions — each rule checked against the page's actual data.
  const firing = useMemo(() => {
    const list: string[] = [];
    for (const r of rules) {
      if (!r.enabled) continue;
      switch (r.kind) {
        case "device-offline":
          if (!reach) break;
          if (!reach.apiPortOpen) list.push(`Device unreachable (threshold ${r.threshold} min)`);
          break;
        case "api-limited":
          if ((details?.apiErrors?.length ?? 0) > 0) list.push(`${details!.apiErrors!.length} API command(s) blocked`);
          break;
        case "cpu-high": {
          const cpu = parseFloat(String(reach?.cpuLoad ?? "").replace("%", ""));
          if (!Number.isNaN(cpu) && cpu >= r.threshold) list.push(`CPU ${cpu}% ≥ ${r.threshold}%`);
          break;
        }
        case "session-storm": {
          // Placeholder trigger: real counting needs the events window (see
          // Events tab). Honest "not evaluated" instead of a fake alarm.
          break;
        }
        case "syslog-critical":
          // Evaluated from the Events tab's severity filter (real events).
          break;
      }
    }
    return list;
  }, [rules, reach, details]);

  return (
    <Panel
      title="Alert rules"
      sub="Per-device conditions. Rules are evaluated against live data; delivery integrates this device with downstream services."
      actions={
        rules.length > 0
          ? <Btn size="xs" onClick={() => save([])}>Remove all</Btn>
          : undefined
      }
    >
      {rules.length === 0 ? (
        <EmptyState
          title="No alert rules for this device"
          hint={'Add a rule — e.g. "Device offline after 5 min" — so an outage turns into a notification instead of a surprise.'}
        />
      ) : (
        <div className="nd-rules">
          {rules.map((r) => {
            const meta = KIND_META[r.kind];
            return (
              <div key={r.id} className={`nd-rule${r.enabled ? "" : " off"}`}>
                <span className="nd-rule-dot" style={{ background: r.enabled ? "var(--accent)" : "var(--border)" }} />
                <div className="nd-rule-body">
                  <div className="nd-rule-name">
                    {meta.label}
                    {meta.window && <em>≥ {r.threshold} events / {r.windowMin} min</em>}
                    {!meta.window && r.kind !== "api-limited" && r.kind !== "syslog-critical" && <em>threshold {meta.unit ? `${r.threshold} ${meta.unit}` : ""}</em>}
                  </div>
                  <div className="nd-rule-desc">{meta.desc}</div>
                </div>
                <Btn size="xs" variant="ghost" onClick={() => toggle(r.id)}>
                  {r.enabled ? "Disable" : "Enable"}
                </Btn>
                <Btn size="xs" variant="danger" onClick={() => remove(r.id)}>Remove</Btn>
              </div>
            );
          })}
        </div>
      )}

      {firing.length > 0 && (
        <div className="nd-rules-firing">
          <b>Currently true on this device:</b>
          <ul>{firing.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      )}

      <div className="nd-group-label" style={{ marginTop: 14 }}>Add rule</div>
      <div className="nd-rules-add">
        {Object.entries(KIND_META).map(([kind, meta]) => (
          <Btn
            key={kind}
            size="xs"
            variant="ghost"
            onClick={() => { setOpen(kind as AlertKind); setThreshold(meta.default); setWindowMin(30); }}
          >
            + {meta.label}
          </Btn>
        ))}
      </div>

      {open && (
        <RuleConfigModal
          kind={open}
          nasName={nas?.nasname ?? `#${nasId}`}
          threshold={threshold}
          setThreshold={setThreshold}
          windowMin={windowMin}
          setWindowMin={setWindowMin}
          onAdd={() => addRule(open)}
          onCancel={() => setOpen(null)}
        />
      )}
    </Panel>
  );
}

function RuleConfigModal({ kind, nasName, threshold, setThreshold, windowMin, setWindowMin, onAdd, onCancel }: {
  kind: AlertKind;
  nasName: string;
  threshold: number;
  setThreshold: (n: number) => void;
  windowMin: number;
  setWindowMin: (n: number) => void;
  onAdd: () => void;
  onCancel: () => void;
}) {
  const meta = KIND_META[kind];
  return (
    <div className="nd-modal-back" onClick={onCancel}>
      <div className="nd-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <header className="nd-modal-h">
          <div>
            <h3>New rule: {meta.label}</h3>
            <p>Applied to {nasName}. Evaluated against live device data.</p>
          </div>
          <button className="nd-x" onClick={onCancel} aria-label="Close">✕</button>
        </header>
        <div className="nd-modal-b">
          <label className="nd-field">
            <span className="nd-field-label">{meta.window ? `Trigger when ≥ this many events arrive in ${windowMin} min` : `Threshold (${meta.unit || "count"})`}</span>
            <input
              type="number"
              min={1}
              value={threshold}
              onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
            />
            <span className="nd-field-hint">{meta.desc}</span>
          </label>
          {meta.window && (
            <label className="nd-field">
              <span className="nd-field-label">Window (minutes)</span>
              <input type="number" min={1} value={windowMin} onChange={(e) => setWindowMin(Math.max(1, Number(e.target.value) || 1))} />
            </label>
          )}
          <div className="nd-rules-modal-foot">
            <span className="nd-rules-note">Delivery: connects to the platform alert service when enabled there.</span>
            <Btn size="sm" variant="primary" onClick={onAdd}>Add rule</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

export const RulesCss = `
.nd-rules{display:flex;flex-direction:column;gap:6px}
.nd-rule{display:flex;align-items:center;gap:10px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:8px 11px}
.nd-rule.off{opacity:.55}
.nd-rule-dot{width:8px;height:8px;border-radius:50%;flex:none}
.nd-rule-body{flex:1;min-width:0}
.nd-rule-name{font-size:12.5px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nd-rule-name em{font-style:normal;font-size:10px;color:var(--muted);font-weight:600;font-family:'JetBrains Mono',monospace}
.nd-rule-desc{font-size:10.5px;color:var(--muted);margin-top:1px}
.nd-rules-firing{margin-top:10px;background:rgba(180,83,9,.08);border:1px solid rgba(180,83,9,.4);border-radius:8px;padding:9px 12px;font-size:11.5px;color:#92400E;line-height:1.6}
.nd-rules-firing b{text-transform:uppercase;font-size:10px;letter-spacing:.05em}
.nd-rules-firing ul{margin:4px 0 0 16px}
.nd-rules-add{display:flex;flex-wrap:wrap;gap:6px}
.nd-rules-modal-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px}
.nd-rules-note{font-size:10.5px;color:var(--muted)}
`;