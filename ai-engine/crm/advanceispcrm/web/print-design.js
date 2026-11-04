'use strict';
// Bill & receipt design: shows the saved logo, company details and notes on receipts and bills.
// Administrators and managers get "Customise design" on these pages, with a live preview before saving.
(()=>{
 const byId=id=>document.getElementById(id),kind=document.body.dataset.document,make=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const originals={};for(const id of ['print-company','print-tagline'])originals[id]=[...(byId(id)?.childNodes??[])].map(n=>n.cloneNode(true));
 let saved=null;
 const setText=(id,value)=>{const n=byId(id);if(!n)return;if(value)n.textContent=value;else n.replaceChildren(...originals[id].map(c=>c.cloneNode(true)));};
 const show=(id,value)=>{const n=byId(id);if(n){n.textContent=value||'';n.hidden=!value;}};
 function apply(s,logoUrl){
  setText('print-company',s.company_name);setText('print-tagline',s.tagline);
  show('print-contact',[s.address,s.phone,s.email].filter(Boolean).join(' · '));
  const logo=byId('print-logo');if(logo){logo.hidden=!logoUrl;if(logoUrl)logo.src=logoUrl;else logo.removeAttribute('src');}
  show('print-note',kind==='receipt'?s.receipt_note:s.invoice_note);
  const footer=kind==='receipt'?s.receipt_footer:s.invoice_footer;show('print-footer',footer);
  for(const n of document.querySelectorAll('.default-footer'))n.classList.toggle('design-hidden',Boolean(footer));
  for(const n of document.querySelectorAll('.system-note'))n.classList.toggle('design-hidden',Boolean(s.hide_system_notes));
 }
 const logoUrl=d=>d.has_logo?'/api/print-logo?v='+encodeURIComponent(d.version):'';
 async function token(){const r=await fetch('/api/auth/status');return (await r.json()).token;}
 async function post(body){const r=await fetch('/api/print-settings',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':await token()},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'The design could not be saved.');return d;}
 function editor(){
  const d=make('dialog',undefined,'design-dialog'),form=make('form'),error=make('p',undefined,'design-error'),inputs={};
  const head=make('div',undefined,'design-head'),close=make('button','Close','design-secondary');close.type='button';head.append(make('h2','Bill & receipt design'),close);
  form.append(make('p','Changes apply to every printed receipt and bill. The preview behind this window updates as you type.','design-help'));
  // Logo
  const logoBox=make('fieldset'),preview=make('img'),file=make('input'),remove=make('button','Remove logo','design-secondary');
  logoBox.append(make('legend','Logo'));preview.alt='Current logo';preview.className='design-logo-preview';file.type='file';file.accept='image/png,image/jpeg,image/webp';file.setAttribute('aria-label','Choose logo image');remove.type='button';
  const refreshLogo=()=>{preview.hidden=!saved.has_logo;if(saved.has_logo)preview.src=logoUrl(saved);remove.hidden=!saved.has_logo;};
  logoBox.append(preview,file,make('small','PNG, JPG or WebP, up to 1 MB. A wide logo with a transparent background prints best.'),remove);
  file.onchange=async()=>{const f=file.files[0];if(!f)return;error.textContent='';if(f.size>1024*1024){error.textContent='Use a logo of 1 MB or smaller.';return;}
   const data=await new Promise((done,fail)=>{const r=new FileReader();r.onload=()=>done(String(r.result).split(',')[1]||'');r.onerror=()=>fail(Error('The image could not be read.'));r.readAsDataURL(f);});
   try{saved=await post({action:'logo',file:data});refreshLogo();apply(values(),logoUrl(saved));}catch(e){error.textContent=e.message;}file.value='';};
  remove.onclick=async()=>{try{saved=await post({action:'remove_logo'});refreshLogo();apply(values(),'');}catch(e){error.textContent=e.message;}};
  form.append(logoBox);
  // Text fields and options
  const grid=make('div',undefined,'design-grid');
  for(const f of saved.fields){const label=make('label',f.label),input=make(f.max>150?'textarea':'input');input.name=f.key;input.maxLength=f.max;input.value=saved.settings[f.key]||'';if(f.max>150){input.rows=3;label.className='design-wide';}input.oninput=()=>apply(values(),logoUrl(saved));label.append(input);grid.append(label);inputs[f.key]=input;}
  for(const t of saved.toggles){const label=make('label',undefined,'design-check design-wide'),box=make('input');box.type='checkbox';box.name=t.key;box.checked=Boolean(saved.settings[t.key]);box.onchange=()=>apply(values(),logoUrl(saved));label.append(box,document.createTextNode(' '+t.label));grid.append(label);inputs[t.key]=box;}
  const values=()=>Object.fromEntries(Object.entries(inputs).map(([k,i])=>[k,i.type==='checkbox'?i.checked:i.value]));
  const save=make('button','Save design');save.type='submit';
  form.append(grid,error,save);
  form.onsubmit=async e=>{e.preventDefault();save.disabled=true;error.textContent='';try{saved=await post({action:'save',settings:values()});apply(saved.settings,logoUrl(saved));d.close();}catch(err){error.textContent=err.message;}finally{save.disabled=false;}};
  // Closing without saving puts the saved design back.
  close.onclick=()=>d.close();d.addEventListener('close',()=>{apply(saved.settings,logoUrl(saved));d.remove();});
  d.append(head,form);document.body.append(d);refreshLogo();d.showModal();
 }
 (async()=>{
  try{const r=await fetch('/api/print-settings');if(!r.ok)return;saved=await r.json();}catch{return;}
  apply(saved.settings,logoUrl(saved));
  if(saved.can_edit){const b=make('button','Customise design','design-open');b.type='button';b.onclick=editor;document.querySelector('.print-actions')?.prepend(b);}
 })();
})();
