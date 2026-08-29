import React from "react";

/**
 * Jointbox UI refresh layer.
 *
 * This is intentionally a presentation-only layer: it does not change data,
 * routes, permissions, or business logic. Existing pages/components keep their
 * current markup while sharing one modern visual language.
 */
export function ModernUI() {
  return (
    <style>{`
      :root {
        --jb-radius: 10px;
        --jb-radius-sm: 7px;
        --jb-shadow: 0 8px 24px rgba(15,23,42,.06);
        --jb-shadow-hover: 0 12px 30px rgba(15,23,42,.10);
      }

      body.app-font { font-family: Satoshi, Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      button, input, select, textarea { font: inherit; }
      button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      /* Shared page rhythm */
      .db-root main, .app-shell-page-content { max-width: 100%; }
      .nv-page, .sd-root { animation: jbPageIn .22s ease-out both; }
      @keyframes jbPageIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

      /* Modern cards/panels */
      .nv-card, .st, .nt, .lrt, .sd-panel, .sd-kpi {
        border-radius: var(--jb-radius) !important;
        box-shadow: var(--jb-shadow) !important;
      }
      .nv-card:hover, .sd-panel:hover { box-shadow: var(--jb-shadow-hover) !important; }
      .sd-panel-h, .nv-card-h { padding: 16px 18px !important; }
      .sd-panel-b, .nv-card > :not(.nv-card-h) { padding-left: 18px; padding-right: 18px; }

      /* Page headings */
      .nv-pagehead { margin-bottom: 20px !important; }
      .nv-pagehead h1 {
        background: none !important;
        -webkit-text-fill-color: initial !important;
        color: var(--text) !important;
        font-size: clamp(24px, 2vw, 30px) !important;
        letter-spacing: -.035em !important;
      }
      .nv-pagehead p { max-width: 760px !important; }

      /* Controls */
      .nv-btn, .sd-btn {
        border-radius: var(--jb-radius-sm) !important;
        min-height: 34px;
        transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease, background .15s ease !important;
      }
      .nv-btn:hover:not(:disabled), .sd-btn:hover:not(:disabled) { transform: translateY(-1px); }
      .nv-btn.primary, .sd-btn.primary {
        background: var(--accent) !important;
        box-shadow: 0 5px 14px rgba(60,80,224,.18) !important;
      }
      .nv-btn.primary:hover:not(:disabled), .sd-btn.primary:hover:not(:disabled) {
        box-shadow: 0 8px 20px rgba(60,80,224,.24) !important;
      }
      .nv-input, .nv-select, .nv-textarea, .sd-field input, .sd-field select, .sd-field textarea {
        border-radius: var(--jb-radius-sm) !important;
        min-height: 36px;
      }

      /* Subscriber list: information hierarchy + compact enterprise table */
      .st {
        overflow: hidden !important;
        background: var(--surface) !important;
      }
      .st table { border-spacing: 0 !important; }
      .st thead th {
        height: 42px;
        padding: 9px 11px !important;
        background: var(--surface-2) !important;
        color: var(--muted) !important;
        font-size: 10px !important;
        font-weight: 800 !important;
        letter-spacing: .065em !important;
        text-transform: uppercase;
        border-bottom: 1px solid var(--border) !important;
      }
      .st tbody td {
        padding: 10px 11px !important;
        border-bottom: 1px solid var(--border) !important;
        vertical-align: middle;
      }
      .st tbody tr { background: var(--surface); transition: background .12s ease, box-shadow .12s ease; }
      .st tbody tr:hover { background: var(--surface-2) !important; }
      .st tbody tr.on { background: rgba(60,80,224,.055) !important; box-shadow: inset 3px 0 0 var(--accent); }
      .st .who { gap: 9px !important; }
      .st .av { width: 34px !important; height: 34px !important; border-radius: 9px !important; font-size: 11px !important; }
      .st .nm { font-size: 12.5px !important; font-weight: 750 !important; }
      .st .sub { font-size: 10.5px !important; line-height: 1.35 !important; }
      .st .chip { border-radius: 6px !important; padding: 4px 7px !important; font-size: 10.5px !important; }
      .st .pill { border-radius: 999px !important; padding: 4px 8px !important; font-size: 10px !important; font-weight: 800 !important; }
      .st .act { white-space: nowrap; }
      .st .act button { border-radius: 6px !important; min-height: 28px; padding: 4px 8px !important; }
      .st .statusbar { min-height: 38px; padding: 7px 11px !important; background: var(--surface-2) !important; border-top: 0 !important; }
      .st .srt { cursor: pointer; user-select: none; }
      .st .srt:hover { color: var(--accent) !important; }
      .st .rsz { opacity: .25; }

      /* Subscriber 360 header */
      .sd-root { gap: 14px !important; }
      .sd-top { align-items: center !important; }
      .sd-back { min-height: 32px; padding: 5px 8px !important; border-radius: 6px !important; }
      .sd-back:hover { background: var(--surface-2) !important; }
      .sd-title-block {
        padding: 16px 18px;
        border: 1px solid var(--border);
        border-radius: var(--jb-radius);
        background: var(--surface);
        box-shadow: var(--jb-shadow);
        align-items: flex-start !important;
      }
      .sd-avatar { width: 46px !important; height: 46px !important; border-radius: 11px !important; flex: 0 0 auto; }
      .sd-title h1 { font-size: 22px !important; letter-spacing: -.035em !important; }
      .sd-title h1 code { font-size: 10px !important; font-weight: 600 !important; }
      .sd-status-row { gap: 5px !important; }
      .sd-chip { border: 1px solid rgba(100,116,139,.12); }

      /* 360 navigation: horizontal, sticky, keyboard friendly */
      .sd-tabs {
        position: sticky !important;
        top: 0;
        z-index: 20;
        display: flex !important;
        gap: 2px !important;
        overflow-x: auto;
        padding: 4px !important;
        border: 1px solid var(--border);
        border-radius: 9px;
        background: color-mix(in srgb, var(--surface) 94%, transparent);
        backdrop-filter: blur(10px);
        scrollbar-width: thin;
      }
      .sd-tab {
        flex: 0 0 auto;
        min-height: 34px;
        padding: 7px 12px !important;
        border-radius: 6px !important;
        color: var(--muted) !important;
        font-size: 11px !important;
        font-weight: 700 !important;
      }
      .sd-tab:hover { background: var(--surface-2) !important; color: var(--text) !important; }
      .sd-tab.on { background: var(--accent) !important; color: #fff !important; box-shadow: 0 3px 9px rgba(60,80,224,.18); }

      /* Detail KPIs */
      .sd-kpi { padding: 13px 14px !important; }
      .sd-kpi-label { font-size: 9.5px !important; letter-spacing: .06em; text-transform: uppercase; font-weight: 800; }
      .sd-kpi-value { font-size: 21px !important; margin-top: 4px; }

      /* Drawers/modals */
      .sd-modal, .sd-drawer {
        border-radius: 12px !important;
        box-shadow: 0 24px 70px rgba(15,23,42,.22) !important;
        border: 1px solid var(--border) !important;
      }
      .sd-modal-h, .sd-drawer-h { padding: 16px 18px !important; }
      .sd-modal-b, .sd-drawer-b { padding: 18px !important; }

      /* Mobile: preserve functionality, make dense pages touch-friendly */
      @media (max-width: 768px) {
        .nv-pagehead { flex-direction: column !important; align-items: stretch !important; gap: 12px !important; }
        .nv-pagehead-actions { justify-content: flex-start !important; }
        .sd-title-block { flex-wrap: wrap; }
        .sd-menu-wrap { width: 100%; }
        .sd-menu-wrap > div:first-child { justify-content: flex-start !important; }
        .sd-tabs { top: 0; }
        .st { overflow-x: auto !important; }
        .st table { min-width: 860px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .nv-page, .sd-root { animation: none !important; }
        .nv-btn, .sd-btn, .st tbody tr { transition: none !important; }
      }
    `}</style>
  );
}

export default ModernUI;
