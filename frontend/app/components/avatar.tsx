"use client";

import { fileUrl } from "./image-upload";

/**
 * Avatar — a profile picture, or the person's initials when there isn't one.
 *
 * WHY THE FALLBACK MATTERS
 * Subscribers and users have had a photo field for a while, but uploading one
 * is optional and most records don't have it. A broken <img> or an empty grey
 * square in every row looks like a bug; initials on a tinted circle look
 * deliberate, which is what TailAdmin does. So this component never renders a
 * failed image — it decides up front.
 *
 * The tint is derived from the name, so the same person is always the same
 * colour and a list of rows reads as distinct people at a glance.
 */

const TINTS = [
  { bg: "#EEF2FF", fg: "#3C50E0" },  // primary
  { bg: "#E6F6FB", fg: "#0FADCF" },  // meta.10
  { bg: "#E7F6EC", fg: "#219653" },  // success
  { bg: "#FFF4E5", fg: "#F0950C" },  // meta.8
  { bg: "#FDECEE", fg: "#D34053" },  // danger
  { bg: "#EEF0FE", fg: "#6577F3" },  // mid blue
];

function initials(name?: string | null): string {
  const n = (name || "").trim();
  if (!n) return "?";
  const parts = n.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || "";
  // Second initial comes from the LAST word, not the second: "Muhammad Ali
  // Khan" should read MK, which is how people abbreviate their own names.
  const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + second).toUpperCase() || "?";
}

function tintFor(name?: string | null) {
  const n = (name || "").trim();
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

export default function Avatar({
  name,
  photoUrl,
  size = 36,
  title,
}: {
  name?: string | null;
  photoUrl?: string | null;
  size?: number;
  title?: string;
}) {
  const tint = tintFor(name);
  const common: React.CSSProperties = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flex: "none",
    userSelect: "none",
  };

  if (photoUrl) {
    return (
      <span style={common} title={title || name || undefined}>
        <img
          src={fileUrl(photoUrl)}
          alt={name || "Profile picture"}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          /* If the file is missing or unreadable the browser would draw a
             broken-image glyph. Swapping to the initials keeps the row tidy
             instead of advertising the failure. */
          onError={(e) => {
            const el = e.currentTarget;
            el.style.display = "none";
            const parent = el.parentElement;
            if (parent) {
              parent.style.background = tint.bg;
              parent.style.color = tint.fg;
              parent.style.fontWeight = "600";
              parent.style.fontSize = `${Math.round(size * 0.38)}px`;
              parent.textContent = initials(name);
            }
          }}
        />
      </span>
    );
  }

  return (
    <span
      style={{
        ...common,
        background: tint.bg,
        color: tint.fg,
        fontWeight: 600,
        fontSize: Math.round(size * 0.38),
        letterSpacing: 0.2,
      }}
      title={title || name || undefined}
    >
      {initials(name)}
    </span>
  );
}
