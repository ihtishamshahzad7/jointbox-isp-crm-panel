'use strict';
// Inventory > Receive batch: enter the batch number and warehouse once, add each item line on the same page,
// then save the whole batch at once (all items or none). An unsaved draft is kept on this computer.
const BATCH_DRAFT_KEY='crm-inventory-batch-draft';
let batchDraft=null;
function batchLoadDraft(){if(batchDraft)return batchDraft;try{batchDraft=JSON.parse(localStorage.getItem(BATCH_DRAFT_KEY)||'null');}catch{}return batchDraft??={batch:'',location:'',lines:[]};}
function batchSaveDraft(){try{if(batchDraft&&(batchDraft.lines.length))localStorage.setItem(BATCH_DRAFT_KEY,JSON.stringify(batchDraft));else localStorage.removeItem(BATCH_DRAFT_KEY);}catch{}}
function batchLatest(name){const key=String(name||'').trim().toLowerCase();return [...(state.records.Inventory??[])].filter(i=>String(i.item).toLowerCase()===key).sort((a,b)=>b.id-a.id)[0];}
function openInventoryBatch(){
 const draft=batchLoadDraft(),warehouses=state.warehouses??[],categories=(state.records.Categories??[]).filter(c=>c.status==='Active').map(c=>c.name).sort((a,b)=>a.localeCompare(b));
 if(!draft.batch)draft.batch=nextBatchNumber();if(!draft.location&&warehouses.length===1)draft.location=warehouses[0];
 let dialog=$('inventory-batch-dialog');if(dialog)dialog.remove();
 dialog=el('dialog',undefined,'batch-dialog');dialog.id='inventory-batch-dialog';document.body.append(dialog);
 const head=el('div',undefined,'batch-head');head.append(el('h2','Receive stock batch'),el('p','Add every item you received, then save the whole batch at once. Nothing is added to stock until you save.','expense-note'));
 // Batch-level details, entered once.
 const top=el('div',undefined,'batch-top'),batchLabel=el('label','Batch number'),batchInput=el('input'),houseLabel=el('label','Warehouse'),house=el('select');
 batchInput.value=draft.batch;batchInput.maxLength=100;batchInput.required=true;batchInput.oninput=()=>{draft.batch=batchInput.value.trim();batchSaveDraft();};batchLabel.append(batchInput);
 house.append(new Option(warehouses.length?'Select warehouse':'Add a warehouse in Operations first',''),...warehouses.map(w=>new Option(w,w)));house.value=draft.location;house.onchange=()=>{draft.location=house.value;batchSaveDraft();};houseLabel.append(house);
 // The batch invoice is attached to every item of the batch when it is saved. Files stay in this window only.
 const invoiceLabel=el('label','Invoice for this batch (optional)'),invoice=invoiceFileInput();invoice.setAttribute('aria-label','Batch invoice files');
 invoiceLabel.append(invoice,el('small','Attached to every item in the batch · PDF, JPG, PNG or WebP · up to 5 files · 5 MB each','grid-username'));
 top.append(batchLabel,houseLabel,invoiceLabel);
 // Line entry: type an item; a known item fills its category, prices and minimum from its latest batch.
 const entry=el('form',undefined,'batch-entry'),inputs={};let editing=null;
 const field=(key,label,type='number')=>{const wrap=el('label',label),input=type==='select'?el('select'):el('input');if(type!=='select'){input.type=type;if(type==='number'){input.min=key==='quantity'?'1':'0';input.step=['unit_cost','selling_price'].includes(key)?'0.01':'1';}}input.name='batch_'+key;inputs[key]=input;wrap.append(input);entry.append(wrap);return input;};
 const item=field('item','Item','text');item.required=true;item.maxLength=200;item.autocomplete='off';item.setAttribute('list','batch-items');
 const itemList=el('datalist');itemList.id='batch-items';itemList.append(...[...new Set((state.records.Inventory??[]).map(i=>i.item))].sort((a,b)=>a.localeCompare(b)).map(n=>new Option(n,n)));entry.append(itemList);
 const category=field('category','Category','select');category.required=true;category.append(new Option('Select category',''),...categories.map(c=>new Option(c,c)));
 field('quantity','Quantity').required=true;field('unit_cost','Unit cost (Rs)');field('selling_price','Selling price (Rs)');field('minimum_stock','Minimum stock');
 const add=el('button','+ Add to batch');add.type='submit';entry.append(add);
 const blank=()=>{for(const [k,input] of Object.entries(inputs))input.value=k==='category'?'':k==='quantity'?'':'0';item.value='';editing=null;add.textContent='+ Add to batch';item.focus();};
 item.onchange=()=>{const known=batchLatest(item.value);if(known&&editing===null){item.value=known.item;category.value=categories.includes(known.category)?known.category:'';for(const k of ['unit_cost','selling_price','minimum_stock'])inputs[k].value=known[k]??0;inputs.quantity.focus();}};
 const error=el('p',undefined,'error');
 // Lines added so far.
 const tableWrap=el('div',undefined,'table-wrap batch-lines'),totals=el('p',undefined,'batch-totals');
 const draw=()=>{const table=el('table'),tr=el('tr');for(const h of ['#','Item','Category','Qty','Unit cost','Selling price','Min stock','Line value',''])tr.append(el('th',h));table.append(el('thead'),el('tbody'));table.tHead.append(tr);
  draft.lines.forEach((line,n)=>{const row=el('tr'),actions=el('td'),edit=el('button','Edit','secondary'),remove=el('button','Remove','danger');edit.type=remove.type='button';
   edit.onclick=()=>{editing=n;for(const k of Object.keys(inputs))inputs[k].value=line[k]??'';add.textContent='Update line '+(n+1);inputs.quantity.focus();};
   remove.onclick=()=>{draft.lines.splice(n,1);if(editing!==null)blank();batchSaveDraft();draw();};actions.append(edit,remove);
   row.append(el('td',String(n+1)),el('td',line.item),el('td',line.category),el('td',String(line.quantity)),el('td',money(line.unit_cost)),el('td',money(line.selling_price)),el('td',String(line.minimum_stock)),el('td',money(line.quantity*line.unit_cost)),actions);table.tBodies[0].append(row);});
  if(!draft.lines.length){const row=el('tr'),td=el('td','No items yet. Add the first item above.');td.colSpan=9;row.append(td);table.tBodies[0].append(row);}
  tableWrap.replaceChildren(table);const qty=draft.lines.reduce((n,l)=>n+Number(l.quantity),0),value=draft.lines.reduce((n,l)=>n+l.quantity*l.unit_cost,0);
  totals.textContent=`${draft.lines.length} item${draft.lines.length===1?'':'s'} · ${qty} units · stock value Rs ${money(value)}`;save.disabled=!draft.lines.length;save.textContent=draft.lines.length?`Save batch (${draft.lines.length} item${draft.lines.length===1?'':'s'})`:'Save batch';};
 entry.onsubmit=event=>{event.preventDefault();error.textContent='';
  const line={item:item.value.trim(),category:category.value,quantity:Number(inputs.quantity.value),unit_cost:Number(inputs.unit_cost.value||0),selling_price:Number(inputs.selling_price.value||inputs.unit_cost.value||0),minimum_stock:Number(inputs.minimum_stock.value||0)};
  if(!line.item||!line.category||!(line.quantity>=1)||!Number.isInteger(line.quantity)){error.textContent='Enter the item, its category and a whole quantity of at least 1.';return;}
  const same=draft.lines.findIndex((l,i)=>i!==editing&&l.item.toLowerCase()===line.item.toLowerCase());
  if(same>=0){if(editing===null&&draft.lines[same].unit_cost===line.unit_cost&&draft.lines[same].selling_price===line.selling_price){draft.lines[same].quantity+=line.quantity;}else{error.textContent=`${line.item} is already line ${same+1}. Edit that line instead.`;return;}}
  else if(editing!==null)draft.lines[editing]=line;else draft.lines.push(line);
  batchSaveDraft();blank();draw();};
 // Save, discard, close.
 const footer=el('div',undefined,'form-actions batch-actions'),discard=el('button','Discard batch','secondary'),close=el('button','Close','secondary'),save=el('button','Save batch');
 discard.type=close.type=save.type='button';
 discard.onclick=()=>{if(draft.lines.length&&!confirm(`Discard the ${draft.lines.length} unsaved item(s) in this batch?`))return;batchDraft={batch:'',location:'',lines:[]};batchSaveDraft();dialog.close();};
 close.onclick=()=>dialog.close();
 save.onclick=async()=>{error.textContent='';if(!draft.lines.length)return;if(!draft.location){error.textContent='Select the warehouse that received this batch.';house.focus();return;}
  if(invoice.files.length>5){error.textContent='Attach up to 5 invoice files.';return;}
  save.disabled=true;save.textContent='Saving…';
  try{const files=invoice.files.length?await invoiceFilesToPayload(invoice.files):[];
   const response=await fetch('/api/inventory-batch',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify({batch:draft.batch,location:draft.location,lines:draft.lines,files})});const result=await response.json();
   if(response.status===401){await startAuth();throw Error('Sign in again, then save the batch. Your items are kept.');}if(!response.ok)throw Error(result.error||'Could not save the batch.');
   const count=draft.lines.length,units=draft.lines.reduce((n,l)=>n+l.quantity,0);batchDraft={batch:'',location:'',lines:[]};batchSaveDraft();dialog.close();await load();
   $('notice').textContent=`Batch ${result.batch} saved: ${count} item${count===1?'':'s'}, ${units} units added to ${draft.location}.`+(result.invoices?` Invoice attached to every item.`:'');$('notice').hidden=false;
  }catch(e){error.textContent=e.message;draw();}};
 footer.append(discard,close,save);
 dialog.append(head,top,entry,error,tableWrap,totals,footer);draw();dialog.showModal();blank();
 if(draft.lines.length)error.textContent=`Restored your unsaved batch with ${draft.lines.length} item(s).`;
}
// Add the button next to "+ Add" on the Inventory page.
const batchOriginalRender=render;
render=function(){batchOriginalRender();$('receive-batch')?.remove();if(current==='Inventory'&&can('write','Inventory')&&$('add')){const b=el('button','+ Receive batch',$('add').className);b.id='receive-batch';b.type='button';b.onclick=openInventoryBatch;$('add').after(b);}};
