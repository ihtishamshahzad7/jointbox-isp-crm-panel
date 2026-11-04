'use strict';
// Inventory > Move stock: move several batches from one warehouse to another in one go (one TRF number),
// and Reports > Stock Transfer Report: every transfer with its value, date and month.
function openStockMovement(){
 const houses=state.warehouses??[],stock=state.records.Inventory??[],requestKey=crypto.randomUUID();
 $('stock-movement-dialog')?.remove();const dialog=el('dialog',undefined,'batch-dialog');dialog.id='stock-movement-dialog';document.body.append(dialog);
 const head=el('div',undefined,'batch-head');head.append(el('h2','Move stock between warehouses'),el('p','Choose the two warehouses, add every item you are sending, then move them all at once. Unit cost and selling price stay with each batch.','expense-note'));
 if(houses.length<2){head.append(el('p','Add a second active warehouse in Operations → Inventory → Warehouses first.','error'));const close=el('button','Close','secondary');close.type='button';close.onclick=()=>dialog.close();dialog.append(head,close);dialog.showModal();return;}
 const top=el('div',undefined,'batch-top'),select=(label,options)=>{const wrap=el('label',label),box=el('select');box.append(...options.map(([v,t])=>new Option(t,v)));wrap.append(box);top.append(wrap);return box;};
 const units=h=>stock.filter(i=>i.location===h).reduce((n,i)=>n+Number(i.quantity),0);
 const from=select('From warehouse',[['','Select warehouse'],...houses.map(h=>[h,`${h} · ${units(h)} units`])]),to=select('To warehouse',[['','Select warehouse'],...houses.map(h=>[h,h])]);
 const dateLabel=el('label','Transfer date'),date=el('input');date.type='date';date.value=today();date.max=today();date.required=true;dateLabel.append(date);
 const notesLabel=el('label','Notes (optional)'),notes=el('input');notes.maxLength=500;notes.placeholder='For example: stock for Swabi expansion';notesLabel.append(notes);top.append(dateLabel,notesLabel);
 const lines=[],entry=el('form',undefined,'batch-entry move-entry'),error=el('p',undefined,'error');
 const itemLabel=el('label','Item'),item=el('select'),batchLabel=el('label','Batch'),batch=el('select'),qtyLabel=el('label','Quantity'),qty=el('input'),add=el('button','+ Add to transfer');
 qty.type='number';qty.min='1';qty.step='1';qty.required=true;item.required=batch.required=true;add.type='submit';itemLabel.append(item);batchLabel.append(batch);qtyLabel.append(qty);entry.append(itemLabel,batchLabel,qtyLabel,add);
 const available=row=>Number(row.quantity)-(lines.find(l=>l.row.id===row.id)?.quantity||0);
 const fillItems=()=>{const rows=stock.filter(i=>i.location===from.value&&Number(i.quantity)>0),names=[...new Set(rows.map(i=>i.item))].sort((a,b)=>a.localeCompare(b));
  item.replaceChildren(new Option(from.value?(names.length?'Select item':'No stock in this warehouse'):'Select the From warehouse first',''),...names.map(n=>new Option(`${n} · ${rows.filter(i=>i.item===n).reduce((s,i)=>s+Number(i.quantity),0)} in stock`,n)));fillBatches();};
 const fillBatches=()=>{const rows=stock.filter(i=>i.location===from.value&&i.item===item.value&&Number(i.quantity)>0).sort((a,b)=>String(a.batch).localeCompare(String(b.batch)));
  batch.replaceChildren(new Option(rows.length?'Select batch':'Select an item first',''),...rows.map(r=>{const o=new Option(`${r.batch||'No batch'} · ${available(r)} available · cost Rs ${money(r.unit_cost)}`,r.id);o.disabled=available(r)<=0;return o;}));
  const open=rows.filter(r=>available(r)>0);if(open.length===1)batch.value=String(open[0].id);syncQty();};
 const syncQty=()=>{const row=stock.find(i=>String(i.id)===batch.value);qty.max=row?String(available(row)):'';if(row&&!qty.value)qty.value=String(available(row));};
 let previousFrom='';from.onchange=()=>{if(lines.length&&!confirm('Changing the From warehouse clears the items already added. Continue?')){from.value=previousFrom;return;}lines.length=0;previousFrom=from.value;fillItems();draw();};
 item.onchange=()=>{qty.value='';fillBatches();};batch.onchange=()=>{qty.value='';syncQty();};
 const tableWrap=el('div',undefined,'table-wrap batch-lines'),totals=el('p',undefined,'batch-totals');
 const footer=el('div',undefined,'form-actions batch-actions'),close=el('button','Cancel','secondary'),save=el('button','Move stock');close.type=save.type='button';close.onclick=()=>dialog.close();
 const draw=()=>{const table=el('table'),tr=el('tr');for(const h of ['#','Item','Batch','Category','Quantity','Unit cost','Value',''])tr.append(el('th',h));table.append(el('thead'),el('tbody'));table.tHead.append(tr);
  lines.forEach((l,n)=>{const row=el('tr'),remove=el('button','Remove','danger'),cell=el('td');remove.type='button';remove.onclick=()=>{lines.splice(n,1);fillBatches();draw();};cell.append(remove);
   row.append(el('td',String(n+1)),el('td',l.row.item),el('td',l.row.batch||'—'),el('td',l.row.category),el('td',String(l.quantity)),el('td',money(l.row.unit_cost)),el('td',money(l.quantity*l.row.unit_cost)),cell);table.tBodies[0].append(row);});
  if(!lines.length){const row=el('tr'),td=el('td','No items yet. Choose the From warehouse, then add items above.');td.colSpan=8;row.append(td);table.tBodies[0].append(row);}
  tableWrap.replaceChildren(table);const count=lines.reduce((n,l)=>n+l.quantity,0),value=lines.reduce((n,l)=>n+l.quantity*l.row.unit_cost,0);
  totals.textContent=`${lines.length} line${lines.length===1?'':'s'} · ${count} units · value Rs ${money(value)}`;save.disabled=!lines.length;save.textContent=lines.length?`Move stock (${lines.length} line${lines.length===1?'':'s'})`:'Move stock';};
 entry.onsubmit=event=>{event.preventDefault();error.textContent='';const row=stock.find(i=>String(i.id)===batch.value),n=Number(qty.value);
  if(!row||!Number.isInteger(n)||n<1){error.textContent='Choose an item, its batch and a whole quantity.';return;}
  if(n>available(row)){error.textContent=`Only ${available(row)} available in this batch.`;return;}
  const existing=lines.find(l=>l.row.id===row.id);if(existing)existing.quantity+=n;else lines.push({row,quantity:n});qty.value='';fillBatches();draw();item.focus();};
 save.onclick=async()=>{error.textContent='';if(!to.value||to.value===from.value){error.textContent='Choose a different To warehouse.';to.focus();return;}if(!date.value){error.textContent='Enter the transfer date.';return;}
  save.disabled=true;save.textContent='Moving…';
  try{const response=await fetch('/api/stock-movement',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify({from_warehouse:from.value,to_warehouse:to.value,transfer_date:date.value,notes:notes.value,request_key:requestKey,lines:lines.map(l=>({inventory_id:l.row.id,quantity:l.quantity}))})}),result=await response.json();
   if(response.status===401){await startAuth();throw Error('Sign in again, then move the stock.');}if(!response.ok)throw Error(result.error||'The transfer failed. No stock was moved.');
   const count=lines.reduce((n,l)=>n+l.quantity,0),value=lines.reduce((n,l)=>n+l.quantity*l.row.unit_cost,0);dialog.close();await load();
   $('notice').textContent=`${result.movement_no}: ${count} units (Rs ${money(value)}) moved from ${from.value} to ${to.value} on ${date.value}.`;$('notice').hidden=false;
  }catch(e){error.textContent=e.message;draw();}};
 footer.append(close,save);dialog.append(head,top,entry,error,tableWrap,totals,footer);fillItems();draw();dialog.showModal();
}
// Inventory page buttons.
const movementOriginalRender=render;
render=function(){movementOriginalRender();$('move-stock')?.remove();$('transfer-history')?.remove();
 if(current!=='Inventory'||!$('add'))return;const anchor=$('receive-batch')??$('add');
 const history=el('button','Transfer history','secondary');history.id='transfer-history';history.type='button';history.onclick=()=>{reportChoice='Stock Transfer Report';navigate('Reports');};anchor.after(history);
 if(can('write','Inventory')){const move=el('button','⇄ Move stock',$('add').className);move.id='move-stock';move.type='button';move.onclick=openStockMovement;anchor.after(move);}};

