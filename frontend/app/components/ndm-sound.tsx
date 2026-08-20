"use client";

/**
 * NDM alert sound engine — the piece that actually makes noise when an NDM
 * alert fires.
 *
 * Pipeline: backend poll → event → alert rule → alert (notify) →
 * SSE "ndm:alert" → THIS hook → beep. The backend already applied the
 * rule/device/port sound hierarchy and sends `sound: true/false` on every
 * alert push, so this engine only applies the operator's GLOBAL preference
 * (which is per-browser and needs a user gesture — browsers block audio
 * until the page has been interacted with; the bell's own click is that
 * gesture).
 *
 * Conservative defaults: CRITICAL/HIGH alerts beep, everything else stays
 * silent unless the operator raises the bar or enables recovery chimes.
 */
import React from "react";
import { useSSE } from "./use-sse";

export type NdmSoundPrefs = {
  /** Master switch for NDM sounds on this browser. */
  enabled: boolean;
  /** Beep when an alert OPENS / escalates. */
  downSound: boolean;
  /** Chime when an alert RESOLVES. Off by default (Port UP must not auto-sound). */
  upSound: boolean;
  /** 0..1 gain. */
  volume: number;
  /** Only alerts at or above this severity may sound. */
  minSeverity: "CRITICAL" | "WARNING" | "INFO";
};

const DEFAULTS: NdmSoundPrefs = { enabled: true, downSound: true, upSound: false, volume: 0.6, minSeverity: "CRITICAL" };
const KEY = "ndmSoundPrefs";
const SEV_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, ERROR: 1, WARNING: 2, INFO: 3, DEBUG: 4 };

function loadPrefs(): NdmSoundPrefs {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(KEY) : null;
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch { return DEFAULTS; }
}

export function useNdmSound() {
  const [prefs, setPrefsState] = React.useState<NdmSoundPrefs>(loadPrefs);
  const [muted, setMuted] = React.useState(false);
  const audioRef = React.useRef<AudioContext | null>(null);
  const prefsRef = React.useRef(prefs);
  prefsRef.current = prefs;

  /** Two-tone: falling for DOWN (urgent), rising for UP (resolved). */
  const beep = React.useCallback((kind: "down" | "up") => {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      const ctx = audioRef.current || (audioRef.current = new AC());
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const notes = kind === "down" ? [880, 620] : [620, 880];
      notes.forEach((freq, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "square"; o.frequency.value = freq;
        const t0 = ctx.currentTime + i * 0.16;
        // Clamped so max volume can never produce a painful level.
        g.gain.setValueAtTime(Math.min(Math.max(prefsRef.current.volume, 0), 1) * 0.12, t0);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.15);
      });
    } catch { /* audio blocked until first interaction */ }
  }, []);

  const setPrefs = React.useCallback((p: Partial<NdmSoundPrefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...p };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  /** Play both tones so the operator can set volume without waiting for an outage. */
  const testSound = React.useCallback(() => { beep("down"); setTimeout(() => beep("up"), 750); }, [beep]);

  // Listen for NDM alert pushes. The backend sends `sound` (rule→severity→
  // device→port hierarchy already applied); we gate on the global prefs.
  useSSE({
    onEvent: (type: string, data: any) => {
      if (type !== "ndm:alert") return;
      const a = (data || {}) as any;
      const p = prefsRef.current;
      if (!p.enabled || muted) return;
      const sev = String(a.severity || "").toUpperCase();
      const rank = SEV_RANK[sev] ?? 9;
      if (rank > SEV_RANK[p.minSeverity] || rank > 4) return;
      if (a.action === "open" || a.action === "upgrade") {
        if (a.sound === true && p.downSound) beep("down");
      } else if (a.action === "resolve") {
        if (a.sound === true && p.upSound) beep("up");
      }
    },
  });

  return { prefs, setPrefs, muted, setMuted, testSound };
}

/** Small bell button + settings popover, placed in each NDM page header. */
export function NdmSoundBell() {
  const { prefs, setPrefs, muted, setMuted, testSound } = useNdmSound();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const live = prefs.enabled && !muted;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        className="ndm-btn"
        onClick={() => { setOpen((o) => !o); }}
        title="NDM alert sound settings — click to allow audio on this browser"
        style={{ fontSize: 13 }}
      >
        {live ? "🔔" : "🔕"}
      </button>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 80, width: 260,
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
          boxShadow: "0 18px 50px rgba(0,0,0,.25)", padding: 12, fontSize: 12.5, textAlign: "left",
        }}>
          <b style={{ fontSize: 13 }}>NDM alert sounds</b>
          <div style={{ marginTop: 8, display: "grid", gap: 7 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={prefs.enabled} onChange={(e) => setPrefs({ enabled: e.target.checked })} />
              Enable NDM sounds
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} />
              Mute (until unmuted)
            </label>
            <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              Sounded when severity
              <select value={prefs.minSeverity} onChange={(e) => setPrefs({ minSeverity: e.target.value as any })} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "3px 6px", background: "var(--surface)", color: "var(--text)" }}>
                <option value="CRITICAL">CRITICAL (default)</option>
                <option value="WARNING">WARNING + Critical</option>
                <option value="INFO">everything</option>
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={prefs.downSound} onChange={(e) => setPrefs({ downSound: e.target.checked })} />
              Beep on new / escalated alerts
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={prefs.upSound} onChange={(e) => setPrefs({ upSound: e.target.checked })} />
              Chime when an alert resolves
            </label>
            <label style={{ display: "grid", gap: 3 }}>
              Volume
              <input type="range" min={0} max={1} step={0.05} value={prefs.volume}
                onChange={(e) => setPrefs({ volume: Number(e.target.value) })} />
            </label>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
            <span style={{ color: "var(--muted)", fontSize: 11 }}>Browsers block audio until you interact — this popup counts.</span>
            <button className="ndm-btn" onClick={testSound}>▶ Test sound</button>
          </div>
        </div>
      )}
    </div>
  );
}