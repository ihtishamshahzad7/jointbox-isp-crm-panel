'use strict';
// Paper size for printing bills and receipts: the 80(72.1) x 297 mm receipt roll by default, or A4, A5, 58 mm.
// Remembered on this computer per document, because the printer belongs to the computer.
(()=>{
 const select=document.getElementById('paper-size');if(!select)return;
 // v2: the 80 mm roll became the default, so choices saved under the old A4 default start from it once.
 const key='crm-paper-v2-'+(select.dataset.document||'print'),fallback='80mm';
 const apply=value=>{document.documentElement.dataset.paper=value;};
 let saved=fallback;try{saved=localStorage.getItem(key)||fallback;}catch{}
 if(![...select.options].some(o=>o.value===saved))saved=fallback;
 select.value=saved;apply(saved);
 select.onchange=()=>{apply(select.value);try{localStorage.setItem(key,select.value);}catch{}};
})();
