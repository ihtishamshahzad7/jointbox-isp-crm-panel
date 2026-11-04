'use strict';
// Paper size for printing bills and receipts: A4, A5 or a receipt printer roll (80 mm / 58 mm).
// Remembered on this computer per document, because the printer belongs to the computer.
(()=>{
 const select=document.getElementById('paper-size');if(!select)return;
 const key='crm-paper-'+(select.dataset.document||'print');
 const apply=value=>{document.documentElement.dataset.paper=value;};
 let saved='A4';try{saved=localStorage.getItem(key)||'A4';}catch{}
 if(![...select.options].some(o=>o.value===saved))saved='A4';
 select.value=saved;apply(saved);
 select.onchange=()=>{apply(select.value);try{localStorage.setItem(key,select.value);}catch{}};
})();
