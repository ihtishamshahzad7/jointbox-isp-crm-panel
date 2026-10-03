"use client";

import { useRef, useState } from "react";
import API_BASE from "./api";

const API =
  API_BASE;

/**
 * MEDIA TOKENS — how an <img> proves the viewer is signed in.
 *
 * Uploaded files (CNIC scans, photos) are no longer public: the server shows
 * one only to signed-in staff of the company that uploaded it. An <img src>
 * cannot send an Authorization header, so the URL carries a short-lived media
 * token (`?mt=`) that opens pictures and nothing else — the operator API
 * refuses it. It is tied to the signed-in account (`sub`), so switching
 * account ("act as") fetches a fresh one.
 */
const MEDIA_KEY = "mediaToken";
type Media = { token: string; sub: number; exp: number };

function readMedia(): Media | null {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(localStorage.getItem(MEDIA_KEY) || "null"); } catch { return null; }
}

function currentSub(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const t = localStorage.getItem("token") || "";
    const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return Number(p?.sub) || null;
  } catch { return null; }
}

/** A media token for the signed-in account that is good for at least `minMs` more. */
export function hasFreshMediaToken(minMs = 60 * 60 * 1000): boolean {
  const m = readMedia();
  return !!m && m.sub === currentSub() && m.exp - Date.now() > minMs;
}

let inflight: Promise<void> | null = null;

/** Fetch (or renew) the media token. Never throws; images just fail to load without one. */
export function ensureMediaToken(force = false): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (!force && hasFreshMediaToken()) return Promise.resolve();
  if (inflight) return inflight;
  const token = localStorage.getItem("token");
  if (!token) return Promise.resolve();
  inflight = fetch(`${API}/uploads/media-token`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d?.token) {
        localStorage.setItem(MEDIA_KEY, JSON.stringify({ token: d.token, sub: Number(d.sub), exp: Date.parse(d.expiresAt) }));
      }
    })
    .catch(() => undefined)
    .finally(() => { inflight = null; });
  return inflight;
}

/** Forget the media token (sign-out). */
export function clearMediaToken() {
  try { localStorage.removeItem(MEDIA_KEY); } catch { /* ignore */ }
}

// Turn a stored "/uploads/xyz.jpg" into a full URL the browser can load.
export function fileUrl(u?: string | null): string {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  const url = `${API}${u.startsWith("/") ? "" : "/"}${u}`;
  if (!/(^|\/)uploads\//.test(u)) return url;
  const m = readMedia();
  return m?.token ? `${url}${url.includes("?") ? "&" : "?"}mt=${encodeURIComponent(m.token)}` : url;
}

type Props = {
  label: string;
  value?: string | null;
  onChange: (url: string) => void;
  /** "avatar" = round, small; "card" = wide rectangle (for CNIC). */
  shape?: "avatar" | "card";
  /** Allow PDFs too (e.g. uploaded identity documents), not just images. */
  allowPdf?: boolean;
};

export default function ImageUpload({ label, value, onChange, shape = "card", allowPdf = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const round = shape === "avatar";
  const boxW = round ? 96 : 160;
  const boxH = round ? 96 : 100;

  async function pick(file?: File | null) {
    if (!file) return;
    setErr("");
    setBusy(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`${API}/uploads`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message || "Upload failed");
      onChange(j.url);
    } catch (e: any) {
      setErr(e?.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          onClick={() => !busy && inputRef.current?.click()}
          style={{
            width: boxW,
            height: boxH,
            borderRadius: round ? "50%" : 10,
            border: "1px dashed var(--border)",
            background: "var(--surface-2)",
            cursor: busy ? "wait" : "pointer",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "var(--muted)",
            textAlign: "center",
            flexShrink: 0,
          }}
        >
          {value ? (
            /\.pdf($|\?)/i.test(value) ? (
              <span style={{ fontSize: 22 }}>📄<br /><span style={{ fontSize: 10 }}>PDF</span></span>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl(value)} alt={label} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            )
          ) : busy ? (
            "Uploading…"
          ) : (
            <span>+ Upload<br />{allowPdf ? "file" : "image"}</span>
          )}
        </div>
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--muted)",
              borderRadius: 8,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Remove
          </button>
        )}
      </div>
      {err && <span style={{ fontSize: 11, color: "#ef4444" }}>{err}</span>}
      <input
        ref={inputRef}
        type="file"
        accept={allowPdf ? "image/*,application/pdf" : "image/*"}
        style={{ display: "none" }}
        onChange={(e) => pick(e.target.files?.[0])}
      />
    </div>
  );
}
