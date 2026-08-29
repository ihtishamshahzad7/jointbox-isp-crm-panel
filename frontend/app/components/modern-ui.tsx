import React from "react";

/** Global visual layer. Business logic, routes and API contracts stay untouched. */
export function ModernUI() {
  return (
    <style>{`
      :root{--jb-radius:14px;--jb-radius-sm:9px;--jb-shadow:0 8px 28px rgba(15,23,42,.07);--jb-shadow-hover:0 16px 38px rgba(15,23,42,.12)}
      body.app-font{font-family:Inter,Satoshi,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      button,input,select,textarea{font:inherit}
      button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

      /* Shared application surfaces */
      .nv-card,.st,.nt,.lrt,.sd-panel,.sd-kpi,.jb-stat{border-radius:var(--jb-radius)!important;box-shadow:var(--jb-shadow)!important}
      .nv-card:hover,.sd-panel:hover,.jb-stat:hover{box-shadow:var(--jb-shadow-hover)!important}
      .nv-page{animation:jbIn .2s ease-out both}
      @keyframes jbIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}

      /* ================================================================
         SUBSCRIBERS 2.0 — scoped to the real subscriber DOM.
         This is intentionally a strong visual change, not a generic theme.
         ================================================================ */
      body:has(.st){background:var(--bg)!important}
      body:has(.st) .jb-kpi-row{grid-template-columns:repeat(7,minmax(125px,1fr))!important;gap:12px!important;margin-bottom:18px!important}
      body:has(.st) .jb-stat{position:relative!important;min-height:96px!important;padding:18px 17px 15px!important;background:linear-gradient(145deg,var(--surface),var(--surface-2))!important;border:1px solid var(--border)!important;overflow:hidden!important;transition:transform .16s,box-shadow .16s!important}
      body:has(.st) .jb-stat:after{content:"";position:absolute;right:-24px;bottom:-34px;width:90px;height:90px;border-radius:50%;background:color-mix(in srgb,var(--accent) 9%,transparent);pointer-events:none}
      body:has(.st) .jb-stat:before{content:"";position:absolute;left:0;top:0;right:0;height:3px;background:var(--accent);opacity:.85}
      body:has(.st) .jb-stat .val{font-size:28px!important;line-height:1!important;font-weight:850!important;letter-spacing:-.045em!important}
      body:has(.st) .jb-stat .lbl{margin-top:9px!important;color:var(--muted)!important;font-size:9.5px!important;font-weight:800!important;letter-spacing:.07em!important;text-transform:uppercase!important}

      /* The toolbar becomes one clear command surface. */
      body:has(.st) input[placeholder*="Search by name"]{height:42px!important;border-radius:10px!important;border:1px solid var(--border)!important;background:var(--surface)!important;box-shadow:var(--jb-shadow)!important;padding-left:34px!important;font-size:12px!important}
      body:has(.st) input[placeholder*="Search by name"]:focus{border-color:var(--accent)!important;box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 12%,transparent),var(--jb-shadow)!important}
      body:has(.st) .jb-status-filters{padding:4px!important;border:1px solid var(--border)!important;border-radius:10px!important;background:var(--surface)!important;box-shadow:0 2px 8px rgba(15,23,42,.04)!important}
      body:has(.st) .jb-status-filters button{min-height:32px!important;border-radius:7px!important;padding:6px 11px!important;font-size:10px!important;font-weight:750!important}
      body:has(.st) .jb-status-filters button:hover{background:var(--surface-2)!important;color:var(--text)!important}
      body:has(.st) .jb-exp-chips{padding:4px!important;border:1px solid var(--border)!important;border-radius:10px!important;background:var(--surface)!important;box-shadow:0 2px 8px rgba(15,23,42,.04)!important}
      body:has(.st) .jb-exp-chips button{border:0!important;border-radius:7px!important;padding:6px 9px!important;font-size:10px!important;font-weight:800!important}
      body:has(.st) .jb-exp-chips button:hover,body:has(.st) .jb-exp-chips button.on{background:color-mix(in srgb,var(--accent) 10%,var(--surface))!important;color:var(--accent)!important}
      body:has(.st) .jb-exp-lbl{font-size:9px!important;font-weight:850!important;padding:0 6px!important}

      /* Make the list container unmistakably separate from the toolbar. */
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

      /* Selection bar: obvious but not noisy. */
      body:has(.st) .jb-selbar{display:flex!important;align-items:center!important;gap:7px!important;padding:9px 11px!important;margin-bottom:10px!important;border:1px solid color-mix(in srgb,var(--accent) 24%,var(--border))!important;border-radius:10px!important;background:color-mix(in srgb,var(--accent) 6%,var(--surface))!important;box-shadow:0 4px 14px rgba(15,23,42,.05)!important}
      body:has(.st) .jb-selbar-count{font-size:11px!important;font-weight:850!important;color:var(--accent)!important;margin-right:4px!important}
      body:has(.st) .jb-selbar-clear{margin-left:auto!important;background:transparent!important;border:0!important;color:var(--muted)!important;font-size:10px!important;cursor:pointer!important}
      body:has(.st) .jb-selbar-clear:hover{color:var(--accent)!important}

      /* Subscriber 360 */
      body:has(.sd-root) .sd-title-block{padding:18px!important;border:1px solid var(--border)!important;border-radius:14px!important;background:var(--surface)!important;box-shadow:var(--jb-shadow)!important}
      body:has(.sd-root) .sd-avatar{width:50px!important;height:50px!important;border-radius:12px!important}
      body:has(.sd-root) .sd-title h1{font-size:24px!important;letter-spacing:-.04em!important}
      body:has(.sd-root) .sd-tabs{position:sticky!important;top:0!important;z-index:20!important;display:flex!important;gap:3px!important;overflow-x:auto!important;padding:4px!important;border:1px solid var(--border)!important;border-radius:10px!important;background:color-mix(in srgb,var(--surface) 95%,transparent)!important;backdrop-filter:blur(12px)!important}
      body:has(.sd-root) .sd-tab{min-height:36px!important;padding:7px 13px!important;border-radius:7px!important;font-size:10.5px!important;font-weight:750!important}
      body:has(.sd-root) .sd-tab.on{background:var(--accent)!important;color:#fff!important;box-shadow:0 5px 14px color-mix(in srgb,var(--accent) 25%,transparent)!important}

      @media(max-width:1200px){body:has(.st) .jb-kpi-row{grid-template-columns:repeat(4,minmax(0,1fr))!important}}
      @media(max-width:800px){body:has(.st) .jb-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))!important}.st{overflow-x:auto!important}.st table{min-width:860px!important}}
      @media(max-width:520px){body:has(.st) .jb-kpi-row{grid-template-columns:1fr 1fr!important}body:has(.st) .jb-stat{min-height:78px!important;padding:13px!important}body:has(.st) .jb-stat .val{font-size:21px!important}.jb-exp-chips{overflow-x:auto}}
      @media(prefers-reduced-motion:reduce){.nv-page,.sd-root{animation:none!important}.jb-stat,.st tbody tr{transition:none!important}}
    `}</style>
  );
}
export default ModernUI;
