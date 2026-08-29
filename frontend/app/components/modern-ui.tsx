import React from "react";

/** Global visual layer. Business logic, routes and API contracts stay untouched. */
export function ModernUI() {
  return (
    <style>{`
      :root{--jb-radius:12px;--jb-radius-sm:8px;--jb-shadow:0 6px 20px rgba(15,23,42,.08);--jb-shadow-hover:0 12px 30px rgba(15,23,42,.13)}
      body.app-font{font-family:Inter,Satoshi,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      button,input,select,textarea{font:inherit}
      button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

      /* Shared enterprise surfaces */
      .nv-card,.st,.nt,.lrt,.sd-panel,.sd-kpi,.jb-stat{border-radius:var(--jb-radius)!important;box-shadow:var(--jb-shadow)!important}
      .nv-card:hover,.sd-panel:hover,.jb-stat:hover{box-shadow:var(--jb-shadow-hover)!important}
      .nv-page{animation:jbIn .2s ease-out both}
      @keyframes jbIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

      /* IMPORTANT: Subscriber page currently uses inline styles, so these use
         !important intentionally. This is the visible redesign, not a passive
         theme that can be overridden by the old inline presentation. */
      .jb-kpi-row{grid-template-columns:repeat(7,minmax(0,1fr))!important;gap:12px!important;margin-bottom:18px!important}
      .jb-stat{position:relative!important;min-height:86px!important;padding:15px 16px!important;background:var(--surface)!important;border:1px solid var(--border)!important;overflow:hidden!important;transition:transform .16s,box-shadow .16s!important}
      .jb-stat:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);opacity:.9}
      .jb-stat .val{font-size:25px!important;line-height:1!important;font-weight:850!important;letter-spacing:-.04em!important}
      .jb-stat .lbl{margin-top:8px!important;color:var(--muted)!important;font-size:10px!important;font-weight:800!important;letter-spacing:.045em!important;text-transform:uppercase!important}
      .jb-status-filters{padding:3px!important;border:1px solid var(--border)!important;border-radius:9px!important;background:var(--surface-2)!important}
      .jb-status-filters button{min-height:32px!important;border-radius:7px!important;padding:6px 10px!important}
      .jb-status-filters button:hover{background:var(--surface)!important;color:var(--text)!important}
      .jb-exp-chips{display:flex!important;align-items:center!important;gap:3px!important;padding:3px!important;border:1px solid var(--border)!important;border-radius:9px!important;background:var(--surface-2)!important}
      .jb-exp-chips button{border:0!important;background:transparent!important;color:var(--muted)!important;border-radius:7px!important;padding:6px 8px!important;font-size:10px!important;font-weight:800!important;cursor:pointer!important}
      .jb-exp-chips button:hover,.jb-exp-chips button.on{background:var(--surface)!important;color:var(--accent)!important;box-shadow:0 1px 4px rgba(0,0,0,.08)!important}
      .jb-exp-lbl{padding:0 5px!important;color:var(--muted)!important;font-size:9px!important;font-weight:800!important;text-transform:uppercase!important}

      /* Give the search area a real command-bar appearance. */
      input[placeholder*="Search by name"]{height:40px!important;border-radius:9px!important;border:1px solid var(--border)!important;background:var(--surface)!important;box-shadow:0 2px 8px rgba(15,23,42,.04)!important;font-size:12px!important}
      input[placeholder*="Search by name"]:focus{border-color:var(--accent)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 13%,transparent)!important}
      .jb-status-filters~button,.jb-exp-chips~button{min-height:34px!important}

      /* Subscriber table is the primary workspace. */
      .st{background:var(--surface)!important;border:1px solid var(--border)!important;overflow:hidden!important}
      .st table{border-spacing:0!important}
      .st thead th{height:44px!important;padding:10px 12px!important;background:var(--surface-2)!important;color:var(--muted)!important;font-size:9px!important;font-weight:850!important;letter-spacing:.08em!important;text-transform:uppercase!important;border-bottom:1px solid var(--border)!important}
      .st tbody td{padding:11px 12px!important;border-bottom:1px solid color-mix(in srgb,var(--border) 75%,transparent)!important}
      .st tbody tr{background:var(--surface)!important;transition:background .12s,box-shadow .12s!important}
      .st tbody tr:hover{background:color-mix(in srgb,var(--accent) 5%,var(--surface))!important;box-shadow:inset 3px 0 0 var(--accent)!important}
      .st tbody tr.on{background:color-mix(in srgb,var(--accent) 8%,var(--surface))!important;box-shadow:inset 3px 0 0 var(--accent)!important}
      .st .av{width:38px!important;height:38px!important;border-radius:10px!important}
      .st .nm{font-size:12.5px!important;font-weight:750!important}
      .st .sub{font-size:10px!important}
      .st .pill{padding:5px 9px!important;border-radius:999px!important;font-size:9.5px!important;font-weight:850!important}
      .st .chip{padding:5px 8px!important;border-radius:7px!important;font-size:10px!important}
      .st td.act button{min-height:30px!important;border-radius:7px!important}
      .st .statusbar{min-height:40px!important;padding:7px 12px!important;background:var(--surface-2)!important}

      /* Subscriber 360 */
      .sd-root{gap:14px!important;animation:jbIn .2s ease-out both}
      .sd-title-block{padding:18px!important;border:1px solid var(--border)!important;border-radius:var(--jb-radius)!important;background:var(--surface)!important;box-shadow:var(--jb-shadow)!important}
      .sd-avatar{width:48px!important;height:48px!important;border-radius:12px!important}
      .sd-title h1{font-size:23px!important;letter-spacing:-.035em!important}
      .sd-tabs{position:sticky!important;top:0!important;z-index:20!important;display:flex!important;gap:3px!important;overflow-x:auto!important;padding:4px!important;border:1px solid var(--border)!important;border-radius:10px!important;background:color-mix(in srgb,var(--surface) 95%,transparent)!important;backdrop-filter:blur(12px)!important}
      .sd-tab{min-height:35px!important;padding:7px 13px!important;border-radius:7px!important;font-size:10.5px!important;font-weight:750!important}
      .sd-tab.on{background:var(--accent)!important;color:#fff!important;box-shadow:0 4px 12px color-mix(in srgb,var(--accent) 25%,transparent)!important}
      .sd-kpi{padding:14px!important}
      .sd-kpi-value{font-size:22px!important;font-weight:800!important}

      /* Forms and dialogs */
      .sd-modal,.sd-drawer,.sw-root,.subscriber-wizard{border-radius:13px!important;box-shadow:0 24px 70px rgba(15,23,42,.2)!important}
      .sw-root input,.sw-root select,.sw-root textarea,.subscriber-wizard input,.subscriber-wizard select,.subscriber-wizard textarea{border-radius:8px!important}
      .sw-root button,.subscriber-wizard button{border-radius:8px!important}

      @media(max-width:1200px){.jb-kpi-row{grid-template-columns:repeat(4,minmax(0,1fr))!important}}
      @media(max-width:800px){.jb-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))!important}.st{overflow-x:auto!important}.st table{min-width:860px!important}}
      @media(max-width:520px){.jb-kpi-row{grid-template-columns:1fr 1fr!important}.jb-stat{min-height:72px!important;padding:11px!important}.jb-stat .val{font-size:20px!important}.jb-exp-chips{overflow-x:auto}}
      @media(prefers-reduced-motion:reduce){.nv-page,.sd-root{animation:none!important}.jb-stat,.st tbody tr{transition:none!important}}
    `}</style>
  );
}
export default ModernUI;
