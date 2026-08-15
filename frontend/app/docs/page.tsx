"use client";

import React from "react";
import { useRouter } from "next/navigation";
import API from "../components/api";
import { SkeletonCards } from "../components/skeleton";
import { BRAND } from "../../lib/brand";

/**
 * Documentation — every feature, what it does, where it lives and when to use it.
 *
 * It renders the SAME knowledge base the built-in assistant answers from
 * (/ai/docs), so the docs and the AI can never disagree: update the KB once and
 * both change together.
 */

/** Group topics by keyword so the page reads as chapters, not a flat list. */
const SECTIONS: { id: string; label: string; icon: string; match: RegExp }[] = [
  { id: "start",    label: "Getting started",     icon: "🚀", match: /getting started|find your way|setup|checklist|update the panel|keyboard|theme/i },
  { id: "daily",    label: "Daily work",          icon: "⚡", match: /my work|my business|quick connect|renewal|subscriber|trace|search|import|export|note/i },
  { id: "money",    label: "Billing & money",     icon: "💰", match: /invoice|payment|wallet|billing|collection|earning|commission|price|pricing|voucher|refund|credit|accounting|ledger|balance|reversal|tax/i },
  { id: "network",  label: "Network & NAS",       icon: "📡", match: /nas|router|mikrotik|radius|traffic|mrtg|vlan|signal|dbm|uptime|pool|ip |static|fiber|olt|onu|outage|operations|link|port|interface|noc|coa|boost|speed/i },
  { id: "people",   label: "People & access",     icon: "👥", match: /user|reseller|dealer|franchise|staff|role|permission|hierarchy|kyc|cnic|auditor|demo|login|password|security/i },
  { id: "alerts",   label: "Alerts & messaging",  icon: "🔔", match: /alert|discord|whatsapp|sms|notify|notification|message|communication|template/i },
  { id: "advanced", label: "Advanced & admin",    icon: "🛠", match: /console|freeradius|database|backup|job|queue|api|integration|log|scale|segment|analytic|report|insight/i },
];

export default function DocsPage() {
  const router = useRouter();
  const [topics, setTopics] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const [section, setSection] = React.useState("all");
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : "";

  React.useEffect(() => {
    if (!token) { router.push("/login"); return; }
    fetch(`${API}/ai/docs`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setTopics(d?.topics || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  /** Assign each topic to the first section it matches; rest go to Advanced. */
  const sectionOf = (t: any) => {
    const hay = `${t.title} ${t.keywords}`;
    return SECTIONS.find((s) => s.match.test(hay))?.id ?? "advanced";
  };

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return topics.filter((t) => {
      if (section !== "all" && sectionOf(t) !== section) return false;
      if (!needle) return true;
      return `${t.title} ${t.keywords} ${t.answer}`.toLowerCase().includes(needle);
    });
  }, [topics, q, section]);

  const counts = React.useMemo(() => {
    const m: Record<string, number> = {};
    topics.forEach((t) => { const s = sectionOf(t); m[s] = (m[s] || 0) + 1; });
    return m;
  }, [topics]);

  return (
    <div className="doc">
      <style>{CSS}</style>

      <div className="doc-hero">
        <h1>Documentation</h1>
        <p>Every feature in {BRAND.name} — what it does, where to find it, and when to use it.
          The built-in assistant (✦, bottom-right) answers from this same guide, so you can
          either browse here or just ask it.</p>
        <div className="doc-search">
          <span>⌕</span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search — e.g. 'renew', 'discord alert', 'vlan', 'grace period'…" />
          {q && <button onClick={() => setQ("")}>×</button>}
        </div>
      </div>

      <div className="doc-tabs">
        <button className={section === "all" ? "on" : ""} onClick={() => setSection("all")}>
          All <i>{topics.length}</i>
        </button>
        {SECTIONS.map((s) => (
          <button key={s.id} className={section === s.id ? "on" : ""} onClick={() => setSection(s.id)}>
            <span aria-hidden>{s.icon}</span> {s.label} <i>{counts[s.id] || 0}</i>
          </button>
        ))}
      </div>

      {loading ? (
        <SkeletonCards count={6} min={260} />
      ) : filtered.length === 0 ? (
        <div className="doc-empty">
          Nothing matches “{q}”. Try a different word, or ask the ✦ assistant in your own words.
        </div>
      ) : (
        <div className="doc-list">
          {filtered.map((t) => {
            const isOpen = open === t.title;
            return (
              <article key={t.title} className={`doc-item ${isOpen ? "open" : ""}`}>
                <button className="doc-q" onClick={() => setOpen(isOpen ? null : t.title)}>
                  <span className="doc-title">{t.title}</span>
                  <span className="doc-chev">{isOpen ? "−" : "+"}</span>
                </button>
                {isOpen && <div className="doc-a">{t.answer}</div>}
              </article>
            );
          })}
        </div>
      )}

      <div className="doc-foot">
        Can’t find it? Open the ✦ assistant (bottom-right) and ask in your own words —
        it searches this guide and points you at the exact menu path.
      </div>
    </div>
  );
}

const CSS = `
.doc{padding:20px;max-width:920px;margin:0 auto;color:var(--text)}
.doc-hero{margin-bottom:18px}
.doc-hero h1{font-size:26px;font-weight:800;margin:0 0 6px}
.doc-hero p{font-size:13px;color:var(--muted);margin:0 0 14px;line-height:1.7;max-width:70ch}
.doc-search{display:flex;align-items:center;gap:9px;background:var(--surface);
  border:1px solid var(--border);border-radius:12px;padding:0 13px;height:46px}
.doc-search:focus-within{border-color:var(--accent)}
.doc-search span{color:var(--muted);font-size:17px}
.doc-search input{flex:1;background:transparent;border:none;outline:none;color:var(--text);
  font-size:14px;font-family:inherit}
.doc-search button{background:none;border:none;color:var(--muted);font-size:19px;cursor:pointer}

.doc-tabs{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px}
.doc-tabs button{display:inline-flex;align-items:center;gap:6px;background:var(--surface);
  border:1px solid var(--border);color:var(--muted);border-radius:999px;padding:7px 13px;
  font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
.doc-tabs button.on{border-color:var(--accent);color:var(--accent)}
.doc-tabs i{font-style:normal;font-size:10.5px;opacity:.7}

.doc-list{display:grid;gap:8px}
.doc-item{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.doc-item.open{border-color:var(--accent)}
.doc-q{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;
  text-align:left;background:transparent;border:none;color:var(--text);cursor:pointer;
  padding:13px 16px;font-family:inherit}
.doc-title{font-size:13.5px;font-weight:700}
.doc-chev{color:var(--muted);font-size:17px;line-height:1}
.doc-a{padding:0 16px 15px;font-size:13px;color:var(--muted);line-height:1.75;max-width:78ch}

.doc-empty{padding:44px;text-align:center;color:var(--muted);font-size:13px;
  background:var(--surface);border:1px solid var(--border);border-radius:12px}
.doc-foot{margin-top:20px;padding:14px 16px;background:var(--surface-2);
  border:1px solid var(--border);border-radius:12px;font-size:12.5px;color:var(--muted)}
`;
