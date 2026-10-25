"use client";

import Link from "next/link";
import { Logo } from "./components/logo";
import { NetworkScene } from "./components/landing/network-scene";
import { LanguagePicker } from "./components/landing/language-picker";
import s from "./components/landing/landing.module.css";
import { BRAND } from "../lib/brand";
import { useI18n } from "../lib/i18n";

/**
 * Landing page. Brand name, support contact and hero copy all resolve through
 * lib/brand + lib/i18n, so a white-label deployment can point this page at any
 * company and any language. Every number in the previews is example data and
 * is labelled as such on the page.
 */

const SUPPORT = BRAND.supportEmail;

function Check() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 12.5l4.2 4.2L19 7" />
    </svg>
  );
}

const MODULES = [
  {
    title: "RADIUS & MikroTik",
    body: "PPPoE and hotspot logins, CoA disconnects and per-router sync status, without opening WinBox.",
    icon: <><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 17h.01M11 17h.01M8 10a5.5 5.5 0 0 1 8 0M5.5 7.5a9 9 0 0 1 13 0" /></>,
  },
  {
    title: "Billing & wallets",
    body: "Invoices in rupees, prepaid wallets, and top-ups down the franchise → dealer → retailer chain.",
    icon: <><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M3 10h18M16 15h2" /></>,
  },
  {
    title: "Outage intelligence",
    body: "Session drops grouped by router and area, so you see one dead splitter instead of two hundred calls.",
    icon: <><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>,
  },
  {
    title: "Multi-company",
    body: "Host many ISPs on one server. Each sees only its own subscribers, routers and money.",
    icon: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  },
];

/** The 24-hour sessions curve in the preview: y 0–14k → 120–10, x 0–24 h → 34–590. */
const CURVE = "M34 72 L57 78 L80 86 L103 92 L126 95 L149 93 L172 84 L195 72 L218 63 L241 58 L264 55 L287 52 L310 51 L333 53 L356 52 L379 49 L402 44 L425 37 L448 30 L471 25 L494 22 L517 24 L540 33 L563 46 L590 58";

function tilt(e: React.PointerEvent<HTMLElement>) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width - 0.5;
  const y = (e.clientY - r.top) / r.height - 0.5;
  el.style.transform = `rotateY(${(x * 12).toFixed(2)}deg) rotateX(${(-y * 12).toFixed(2)}deg) translateZ(6px)`;
}

