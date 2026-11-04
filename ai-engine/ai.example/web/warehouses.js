'use strict';
// Move stock of one batch from its warehouse to another. The server keeps the batch's cost and selling price.
function openTransfer(row){
 const d=opsDialog('Transfer stock'),form=opsElement('form'),others=(state.warehouses??[]).filter(w=>w!==row.location),error=opsElement('p',undefined,'ops-error'),requestKey=crypto.randomUUID();
 form.append(opsElement('p',`${row.item}${row.batch?' · Batch '+row.batch:''} · ${row.quantity} in ${row.location||'no warehouse'}`,'ops-note'));
 if(!others.length){form.append(opsElement('p','Add another active warehouse in Operations → Inventory → Warehouses first.','ops-error'));d.append(form);d.showModal();return;}
 const to=opsElement('select'),toLabel=opsElement('label','To warehouse'),qty=opsElement('input'),qtyLabel=opsElement('label','Quantity'),notes=opsElement('input'),notesLabel=opsElement('label','Notes (optional)'),save=opsElement('button','Transfer stock');
 to.required=true;to.append(new Option('Select warehouse',''),...others.map(w=>new Option(w,w)));if(others.length===1)to.value=others[0];
 qty.type='number';qty.min='1';qty.max=String(row.quantity);qty.step='1';qty.required=true;qty.value=String(row.quantity);
 notes.maxLength=500;notes.placeholder='For example: cable for Swabi expansion';save.type='submit';
 toLabel.append(to);qtyLabel.append(qty);notesLabel.append(notes);
 const grid=opsElement('div',undefined,'ops-form');grid.append(toLabel,qtyLabel,notesLabel);form.append(grid,error,save);
 const past=(state.transfers??[]).filter(t=>t.from_inventory_id===row.id||t.to_inventory_id===row.id).slice(0,8);
 if(past.length){form.append(opsElement('h3','Recent transfers of this batch'));for(const t of past)form.append(opsElement('p',`${t.created_at.slice(0,10)} · ${t.quantity} from ${t.from_warehouse} to ${t.to_warehouse} · ${t.actor_name}${t.notes?' · '+t.notes:''}`,'ops-note'));}
 form.onsubmit=async e=>{e.preventDefault();save.disabled=true;error.textContent='';
  try{const response=await fetch('/api/inventory-transfer',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify({inventory_id:row.id,to_warehouse:to.value,quantity:Number(qty.value),notes:notes.value,request_key:requestKey})});
   const result=await response.json();if(!response.ok)throw Error(result.error||'Transfer failed.');
   d.close();await load();$('notice').textContent=`${result.transfer.quantity} × ${row.item} moved from ${result.transfer.from_warehouse} to ${result.transfer.to_warehouse}.`;$('notice').hidden=false;}
  catch(err){error.textContent=err.message;save.disabled=false;}};
 d.append(form);d.showModal();
}
