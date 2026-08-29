import React from "react";

/** Global visual layer. Business logic, routes and API contracts stay untouched. */
export function ModernUI() {
  return (
    <style>{`
      :root{--jb-radius:14px;--jb-radius-sm:9px;--jb-shadow:0 8px 28px rgba(15,23,42,.07);--jb-shadow-hover:0 16px 38px rgba(15,23,42,.12)}
      body.app-font{font-family:Inter,Satoshi,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      button,input,select,textarea{font:inherit}
      button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
      .nv-card,.st,.nt,.lrt,.sd-panel,.sd-kpi,.jb-stat{border-radius:var(--jb-radius)!important;box-shadow:var(--jb-shadow)!important}
      .nv-card:hover,.sd-panel:hover,.jb-stat:hover{box-shadow:var(--jb-shadow-hover)!important}
      .nv-page{animation:jbIn .2s ease-out both}
      @keyframes jbIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
      body:has(.st){background:var(--bg)!important}
      body:has(.st) .jb-kpi-row{grid-template-columns:repeat(7,minmax(125px,1fr))!important;gap:12px!important;margin-bottom:18px!important}
      body:has(.st) .jb-stat{position:relative!important;min-height:96px!important;padding:18px 17px 15px!important;background:linear-gradient(145deg,var(--surface),var(--surface-2))!important;border:1px solid var(--border)!important;overflow:hidden!important;transition:transform .16s,box-shadow .16s!important}
      body:has(.st) .jb-stat:after{content:"";position:absolute;right:-24px;bottom:-34px;width:90px;height:90px;border-radius:50%;background:color-mix(in srgb,var(--accent) 9%,transparent);pointer-events:none}
      body:has(.st) .jb-stat:before{content:"";position:absolute;left:0;top:0;right:0;height:3px;background:var(--accent);opacity:.85}
      body:has(.st) .jb-stat .val{font-size:28px!important;line-height:1!important;font-weight:850!important;letter-spacing:-.045em!important}
      body:has(.st) .jb-stat .lbl{margin-top:9px!important;color:var(--muted)!important;font-size:9.5px!important;font-weight:800!important;letter-spacing:.07em!important;text-transform:uppercase!important}
      body:has(.st) input[placeholder*="Search by name"]{height:42px!important;border-radius:10px!important;border:1px solid var(--border)!important;background:var(--surface)!important;box-shadow:var(--jb-shadow)!important;padding-left:34px!important;font-size:12px!important}
      body:has(.st) input[placeholder*="Search by name"]:focus{border-color:var(--accent)!important;box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 12%,transparent),var(--jb-shadow)!important}
      body:has(.st) .jb-status-filters{padding:4px!important;border:1px solid var(--border)!important;border-radius:10px!important;background:var(--surface)!important;box-shadow:0 2px 8px rgba(15,23,42,.04)!important}
      body:has(.st) .jb-status-filters button{min-height:32px!important;border-radius:7px!important;padding:6px 11px!important;font-size:10px!important;font-weight:750!important}
      body:has(.st) .jb-status-filters button:hover{background:var(--surface-2)!important;color:var(--text)!important}
      body:has(.st) .jb-exp-chips{padding:4px!important;border:1px solid var(--border)!important;border-radius:10px!important;background:var(--surface)!important;box-shadow:0 2px 8px rgba(15,23,42,.04)!important}
      body:has(.st) .jb-exp-chips button{border:0!important;border-radius:7px!important;padding:6px 9px!important;font-size:10px!important;font-weight:800!important}
      body:has(.st) .jb-exp-chips button:hover,body:has(.st) .jb-exp-chips button.on{background:color-mix(in srgb,var(--accent) 10%,var(--surface))!important;color:var(--accent)!important}
      body:has(.st) .jb-exp-lbl{font-size:9px!important;font-weight:850!important;padding:0 6px!important}
      body:has(.st) .st{border:1px solid var(--border)!important;border-radius:14px!important;background:var(--surface)!important;box-shadow:0 10px 34px rgba(15,23,42,.08)!important;overflow:hidden!important}
      body:has(.st) .st thead th{height:46px!important;padding:10px 13px!important;background:linear-gradient(180deg,var(--surface-2),var(--surface))!important;color:var(--muted)!important;font-size:9px!important;font-weight:850!important;letter-spacing:.09em!important;border-bottom:1px solid var(--border)!important}
      body:has(.st) .st tbody td{padding:12px 13px!important;border-bottom:1px solid color-mix(in srgb,var(--border) 72%,transparent)!important}
      body:has(.st) .st tbody tr{background:var(--surface)!important;transition:background .14s,box-shadow .14s,transform .14s!important}
      body:has(.st) .st tbody tr:hover{background:color-mix(in srgb,var(--accent) 5%,var(--surface))!important;box-shadow:inset 3px 0 0 var(--accent)!important}
      body:has(.st) .st tbody tr.on{background:color-mix(in srgb,var(--accent) 8%,var(--surface))!important;box-shadow:inset 3px 0 0 var(--accent)!important}
      body:has(.st) .st .av{width:40px!important;height:40px!important;border-radius:11px!important;box-shadow:0 4px 12px rgba(124,77,255,.22)!important}
      body:has(.st) .st .nm{font-size:13px!important;font-weight:750!important}
      body:has(.st) .st .sub{font-size:10px!important}
      body:has(.st) .st .pill{padding:6px 10px!important;border-radius:999px!important;font-size:9.5px!important;font-weight:850!important}
      body:has(.st) .st .chip{padding:5px 9px!important;border-radius:8px!important;font-size:10px!important;font-weight:800!important}
      body:has(.st) .st .badge{padding:3px 8px!important;border-radius:999px!important;font-size:9px!important}
      body:has(.st) .st td.act button{min-height:31px!important;padding:5px 9px!important;border-radius:7px!important;font-size:10px!important}
      body:has(.st) .st .statusbar{min-height:42px!important;padding:8px 13px!important;background:var(--surface-2)!important}
      body:has(.st) .jb-selbar{display:flex!important;align-items:center!important;gap:7px!important;padding:9px 11px!important;margin-bottom:10px!important;border:1px solid color-mix(in srgb,var(--accent) 24%,var(--border))!important;border-radius:10px!important;background:color-mix(in srgb,var(--accent) 6%,var(--surface))!important;box-shadow:0 4px 14px rgba(15,23,42,.05)!important}
      body:has(.st) .jb-selbar-count{font-size:11px!important;font-weight:850!important;color:var(--accent)!important;margin-right:4px!important}
      body:has(.st) .jb-selbar-clear{margin-left:auto!important;background:transparent!important;border:0!important;color:var(--muted)!important;font-size:10px!important;cursor:pointer!important}
      body:has(.st) .jb-selbar-clear:hover{color:var(--accent)!important}
      body:has(.sd-root) .sd-title-block{padding:18px!important;border:1px solid var(--border)!important;border-radius:14px!important;background:var(--surface)!important;box-shadow:var(--jb-shadow)!important}
      body:has(.sd-root) .sd-avatar{width:50px!important;height:50px!important;border-radius:12px!important}
      body:has(.sd-root) .sd-title h1{font-size:24px!important;letter-spacing:-.04em!important}
      body:has(.sd-root) .sd-tabs{position:sticky!important;top:0!important;z-index:20!important;display:flex!important;gap:3px!important;overflow-x:auto!important;padding:4px!important;border:1px solid var(--border)!important;border-radius:10px!important;background:color-mix(in srgb,var(--surface) 95%,transparent)!important;backdrop-filter:blur(12px)!important}
      body:has(.sd-root) .sd-tab{min-height:36px!important;padding:7px 13px!important;border-radius:7px!important;font-size:10.5px!important;font-weight:750!important}
      body:has(.sd-root) .sd-tab.on{background:var(--accent)!important;color:#fff!important;box-shadow:0 5px 14px color-mix(in srgb,var(--accent) 25%,transparent)!important}

      /* ================================================================
         MONITORING 2.0 — NOC-first visual hierarchy.
         Status colours remain semantic: green=up, amber=warning, red=down.
         ================================================================ */
      body:has(.ndmx){background:var(--bg)!important}
      body:has(.ndmx) .ndmx-head{position:relative!important;display:flex!important;align-items:flex-end!important;justify-content:space-between!important;gap:20px!important;margin-bottom:16px!important;padding:4px 0 16px!important;border-bottom:1px solid var(--border)!important}
      body:has(.ndmx) .ndmx-head h1{font-size:26px!important;line-height:1.1!important;letter-spacing:-.035em!important;font-weight:850!important;margin:5px 0 6px!important}
      body:has(.ndmx) .ndmx-head p{max-width:760px!important;margin:0!important;color:var(--muted)!important;font-size:11px!important;line-height:1.55!important}
      body:has(.ndmx) .ndmx-crumb{display:flex!important;gap:7px!important;align-items:center!important;color:var(--muted)!important;font-size:10px!important;font-weight:700!important}
      body:has(.ndmx) .ndmx-crumb a{color:var(--accent)!important;text-decoration:none!important}
      body:has(.ndmx) .ndmx-head-r{display:flex!important;align-items:center!important;gap:7px!important;flex-wrap:wrap!important;justify-content:flex-end!important}
      body:has(.ndmx) .ndmx-tabs{display:flex!important;gap:4px!important;overflow:auto!important;padding:4px!important;margin-bottom:14px!important;border:1px solid var(--border)!important;border-radius:11px!important;background:var(--surface)!important;box-shadow:0 3px 12px rgba(15,23,42,.04)!important}
      body:has(.ndmx) .ndmx-tabs .tab{min-height:35px!important;padding:8px 13px!important;border-radius:8px!important;display:inline-flex!important;align-items:center!important;white-space:nowrap!important;font-size:10.5px!important;font-weight:800!important;color:var(--muted)!important;text-decoration:none!important}
      body:has(.ndmx) .ndmx-tabs .tab.active{background:var(--accent)!important;color:#fff!important;box-shadow:0 4px 12px color-mix(in srgb,var(--accent) 25%,transparent)!important}
      body:has(.ndmx) .ndmx-tabs .tab:hover:not(.active){background:var(--surface-2)!important;color:var(--text)!important}
      body:has(.ndmx) .ndmx .ndm-btn{min-height:34px!important;border-radius:8px!important;padding:7px 11px!important;border:1px solid var(--border)!important;background:var(--surface)!important;color:var(--text)!important;font-size:10px!important;font-weight:800!important;text-decoration:none!important;transition:.15s ease!important}
      body:has(.ndmx) .ndmx .ndm-btn:hover{transform:translateY(-1px)!important;border-color:color-mix(in srgb,var(--accent) 45%,var(--border))!important;box-shadow:0 5px 15px rgba(15,23,42,.08)!important}
      body:has(.ndmx) .ndmx .ndm-btn.pri{border-color:transparent!important;background:var(--accent)!important;color:#fff!important;box-shadow:0 5px 16px color-mix(in srgb,var(--accent) 24%,transparent)!important}
      body:has(.ndmx) .ndmx .ndmx-kpis,body:has(.ndmx) .ndmx .ndm-kpis{display:grid!important;grid-template-columns:repeat(6,minmax(0,1fr))!important;gap:10px!important;margin-bottom:14px!important}
      body:has(.ndmx) .ndmx .ndm-kpi,body:has(.ndmx) .ndmx .kpi{position:relative!important;min-height:78px!important;padding:13px 14px!important;border:1px solid var(--border)!important;border-radius:12px!important;background:var(--surface)!important;box-shadow:var(--jb-shadow)!important;overflow:hidden!important}
      body:has(.ndmx) .ndmx .ndm-kpi:before,body:has(.ndmx) .ndmx .kpi:before{content:""!important;position:absolute!important;left:0!important;top:0!important;bottom:0!important;width:3px!important;background:var(--accent)!important;opacity:.8!important}
      body:has(.ndmx) .ndmx .ndm-kpi .value,body:has(.ndmx) .ndmx .kpi .value{font-size:22px!important;line-height:1!important;font-weight:850!important;letter-spacing:-.035em!important}
      body:has(.ndmx) .ndmx .ndm-kpi .label,body:has(.ndmx) .ndmx .kpi .label{margin-top:7px!important;color:var(--muted)!important;font-size:9px!important;font-weight:850!important;letter-spacing:.06em!important;text-transform:uppercase!important}
      body:has(.ndmx) .ndmx .ndmx-toolbar,body:has(.ndmx) .ndmx .ndm-toolbar{display:flex!important;align-items:center!important;gap:8px!important;flex-wrap:wrap!important;padding:9px!important;margin-bottom:12px!important;border:1px solid var(--border)!important;border-radius:11px!important;background:var(--surface)!important;box-shadow:0 3px 12px rgba(15,23,42,.04)!important}
      body:has(.ndmx) .ndmx input,body:has(.ndmx) .ndmx select{min-height:36px!important;border-radius:8px!important;border:1px solid var(--border)!important;background:var(--surface-2)!important;color:var(--text)!important;font-size:10.5px!important}
      body:has(.ndmx) .ndmx input:focus,body:has(.ndmx) .ndmx select:focus{border-color:var(--accent)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 12%,transparent)!important;outline:0!important}
      body:has(.ndmx) .ndmx .st-down,body:has(.ndmx) .ndmx .status-down{color:var(--bad)!important;background:color-mix(in srgb,var(--bad) 10%,var(--surface))!important;border-color:color-mix(in srgb,var(--bad) 25%,var(--border))!important}
      body:has(.ndmx) .ndmx .st-warn,body:has(.ndmx) .ndmx .status-warn{color:var(--warn)!important;background:color-mix(in srgb,var(--warn) 11%,var(--surface))!important;border-color:color-mix(in srgb,var(--warn) 28%,var(--border))!important}
      body:has(.ndmx) .ndmx .st-up,body:has(.ndmx) .ndmx .status-up{color:var(--ok)!important;background:color-mix(in srgb,var(--ok) 10%,var(--surface))!important;border-color:color-mix(in srgb,var(--ok) 25%,var(--border))!important}
      body:has(.ndmx) .ndmx .st-paused,body:has(.ndmx) .ndmx .status-paused,body:has(.ndmx) .ndmx .st-unknown,body:has(.ndmx) .ndmx .status-unknown{color:var(--muted)!important;background:var(--surface-2)!important;border-color:var(--border)!important}
      body:has(.ndmx) .ndmx .ndmx-device-row{border:1px solid var(--border)!important;border-radius:12px!important;background:var(--surface)!important;box-shadow:0 4px 16px rgba(15,23,42,.05)!important;overflow:hidden!important;transition:.15s ease!important}
      body:has(.ndmx) .ndmx .ndmx-device-row:hover{transform:translateY(-1px)!important;box-shadow:0 9px 24px rgba(15,23,42,.09)!important}
      body:has(.ndmx) .ndmx .ndmx-device-row.down{box-shadow:inset 3px 0 0 var(--bad),0 4px 16px rgba(15,23,42,.05)!important}
      body:has(.ndmx) .ndmx .ndmx-device-row.warn{box-shadow:inset 3px 0 0 var(--warn),0 4px 16px rgba(15,23,42,.05)!important}
      body:has(.ndmx) .ndmx .ndmx-device-row.up{box-shadow:inset 3px 0 0 var(--ok),0 4px 16px rgba(15,23,42,.05)!important}
      body:has(.ndmx) .ndmx .ndmx-section{margin-top:12px!important;border:1px solid var(--border)!important;border-radius:12px!important;background:var(--surface)!important;overflow:hidden!important}
      body:has(.ndmx) .ndmx .ndmx-section-head{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:10px 13px!important;background:var(--surface-2)!important;border-bottom:1px solid var(--border)!important}
      body:has(.ndmx) .ndmx .ndmx-section-head strong{font-size:10.5px!important;font-weight:850!important}
      body:has(.ndmx) .ndmx .ndmx-stale{display:inline-flex!important;align-items:center!important;gap:5px!important;padding:4px 7px!important;border-radius:999px!important;color:var(--warn)!important;background:color-mix(in srgb,var(--warn) 10%,var(--surface))!important;font-size:9px!important;font-weight:850!important}
      body:has(.ndmx) .ndmx .ndmx-stale:before{content:""!important;width:6px!important;height:6px!important;border-radius:50%!important;background:var(--warn)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 12%,transparent)!important}
      body:has(.ndmx) .ndmx .ndmx-empty{padding:34px 18px!important;text-align:center!important;color:var(--muted)!important}
      body:has(.ndmx) .ndmx .ndmx-error{padding:10px 12px!important;border-left:3px solid var(--bad)!important;border-radius:8px!important;background:color-mix(in srgb,var(--bad) 7%,var(--surface))!important;color:var(--text)!important;font-size:10.5px!important}
      body:has(.ndmx) .ndmx .ndmx-live{display:inline-flex!important;align-items:center!important;gap:6px!important;color:var(--ok)!important;font-size:9px!important;font-weight:850!important;text-transform:uppercase!important;letter-spacing:.06em!important}
      body:has(.ndmx) .ndmx .ndmx-live:before{content:""!important;width:7px!important;height:7px!important;border-radius:50%!important;background:var(--ok)!important;box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 13%,transparent)!important}
      @media(max-width:1100px){body:has(.ndmx) .ndmx .ndmx-kpis,body:has(.ndmx) .ndmx .ndm-kpis{grid-template-columns:repeat(3,minmax(0,1fr))!important}}
      @media(max-width:800px){body:has(.ndmx) .ndmx-head{align-items:flex-start!important;flex-direction:column!important}.ndmx-head-r{justify-content:flex-start!important}body:has(.ndmx) .ndmx .ndmx-kpis,body:has(.ndmx) .ndmx .ndm-kpis{grid-template-columns:repeat(2,minmax(0,1fr))!important}body:has(.ndmx) .ndmx .ndmx-toolbar,body:has(.ndmx) .ndmx .ndm-toolbar{align-items:stretch!important}body:has(.ndmx) .ndmx .ndm-btn{min-height:38px!important}}
      @media(max-width:520px){body:has(.ndmx) .ndmx-head h1{font-size:22px!important}body:has(.ndmx) .ndmx .ndmx-kpis,body:has(.ndmx) .ndmx .ndm-kpis{grid-template-columns:1fr 1fr!important}body:has(.ndmx) .ndmx .ndm-kpi,body:has(.ndmx) .ndmx .kpi{min-height:70px!important;padding:11px!important}}
      @media(prefers-reduced-motion:reduce){.nv-page,.sd-root{animation:none!important}.jb-stat,.st tbody tr{transition:none!important}body:has(.ndmx) .ndmx .ndmx-device-row{transition:none!important}}
    `}</style>
  );
}
export default ModernUI;