// Reports > Stock Transfer Report.
const trFilters={from:'',to:'',source:'',target:'',item:''};
function renderTransferReport(output){
 if(!trFilters.from){trFilters.from=today().slice(0,8)+'01';trFilters.to=today();}
 output.replaceChildren();const f=trFilters,all=state.transfers??[],houses=[...new Set(all.flatMap(t=>[t.from_warehouse,t.to_warehouse]))].sort();
 const controls=el('form',undefined,'cr-filters'),field=(label,node)=>{const wrap=el('label',label,'cr-field');wrap.append(node);controls.append(wrap);return node;};
 const fromDate=field('From date',Object.assign(el('input'),{type:'date',value:f.from})),toDate=field('To date',Object.assign(el('input'),{type:'date',value:f.to}));
 const month=field('Month',Object.assign(el('input'),{type:'month'}));month.onchange=()=>{if(!month.value)return;const [y,m]=month.value.split('-').map(Number);fromDate.value=month.value+'-01';toDate.value=new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};
 const pick=(label,value)=>{const s=el('select');s.append(new Option('All warehouses',''),...houses.map(h=>new Option(h,h)));s.value=value;return field(label,s);};
 const source=pick('From warehouse',f.source),target=pick('To warehouse',f.target),item=field('Item',Object.assign(el('input'),{type:'search',placeholder:'Item, batch or transfer no.',value:f.item}));
 const go=el('button','Show');go.type='submit';controls.append(go);
 controls.onsubmit=e=>{e.preventDefault();Object.assign(f,{from:fromDate.value,to:toDate.value,source:source.value,target:target.value,item:item.value.trim()});renderTransferReport(output);};
 output.append(el('h2','Stock transfer report'),el('p','Stock moved between warehouses, valued at each batch’s unit cost on the transfer date.','expense-note'),controls);
 const term=f.item.toLowerCase(),rows=all.filter(t=>t.transfer_date>=f.from&&t.transfer_date<=f.to&&(!f.source||t.from_warehouse===f.source)&&(!f.target||t.to_warehouse===f.target)&&(!term||[t.item,t.batch,t.movement_no,t.category].some(v=>String(v||'').toLowerCase().includes(term))));
 const value=t=>Number(t.value??Number(t.quantity)*Number(t.unit_cost||0)),units=rows.reduce((n,t)=>n+Number(t.quantity),0),total=rows.reduce((n,t)=>n+value(t),0);
 const cards=el('div',undefined,'report-summary');for(const [label,shown,hint] of [['Transfers',String(new Set(rows.map(t=>t.movement_no||'#'+t.id)).size),`${rows.length} lines`],['Units moved',units.toLocaleString('en-PK'),`${new Set(rows.map(t=>t.item)).size} different items`],['Value moved','Rs '+money(total),'At unit cost'],['Routes',String(new Set(rows.map(t=>t.from_warehouse+'→'+t.to_warehouse)).size),'Warehouse to warehouse']]){const c=el('article',undefined,'report-summary-card');c.append(el('small',label),el('strong',shown),el('span',hint));cards.append(c);}
 output.append(cards);
 const table=(title,headers,data,moneyCols=[])=>{const box=el('div',undefined,'bo-table');box.append(el('h4',title));const wrap=el('div',undefined,'table-wrap'),t=el('table'),tr=el('tr');headers.forEach(h=>tr.append(el('th',h)));t.append(el('thead'),el('tbody'));t.tHead.append(tr);
  for(const r of data){const row=el('tr');r.forEach((v,i)=>row.append(el('td',moneyCols.includes(i)?money(v):v==null||v===''?'—':String(v))));t.tBodies[0].append(row);}
  if(!data.length){const row=el('tr'),td=el('td','No transfers in this period.');td.colSpan=headers.length;row.append(td);t.tBodies[0].append(row);}wrap.append(t);box.append(wrap);return box;};
 const group=key=>{const m=new Map();for(const t of rows){const k=key(t);if(!m.has(k))m.set(k,[]);m.get(k).push(t);}return [...m];};
 const monthName=m=>new Date(m+'-01T00:00:00Z').toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'});
 const grid=el('div',undefined,'bo-grid');
 grid.append(table('By month',['Month','Transfers','Lines','Units','Value (Rs)'],group(t=>t.transfer_date.slice(0,7)).sort((a,b)=>b[0].localeCompare(a[0])).map(([k,v])=>[monthName(k),new Set(v.map(t=>t.movement_no||'#'+t.id)).size,v.length,v.reduce((n,t)=>n+Number(t.quantity),0),v.reduce((n,t)=>n+value(t),0)]),[4]),
  table('By route',['From','To','Transfers','Units','Value (Rs)'],group(t=>t.from_warehouse+'\u0000'+t.to_warehouse).map(([k,v])=>[...k.split('\u0000'),new Set(v.map(t=>t.movement_no||'#'+t.id)).size,v.reduce((n,t)=>n+Number(t.quantity),0),v.reduce((n,t)=>n+value(t),0)]),[4]));
 output.append(grid);
 const detail=rows.map(t=>[t.transfer_date,t.movement_no||'—',t.item,t.batch,t.category,t.from_warehouse,t.to_warehouse,Number(t.quantity),Number(t.unit_cost||0),value(t),t.actor_name,t.notes]);
 const actions=el('div',undefined,'cr-bar'),excel=el('button','Excel','secondary'),pdf=el('button','PDF','danger');excel.type=pdf.type='button';actions.append(excel,pdf);
 const details=table('All transfers',['Date','Transfer no.','Item','Batch','Category','From','To','Qty','Unit cost (Rs)','Value (Rs)','By','Notes'],detail,[8,9]);details.classList.add('transfer-detail');
 output.append(actions,details);
 excel.onclick=()=>{const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';const lines=[['Date','Transfer no.','Item','Batch','Category','From','To','Qty','Unit cost','Value','By','Notes'],...detail];const blob=new Blob(['﻿'+lines.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=`Stock-transfers_${f.from}_${f.to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 pdf.onclick=()=>window.print();
}