export default function HomePage() {
  const { t } = useI18n();

  return (
    <main id="main" className={s.root}>
      <div className={s.aurora} aria-hidden="true" />

      <div className={s.wrap}>
        <nav className={s.nav} aria-label="Main">
          <Link href="/" aria-label={`${BRAND.name} home`} style={{ textDecoration: "none" }}>
            <Logo size={40} withText tone="onDark" />
          </Link>
          <div className={s.navLinks}>
            <a className={`${s.navLink} ${s.hideSm}`} href="#modules">{t("Features")}</a>
            <a className={`${s.navLink} ${s.hideSm}`} href="/documentation.html" target="_blank" rel="noopener noreferrer">{t("Documentation")}</a>
            <LanguagePicker />
            <Link className={`${s.btn} ${s.primary} ${s.small}`} href="/login">{t("Sign In →")}</Link>
          </div>
        </nav>

        <header className={s.hero}>
          <div>
            <span className={s.eyebrow}><i aria-hidden="true" />{t("ISP Management Platform")}</span>
            <h1 className={s.h1}>
              {t("Run your whole")} <span className={s.lit}>{t("network from one panel")}</span>
            </h1>
            <p className={s.lede}>
              {BRAND.tagline || (
                <>
                  {BRAND.name} brings subscriber management, MikroTik and RADIUS integration, billing,
                  reseller hierarchy, ticketing and real-time network monitoring together in one place.
                </>
              )}
            </p>
            <div className={s.ctas}>
              <Link className={`${s.btn} ${s.primary}`} href="/login">{t("Access Dashboard →")}</Link>
              <a className={s.btn} href="/documentation.html" target="_blank" rel="noopener noreferrer">{t("Documentation")}</a>
            </div>
            <ul className={s.proof}>
              <li><Check />{t("MikroTik + RADIUS control")}</li>
              <li><Check />{t("Reseller hierarchy & wallets")}</li>
              <li><Check />{t("Isolated per-account data")}</li>
              <li><Check />{t("Billing, tickets & reports")}</li>
            </ul>
          </div>

          <NetworkScene
            variant="hero"
            className={s.scene}
            label={t("3D view of a fiber network: a core router feeding six distribution points and the homes behind them, with one sector offline.")}
          >
            <div className={`${s.float} ${s.fOnline}`} aria-hidden="true">
              <div className={s.k}><span className={s.dot} style={{ background: "var(--online)" }} />{t("Online now")}</div>
              <div className={s.v}>12,480</div>
              <div className={s.s}><span className={s.up}>▲ 312</span> {t("in the last hour")}</div>
              <svg viewBox="0 0 180 34" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="jbSpark" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#B9A4FF" stopOpacity=".45" />
                    <stop offset="1" stopColor="#B9A4FF" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0 26 L15 24 L30 25 L45 20 L60 22 L75 17 L90 18 L105 13 L120 15 L135 10 L150 11 L165 6 L180 7 L180 34 L0 34 Z" fill="url(#jbSpark)" />
                <path d="M0 26 L15 24 L30 25 L45 20 L60 22 L75 17 L90 18 L105 13 L120 15 L135 10 L150 11 L165 6 L180 7" fill="none" stroke="#B9A4FF" strokeWidth="1.8" />
                <circle cx="178" cy="7" r="2.6" fill="#ECE9F8" />
              </svg>
            </div>

            <div className={`${s.float} ${s.fRadius}`} aria-hidden="true">
              <div className={s.k}><span className={s.dot} style={{ background: "var(--lilac)" }} />{t("RADIUS · last minute")}</div>
              <div className={s.v}>99.98%</div>
              <div className={s.s}>{t("Access-Accept rate")}</div>
              <div className={s.row}><span>pppoe user-10482</span><span>Accept</span></div>
              <div className={s.row}><span>pppoe user-20917</span><span>Accept</span></div>
              <div className={s.row}><span>CoA · OLT-2</span><span>ACK</span></div>
            </div>

            <div className={`${s.float} ${s.fOutage}`} aria-hidden="true">
              <div className={s.k}><span className={s.dot} style={{ background: "var(--down)" }} />{t("Outage detected")}</div>
              <div className={s.t}>Sector G-11 · OLT-4</div>
              <div className={s.s}>{t("14 homes offline since 18:02 · splitter suspected")}</div>
            </div>

            <div className={s.sampleTag}>{t("Panel preview · sample data")}</div>
          </NetworkScene>
        </header>

        <div className={s.stats}>
          {[
            // Each figure is checkable in the code: the UserRole enum (7), LANGS
            // in lib/i18n (5), AES-256-GCM in common/crypto-box.ts. The old
            // "8 roles / 50+ features / 100%" were not.
            ["7", t("User Roles")],
            ["5", t("Languages")],
            ["AES-256", t("Encrypted router secrets")],
            ["1 → many", t("Companies on one server")],
          ].map(([value, label]) => (
            <div key={label} className={s.stat}>
              <b><span>{value}</span></b>
              <small>{label}</small>
            </div>
          ))}
        </div>

        <section id="modules" className={s.section} aria-labelledby="jb-mod-h">
          <span className={s.label}>{t("Core Modules")}</span>
          <h2 id="jb-mod-h" className={s.h2}>{t("Everything an ISP runs on, wired together")}</h2>
          <p className={s.sub}>{t("One account tree from the platform down to the last subscriber: every login, payment and fault lands in the right company's books.")}</p>
          <div className={s.modules}>
            {MODULES.map((m) => (
              <article key={m.title} className={s.mod} onPointerMove={tilt} onPointerLeave={(e) => { e.currentTarget.style.transform = ""; }}>
                <div className={s.chip}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">{m.icon}</svg>
                </div>
                <h3>{t(m.title)}</h3>
                <p>{t(m.body)}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={s.section} aria-labelledby="jb-gl-h">
          <div className={s.glance}>
            <div>
              <span className={s.label}>{t("At a glance")}</span>
              <h2 id="jb-gl-h" className={s.h2}>{t("Your morning check, before the first call")}</h2>
              <p className={s.sub}>{t("Active subscribers, revenue this month, routers that dropped overnight and the tickets waiting for you, on the first screen after sign-in.")}</p>
            </div>
            <div className={s.stage} aria-hidden="true">
              <div className={s.panel}>
                <div className={s.panelTop}><i /><i /><i /><span>{BRAND.name.toLowerCase()} · dashboard · {t("sample data")}</span></div>
                <div className={s.tiles}>
                  <div className={s.tile}><div className={s.k}>{t("Active subscribers")}</div><div className={s.v}>12,480</div><div className={s.d} style={{ color: "var(--online)" }}>▲ 2.6%</div></div>
                  <div className={s.tile}><div className={s.k}>{t("Revenue this month")}</div><div className={s.v}>Rs 18.6M</div><div className={s.d} style={{ color: "var(--online)" }}>▲ 4.1%</div></div>
                  <div className={s.tile}><div className={s.k}>{t("Routers up")}</div><div className={s.v}>46 / 48</div><div className={s.d} style={{ color: "var(--warn)" }}>{t("2 need a look")}</div></div>
                  <div className={s.tile}><div className={s.k}>{t("Open tickets")}</div><div className={s.v}>23</div><div className={s.d} style={{ color: "var(--muted)" }}>{t("6 overdue")}</div></div>
                </div>
                <div className={s.chart}>
                  <div className={s.k}>{t("Online sessions · last 24 h")}</div>
                  <svg viewBox="0 0 600 150">
                    <defs>
                      <linearGradient id="jbArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="#8B6CFF" stopOpacity=".55" />
                        <stop offset="1" stopColor="#E9408B" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <text x="0" y="14">14k</text><text x="4" y="67">7k</text><text x="18" y="123">0</text>
                    <text x="34" y="142">00:00</text><text x="167" y="142">06:00</text><text x="301" y="142">12:00</text><text x="440" y="142">18:00</text><text x="560" y="142">24:00</text>
                    <g stroke="rgba(185,164,255,.12)"><line x1="34" y1="10" x2="590" y2="10" /><line x1="34" y1="65" x2="590" y2="65" /><line x1="34" y1="120" x2="590" y2="120" /></g>
                    <path d={`${CURVE} L590 120 L34 120 Z`} fill="url(#jbArea)" />
                    <path d={CURVE} fill="none" stroke="#B9A4FF" strokeWidth="2.2" />
                    <circle cx="494" cy="22" r="4" fill="#ECE9F8" />
                    <text x="436" y="16" className={s.peak}>peak 12.7k</text>
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className={s.ctaBand}>
          <h2 className={s.h2}>{t("Bring your first router online today")}</h2>
          <div className={s.ctas}>
            <Link className={`${s.btn} ${s.primary}`} href="/login">{t("Access Dashboard →")}</Link>
            <a className={s.btn} href="/documentation.html" target="_blank" rel="noopener noreferrer">{t("Documentation")}</a>
          </div>
        </div>

        <footer className={s.footer}>
          <span>© {new Date().getFullYear()} <strong>{BRAND.name}</strong> · {BRAND.subtitle}</span>
          <span>{t("Support:")} <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a></span>
        </footer>
      </div>
    </main>
  );
}
