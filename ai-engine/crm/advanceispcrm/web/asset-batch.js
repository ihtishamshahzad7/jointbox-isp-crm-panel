'use strict';
// Operations > Assets > Receive asset batch: batch number, location, purchase date, condition and invoice are entered
// once; each line is one asset with its serial, or several identical unserialised assets. Saved all at once.
const ASSET_DRAFT_KEY='crm-asset-batch-draft';
let assetDraft=null;
function assetLoadDraft(){if(assetDraft)return assetDraft;try{assetDraft=JSON.parse(localStorage.getItem(ASSET_DRAFT_KEY)||'null');}catch{}return assetDraft??={batch:'',location:'',purchased_on:'',condition:'Good',lines:[]};}
function assetSaveDraft(){try{if(assetDraft?.lines.length)localStorage.setItem(ASSET_DRAFT_KEY,JSON.stringify(assetDraft));else localStorage.removeItem(ASSET_DRAFT_KEY);}catch{}}
function assetRecords(){return typeof operationsState!=='undefined'&&operationsState?operationsState.records.filter(r=>r.module==='Assets'):[];}
function nextAssetBatch(){const prefix='A-'+today().slice(2,4)+today().slice(5,7)+'-',used=assetRecords().map(r=>String(r.data.batch||'')).filter(b=>b.startsWith(prefix)).map(b=>Number(b.slice(prefix.length))).filter(Number.isInteger);return prefix+String(Math.max(0,...used)+1).padStart(3,'0');}
// Dashboard asset cards open Operations > Assets.
function openAssetsModule(){if(typeof openOperations!=='function')return;operationsModule='Assets';operationsQuery='';openOperations();}
function openAssetBatch(){
 const draft=assetLoadDraft(),assets=assetRecords();
 if(!draft.batch)draft.batch=nextAssetBatch();if(!draft.purchased_on)draft.purchased_on=today();
 $('asset-batch-dialog')?.remove();const dialog=el('dialog',undefined,'batch-dialog');dialog.id='asset-batch-dialog';document.body.append(dialog);
 const head=el('div',undefined,'batch-head');head.append(el('h2','Receive asset batch'),el('p','Enter what applies to the whole purchase once, add each asset below, then save them all together. Nothing is saved until you click Save.','expense-note'));
 const top=el('div',undefined,'batch-top'),input=(label,key,type='text')=>{const wrap=el('label',label),box=el('input');box.type=type;box.value=draft[key]||'';box.oninput=()=>{draft[key]=box.value.trim();assetSaveDraft();};wrap.append(box);top.append(wrap);return box;};
 input('Batch number','batch').maxLength=100;
 const location=input('Location','location');location.required=true;location.setAttribute('list','asset-locations');
 const places=el('datalist');places.id='asset-locations';places.append(...[...new Set([...assets.map(r=>r.data.location),...(state.warehouses??[])].filter(Boolean))].sort().map(p=>new Option(p,p)));top.append(places);
 input('Purchased on','purchased_on','date').max=today();
 const conditionLabel=el('label','Condition'),condition=el('select');for(const c of ['Good','Under repair','Damaged','Destroyed'])condition.append(new Option(c,c));condition.value=draft.condition||'Good';condition.onchange=()=>{draft.condition=condition.value;assetSaveDraft();};conditionLabel.append(condition);top.append(conditionLabel);
 const invoiceLabel=el('label','Invoice for this batch (optional)'),invoice=invoiceFileInput();invoice.setAttribute('aria-label','Batch invoice files');
 invoiceLabel.append(invoice,el('small','Attached to every asset in the batch · PDF, JPG, PNG or WebP · up to 5 files · 5 MB each','grid-username'));top.append(invoiceLabel);
 // Line entry.
 const entry=el('form',undefined,'batch-entry asset-entry'),inputs={};let editing=null;
 const field=(key,label,type='text')=>{const wrap=el('label',label),box=el('input');box.type=type;box.name='asset_'+key;if(type==='number'){box.min=key==='quantity'?'1':'0';box.step=key==='quantity'?'1':'0.01';}inputs[key]=box;wrap.append(box);entry.append(wrap);return box;};
 const name=field('name','Asset name');name.required=true;name.maxLength=200;name.autocomplete='off';name.setAttribute('list','asset-names');
 const names=el('datalist');names.id='asset-names';names.append(...[...new Set(assets.map(r=>r.data.name).filter(Boolean))].sort().map(n=>new Option(n,n)));entry.append(names);
 const serial=field('serial','Serial (optional)');const quantity=field('quantity','Quantity','number');quantity.required=true;field('value','Value per unit (Rs)','number');field('notes','Notes');
 // A serial number identifies one asset, so it only applies when the quantity is 1.
 const syncSerial=()=>{const many=Number(quantity.value)>1;serial.disabled=many;if(many)serial.value='';serial.placeholder=many?'One per line for serialised assets':'';};quantity.oninput=syncSerial;
 name.onchange=()=>{const known=[...assets].filter(r=>String(r.data.name).toLowerCase()===name.value.trim().toLowerCase()).sort((a,b)=>b.id-a.id)[0];if(known&&editing===null){name.value=known.data.name;inputs.value.value=known.data.value??0;}};
 const add=el('button','+ Add to batch');add.type='submit';entry.append(add);
 const blank=()=>{for(const [k,box] of Object.entries(inputs))box.value=k==='quantity'?'1':k==='value'?'0':'';editing=null;add.textContent='+ Add to batch';syncSerial();name.focus();};
 const error=el('p',undefined,'error'),tableWrap=el('div',undefined,'table-wrap batch-lines'),totals=el('p',undefined,'batch-totals');
 const draw=()=>{const table=el('table'),tr=el('tr');for(const h of ['#','Asset','Serial','Qty','Value per unit','Line value','Notes',''])tr.append(el('th',h));table.append(el('thead'),el('tbody'));table.tHead.append(tr);
  draft.lines.forEach((line,n)=>{const row=el('tr'),actions=el('td'),edit=el('button','Edit','secondary'),remove=el('button','Remove','danger');edit.type=remove.type='button';
   edit.onclick=()=>{editing=n;for(const k of Object.keys(inputs))inputs[k].value=line[k]??'';syncSerial();add.textContent='Update line '+(n+1);name.focus();};
   remove.onclick=()=>{draft.lines.splice(n,1);if(editing!==null)blank();assetSaveDraft();draw();};actions.append(edit,remove);
   row.append(el('td',String(n+1)),el('td',line.name),el('td',line.serial||'—'),el('td',String(line.quantity)),el('td',money(line.value)),el('td',money(line.quantity*line.value)),el('td',line.notes||''),actions);table.tBodies[0].append(row);});
  if(!draft.lines.length){const row=el('tr'),td=el('td','No assets yet. Add the first one above.');td.colSpan=8;row.append(td);table.tBodies[0].append(row);}
  tableWrap.replaceChildren(table);const count=draft.lines.reduce((n,l)=>n+l.quantity,0),value=draft.lines.reduce((n,l)=>n+l.quantity*l.value,0);
  totals.textContent=`${count} asset${count===1?'':'s'} · total value Rs ${money(value)}`;save.disabled=!count;save.textContent=count?`Save batch (${count} asset${count===1?'':'s'})`:'Save batch';};
 entry.onsubmit=event=>{event.preventDefault();error.textContent='';
  const line={name:name.value.trim(),serial:serial.disabled?'':serial.value.trim(),quantity:Number(quantity.value),value:Number(inputs.value.value||0),notes:inputs.notes.value.trim()};
  if(!line.name||!Number.isInteger(line.quantity)||line.quantity<1){error.textContent='Enter the asset name and a whole quantity of at least 1.';return;}
  if(line.serial&&draft.lines.some((l,i)=>i!==editing&&l.serial&&l.serial.toLowerCase()===line.serial.toLowerCase())){error.textContent=`Serial ${line.serial} is already in this batch.`;return;}
  if(editing!==null)draft.lines[editing]=line;else draft.lines.push(line);assetSaveDraft();blank();draw();};
 const footer=el('div',undefined,'form-actions batch-actions'),discard=el('button','Discard batch','secondary'),close=el('button','Close','secondary'),save=el('button','Save batch');discard.type=close.type=save.type='button';
 discard.onclick=()=>{if(draft.lines.length&&!confirm(`Discard the ${draft.lines.length} unsaved line(s) in this batch?`))return;assetDraft=null;try{localStorage.removeItem(ASSET_DRAFT_KEY);}catch{}dialog.close();};
 close.onclick=()=>dialog.close();
 save.onclick=async()=>{error.textContent='';if(!draft.lines.length)return;
  if(!draft.location){error.textContent='Enter where these assets are kept.';location.focus();return;}if(!draft.purchased_on){error.textContent='Enter the purchase date.';return;}
  if(invoice.files.length>5){error.textContent='Attach up to 5 invoice files.';return;}
  save.disabled=true;save.textContent='Saving…';
  try{const files=invoice.files.length?await invoiceFilesToPayload(invoice.files):[];
   const response=await fetch('/api/asset-batch',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify({batch:draft.batch,location:draft.location,purchased_on:draft.purchased_on,condition:draft.condition||'Good',lines:draft.lines,files})}),result=await response.json();
   if(response.status===401){await startAuth();throw Error('Sign in again, then save the batch. Your lines are kept.');}if(!response.ok)throw Error(result.error||'Could not save the asset batch.');
   assetDraft=null;try{localStorage.removeItem(ASSET_DRAFT_KEY);}catch{}dialog.close();
   if(typeof openOperations==='function')await openOperations();
   if($('notice')){$('notice').textContent=`Asset batch ${result.batch} saved: ${result.ids.length} asset${result.ids.length===1?'':'s'}.`+(result.invoices?' Invoice attached to every asset.':'');$('notice').hidden=false;}
  }catch(e){error.textContent=e.message;draw();}};
 footer.append(discard,close,save);dialog.append(head,top,entry,error,tableWrap,totals,footer);draw();dialog.showModal();blank();
 if(draft.lines.length)error.textContent=`Restored your unsaved asset batch with ${draft.lines.length} line(s).`;
}
