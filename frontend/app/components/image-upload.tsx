"use client";

import { useRef, useState } from "react";

const API =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

// Turn a stored "/uploads/xyz.jpg" into a full URL the browser can load.
export function fileUrl(u?: string | null): string {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return `${API}${u.startsWith("/") ? "" : "/"}${u}`;
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
