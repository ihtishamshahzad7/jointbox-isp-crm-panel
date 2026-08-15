"use client";

import Link from "next/link";
import { useState } from "react";
import { Logo } from "./components/logo";
import { BRAND } from "../lib/brand";
import { LANGS, useI18n } from "../lib/i18n";

/**
 * Landing page — Nova style. Brand name, support contact and hero copy all
 * resolve through lib/brand + lib/i18n, so a white-label deployment can point
 * this page at any company and any language.
 */

const NOVA = "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)";
const SUPPORT = BRAND.supportEmail;

export default function HomePage() {
  const { t, lang, setLang } = useI18n();
  const [langOpen, setLangOpen] = useState(false);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#080b12",
        color: "#fff",
        overflow: "hidden",
        position: "relative",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      {/* Grid + Nova glows */}
      <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(140,90,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(140,90,255,0.04) 1px, transparent 1px)", backgroundSize: "40px 40px" }} />
      <div style={{ position: "absolute", width: 500, height: 500, background: "radial-gradient(circle, rgba(108,60,225,0.16) 0%, transparent 70%)", top: -200, left: -150, filter: "blur(80px)" }} />
      <div style={{ position: "absolute", width: 420, height: 420, background: "radial-gradient(circle, rgba(242,113,33,0.12) 0%, transparent 70%)", bottom: -150, right: -100, filter: "blur(80px)" }} />

      {/* Navbar */}
      <nav style={{ width: "100%", padding: "22px 60px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative", zIndex: 10 }}>
        <Logo size={40} withText />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* Language picker */}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setLangOpen((o) => !o)}
              style={{ padding: "10px 16px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 13, transition: "all 0.2s", display: "inline-flex", alignItems: "center", gap: 8 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; }}
            >
              🌐 {LANGS.find((l) => l.code === lang)?.native ?? "English"}
            </button>
            {langOpen && (
              <div style={{ position: "absolute", right: 0, top: 44, zIndex: 50, width: 180,
                background: "#0f1625", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 6,
                boxShadow: "0 20px 50px rgba(0,0,0,.5)" }}>
                {LANGS.map((l) => (
                  <button
                    key={l.code}
                    type="button"
                    onClick={() => { setLang(l.code); setLangOpen(false); }}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%",
                      background: lang === l.code ? "rgba(233,64,139,.14)" : "transparent", border: "none", color: "#fff",
                      borderRadius: 8, padding: "8px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
                  >
                    <span>{l.native}</span>
                    {lang === l.code && <span style={{ color: "#F9A8D4" }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Link href="/login">
            <button
              style={{ padding: "10px 24px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 14, transition: "all 0.2s" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; }}
            >
              {t("Sign In →")}
            </button>
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section style={{ maxWidth: 1300, margin: "0 auto", padding: "60px 40px 80px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 60, flexWrap: "wrap", position: "relative", zIndex: 2 }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          <div style={{ fontSize: 13, letterSpacing: "0.15em", marginBottom: 20, textTransform: "uppercase", fontWeight: 700, background: "linear-gradient(90deg,#C4B5FD,#F9A8D4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            {t("ISP Management Platform")}
          </div>

          <h1 style={{ fontSize: 62, lineHeight: 1.08, fontWeight: 800, marginBottom: 24, letterSpacing: "-0.03em" }}>
            {t("Run your whole")}
            <br />
            {t("network from one panel")}
          </h1>

          <p style={{ fontSize: 15, color: "#94a3b8", lineHeight: 1.7, maxWidth: 600, marginBottom: 32 }}>
            {BRAND.tagline || (
              <>
                {BRAND.name} brings subscriber management, MikroTik and RADIUS integration, billing,
                reseller hierarchy, ticketing and real-time network monitoring together in one
                place — built for franchises, dealers and retailers under a single ISP.
              </>
            )}
          </p>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Link href="/login">
              <button
                style={{ padding: "14px 28px", borderRadius: 12, border: "none", background: NOVA, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", boxShadow: "0 6px 20px rgba(233,64,139,0.35)", transition: "all 0.2s" }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 10px 28px rgba(233,64,139,0.45)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 6px 20px rgba(233,64,139,0.35)"; }}
              >
                {t("Access Dashboard →")}
              </button>
            </Link>

            <a
              href="/documentation.html" target="_blank" rel="noopener noreferrer"
              style={{ padding: "14px 28px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer", transition: "all 0.2s", textDecoration: "none", display: "inline-block" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; }}
            >
              {t("Documentation")}
            </a>
          </div>

          {/* Stats */}
          <div style={{ display: "flex", gap: 48, marginTop: 60, flexWrap: "wrap", paddingTop: 20, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            {[
              ["12", t("Core Modules")],
              ["50+", t("Features")],
              ["8", t("User Roles")],
              ["100%", t("Multi-tenant")],
            ].map(([value, label]) => (
              <div key={label}>
                <div style={{ fontSize: 32, fontWeight: 800, background: NOVA, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>{value}</div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 4, letterSpacing: 0.3 }}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Right card — real product surface, no AI */}
        <div style={{ width: 400, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 24, padding: 28, backdropFilter: "blur(12px)", boxShadow: "0 20px 40px rgba(0,0,0,0.3)" }}>
          <div style={{ fontSize: 11, marginBottom: 20, letterSpacing: "0.12em", fontWeight: 700, textTransform: "uppercase", background: "linear-gradient(90deg,#C4B5FD,#F9A8D4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            {t("At a glance")}
          </div>

          {[
            [t("Revenue this month"), "Rs 1,84,200", NOVA],
            [t("Active subscribers"), "18,249", "#fff"],
          ].map(([label, value, color]) => (
            <div key={String(label)} style={{ background: "#0f1625", borderRadius: 16, padding: 18, marginBottom: 14, border: "1px solid rgba(255,255,255,0.05)" }}>
              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 8 }}>{label}</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: color === "#fff" ? "#fff" : undefined, background: color !== "#fff" ? color : undefined, WebkitBackgroundClip: color !== "#fff" ? "text" : undefined, WebkitTextFillColor: color !== "#fff" ? "transparent" : undefined }}>{value}</div>
            </div>
          ))}

          <div style={{ background: "#0f1625", borderRadius: 16, padding: 18, border: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>{t("Built in")}</div>
            <div style={{ color: "#6EE7B7", lineHeight: 1.9, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
              ✓ {t("MikroTik + RADIUS control")}<br />
              ✓ {t("Reseller hierarchy & wallets")}<br />
              ✓ {t("Isolated per-account data")}<br />
              ✓ {t("Billing, tickets & reports")}
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ position: "relative", zIndex: 2, textAlign: "center", padding: "30px 20px", borderTop: "1px solid rgba(255,255,255,0.05)", marginTop: 40 }}>
        <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>
          © {new Date().getFullYear()} <strong style={{ color: "#C4B5FD" }}>{BRAND.name}</strong> · {BRAND.subtitle} ·{" "}
          {t("Support:")} <a href={`mailto:${SUPPORT}`} style={{ color: "#F9A8D4", textDecoration: "none" }}>{SUPPORT}</a>
        </p>
      </footer>
    </main>
  );
}
