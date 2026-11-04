'use strict';
// Reports > Collection Reports: Collection Summary, Defaulters and Deleted Collections, with filters by date,
// collector, city, area, collection type, payment mode, bank method and transaction ID.
const ONLINE_METHODS=['Bank transfer','Card','Mobile wallet','1LINK','Easypaisa','JazzCash'];
let crTab='Collection Summary',crPageSize=25,crSearch='',crSort={col:null,dir:1};
const crFilters={from:'',to:'',operator:'',city:'',area:'',type:'Both',payment:'All',methods:[],txn:''};
const crMonth=m=>{if(!m)return '—';const [y,mo]=String(m).split('-');return new Date(Date.UTC(+y,+mo-1,1)).toLocaleString('en-PK',{month:'short',year:'numeric',timeZone:'UTC'});};
const crDate=(v,withTime)=>{if(!v)return '—';const d=new Date(String(v).length===10?v+'T00:00:00+05:00':v);return d.toLocaleString('en-PK',{timeZone:'Asia/Karachi',day:'2-digit',month:'short',year:'numeric',...(withTime?{hour:'2-digit',minute:'2-digit',hour12:false}:{})});};
// Asaan-style "City / Area" cell: city on top, area underneath.
function crPlace(c){const cell=el('div',undefined,'cr-place');cell.append(el('span',c?.city||'—'),el('small',c?.area||''));return cell;}
function crWhatsApp(phone,text){const digits=String(phone||'').replace(/\D/g,'');if(digits.length<10)return null;const intl=digits.startsWith('92')?digits:'92'+digits.replace(/^0/,'');const a=el('a','WhatsApp','document-download');a.href='https://wa.me/'+intl+'?text='+encodeURIComponent(text);a.target='_blank';a.rel='noopener';return a;}
function crData(){
 const customers=new Map((state.records.Customers??[]).map(c=>[c.id,c])),f=crFilters;
 const placeOk=c=>(!f.city||(c?.city||'')===f.city)&&(!f.area||(c?.area||'')===f.area);
 if(crTab==='Defaulters'){
  // Latest unpaid bill per customer in the selected months; its remaining amount already carries earlier arrears.
  const months=[f.from.slice(0,7),f.to.slice(0,7)],latest=new Map();
  for(const i of state.records.Invoices??[]){if(i.billing_month<months[0]||i.billing_month>months[1]||Number(i.remaining)<=0)continue;const c=customers.get(i.customer_id);if(!placeOk(c))continue;const prev=latest.get(i.customer_id);if(!prev||i.billing_month>prev.latest.billing_month)latest.set(i.customer_id,{latest:i,months:[...(prev?.months??[]),i.billing_month]});else prev.months.push(i.billing_month);}
  const lastPaid=new Map();for(const p of state.records.Payments??[])if(!lastPaid.has(p.customer_id)||p.payment_date>lastPaid.get(p.customer_id))lastPaid.set(p.customer_id,p.payment_date);
  const rows=[...latest].map(([id,{latest:i,months}])=>{const c=customers.get(id)??{},due=Number(i.remaining);return {sort:[c.name,c.username,c.phone,(c.city||'')+(c.area||''),c.package,months.length,due,lastPaid.get(id)||'',c.expiry_date],
   cells:[c.name||i.customer_name,c.username||i.username,c.phone||i.phone,crPlace(c),c.package||i.package_name,months.sort().map(crMonth).join(', '),money(due),crDate(lastPaid.get(id)),crDate(c.expiry_date),crWhatsApp(c.phone,`Dear ${c.name}, your internet bill of Rs ${money(due)} is pending. Please pay to avoid disconnection. Payment ID: ${c.payment_id}`)??'—'],
   csv:[c.name,c.username,c.phone,c.city,c.area,c.package,months.join(' '),due,lastPaid.get(id)||'',c.expiry_date],amount:due,customer:id};});
  return {headers:['Client name','Internet ID','Cell','City / Area','Package','Unpaid months','Outstanding (Rs)','Last payment','Expiry',''],csvHeaders:['Client name','Internet ID','Cell','City','Area','Package','Unpaid months','Outstanding','Last payment','Expiry'],rows,label:'DEFAULTERS',unit:'Defaulters'};
 }
 const deleted=crTab==='Deleted Collections',source=deleted?(state.records['Deleted payments']??[]):(state.records.Payments??[]);
 const rows=source.filter(p=>{const c=customers.get(p.customer_id)??{city:p.city,area:p.area},day=deleted?String(p.deleted_at).slice(0,10):p.payment_date;
  return day>=f.from&&day<=f.to&&(deleted||!f.operator||p.recorded_by===f.operator)&&placeOk(c)&&(f.type==='Both'||(p.revenue_type||'MRC')===f.type)&&
   (f.payment==='All'||(f.payment==='Cash'?p.method==='Cash':p.method!=='Cash'))&&(!f.methods.length||f.methods.includes(p.method))&&(!f.txn||String(p.reference||'').toLowerCase().includes(f.txn.toLowerCase()));}).map(p=>{
  const c=customers.get(p.customer_id)??{name:p.customer_name,username:p.username,city:p.city,area:p.area},paid=p.received_at||p.payment_date,note=p.revenue_type==='OTC'?`${p.otc_type||'Other'} · ${p.reference||''}`:(p.reference||'');
  return deleted?{sort:[c.name,c.username,(c.city||'')+(c.area||''),p.method,p.payment_date,p.billing_month,Number(p.amount),p.deleted_by,p.deleted_at,note],cells:[c.name,c.username,crPlace(c),p.method,crDate(p.payment_date),crMonth(p.billing_month),money(Number(p.amount)),p.deleted_by,crDate(p.deleted_at,true),note],csv:[c.name,c.username,c.city,c.area,p.method,p.payment_date,p.billing_month,Number(p.amount),p.deleted_by,p.deleted_at,note],amount:Number(p.amount),customer:p.customer_id}
   :{sort:[c.name,c.username,(c.city||'')+(c.area||''),p.method,paid,p.billing_month,Number(p.amount),p.recorded_by,note],cells:[c.name,c.username,crPlace(c),p.method,crDate(paid,Boolean(p.received_at)),crMonth(p.billing_month),money(Number(p.amount)),p.recorded_by||'—',note],csv:[c.name,c.username,c.city,c.area,p.method,paid,p.billing_month,Number(p.amount),p.recorded_by,note],amount:Number(p.amount),customer:p.customer_id};});
 return deleted?{headers:['Client name','Internet ID','City / Area','Pay by','Paid date','Month','Amount (Rs)','Deleted by','Deleted at','Notes'],csvHeaders:['Client name','Internet ID','City','Area','Pay by','Paid date','Month','Amount','Deleted by','Deleted at','Notes'],rows,label:'DELETED COLLECTIONS',unit:'Clients'}
  :{headers:['Client name','Internet ID','City / Area','Pay by','Paid date','Month','Total paid (Rs)','Collect by','Notes'],csvHeaders:['Client name','Internet ID','City','Area','Pay by','Paid date','Month','Total paid','Collect by','Notes'],rows,label:'COLLECTION SUMMARY',unit:'Clients'};
}
function crSelect(label,value,options,change){const wrap=el('label',label,'cr-field'),select=el('select');for(const [v,t] of options)select.append(new Option(t,v));select.value=value;select.onchange=()=>change(select.value);wrap.append(select);return wrap;}
function renderCollectionReport(output){
 if(!crFilters.from)crFilters.from=today().slice(0,7)+'-01';if(!crFilters.to)crFilters.to=today();
 output.replaceChildren();const tabs=el('div',undefined,'cr-tabs');
 for(const name of ['Collection Summary','Defaulters','Deleted Collections']){const b=el('button',name,name===crTab?'admin-tab selected':'admin-tab');b.type='button';b.setAttribute('aria-pressed',String(name===crTab));b.onclick=()=>{crTab=name;crSort={col:null,dir:1};renderCollectionReport(output);};tabs.append(b);}
 output.append(tabs);
 const customers=state.records.Customers??[],uniq=list=>[...new Set(list.filter(Boolean))].sort((a,b)=>a.localeCompare(b));
 const f=crFilters,form=el('form',undefined,'cr-filters'),date=(label,key)=>{const wrap=el('label',label,'cr-field'),input=el('input');input.type='date';input.value=f[key];input.onchange=()=>{f[key]=input.value;};wrap.append(input);return wrap;};
 form.append(date('From date','from'),date('To date','to'));
 if(crTab==='Collection Summary')form.append(crSelect('Operators',f.operator,[['','All operators'],...uniq((state.records.Payments??[]).map(p=>p.recorded_by)).map(v=>[v,v])],v=>f.operator=v));
 const cities=uniq(customers.map(c=>c.city)),areas=uniq(customers.filter(c=>!f.city||c.city===f.city).map(c=>c.area));
 form.append(crSelect('City',f.city,[['','All cities'],...cities.map(v=>[v,v])],v=>{f.city=v;f.area='';renderCollectionReport(output);}),crSelect('Area',f.area,[['','All areas'],...areas.map(v=>[v,v])],v=>f.area=v));
 if(crTab!=='Defaulters'){
  form.append(crSelect('Collection type',f.type,[['Both','Both'],['MRC','Monthly (MRC)'],['OTC','One-time (OTC)']],v=>f.type=v),crSelect('Payment',f.payment,[['All','All'],['Cash','Cash'],['Online','Online']],v=>{f.payment=v;if(v==='Cash')f.methods=[];renderCollectionReport(output);}));
  const bank=el('details',undefined,'cr-field cr-banks'),summary=el('summary',f.methods.length?f.methods.join(', '):'All banks'),list=el('div');bank.append(el('span','Bank'),summary,list);
  for(const m of ONLINE_METHODS){const label=el('label'),box=el('input');box.type='checkbox';box.checked=f.methods.includes(m);box.disabled=f.payment==='Cash';box.onchange=()=>{f.methods=box.checked?[...f.methods,m]:f.methods.filter(x=>x!==m);summary.textContent=f.methods.length?f.methods.join(', '):'All banks';};label.append(box,document.createTextNode(' '+m));list.append(label);}
  const txn=el('label','Transaction ID','cr-field'),input=el('input');input.type='search';input.placeholder='Enter transaction ID';input.value=f.txn;input.oninput=()=>{f.txn=input.value.trim();};txn.append(input);form.append(bank,txn);
 }
 const fetchButton=el('button','Fetch');fetchButton.type='submit';form.append(fetchButton);
 form.onsubmit=event=>{event.preventDefault();if(f.from>f.to){error.textContent='Choose a To date on or after the From date.';return;}renderCollectionReport(output);};
 const error=el('p',undefined,'error');output.append(form,error);
 const data=crData(),total=data.rows.reduce((n,r)=>n+r.amount,0),clients=new Set(data.rows.map(r=>r.customer)).size;
 const head=el('div',undefined,'cr-head'),card=el('div',undefined,'cr-total'+(crTab==='Collection Summary'?'':' cr-total-alert'));card.append(el('small',data.label),el('strong','Rs. '+money(total)),el('span',`${clients} ${data.unit}`));
 head.append(el('h2',crTab==='Collection Summary'?'Collection records':crTab==='Defaulters'?'Defaulters (unpaid bills)':'Deleted collections'),card);output.append(head);
 if(crTab==='Deleted Collections')output.append(el('p','Payments deleted by an administrator, kept here permanently. Payments that already have a permanent receipt cannot be deleted.','expense-note'));
 if(crTab==='Defaulters')output.append(el('p','Customers with an unpaid monthly bill in the selected months. Outstanding includes earlier unpaid months carried forward.','expense-note'));
 const bar=el('div',undefined,'cr-bar'),excel=el('button','Excel','secondary'),pdf=el('button','PDF','danger'),show=el('label','Show','cr-show'),size=el('select'),search=el('input');
 for(const n of [10,25,50,100,0])size.append(new Option(n||'All',String(n)));size.value=String(crPageSize);show.append(size,document.createTextNode(' entries'));
 search.type='search';search.placeholder='Search';search.value=crSearch;search.setAttribute('aria-label','Search records');
 excel.type=pdf.type='button';bar.append(excel,pdf,show,search);output.append(bar);
 const wrap=el('div',undefined,'table-wrap cr-table'),info=el('p',undefined,'expense-note');output.append(wrap,info);
 const visible=()=>{const term=crSearch.toLowerCase();let rows=data.rows.filter(r=>!term||r.csv.some(v=>String(v??'').toLowerCase().includes(term)));if(crSort.col!==null)rows=[...rows].sort((a,b)=>{const x=a.sort[crSort.col],y=b.sort[crSort.col];return (typeof x==='number'&&typeof y==='number'?x-y:String(x??'').localeCompare(String(y??'')))*crSort.dir;});return rows;};
 const draw=()=>{const rows=visible(),shown=crPageSize?rows.slice(0,crPageSize):rows,table=el('table'),tr=el('tr');
  tr.append(el('th','SNO'));data.headers.forEach((h,i)=>{const th=el('th',h+(crSort.col===i?(crSort.dir>0?' ▲':' ▼'):''));if(h){th.className='cr-sortable';th.onclick=()=>{crSort={col:i,dir:crSort.col===i?-crSort.dir:1};draw();};}tr.append(th);});
  table.append(el('thead'),el('tbody'));table.tHead.append(tr);
  shown.forEach((r,n)=>{const row=el('tr');row.append(el('td',String(n+1)));for(const v of r.cells){const td=el('td');if(v instanceof Node)td.append(v);else td.textContent=v??'—';row.append(td);}table.tBodies[0].append(row);});
  if(!shown.length){const row=el('tr'),td=el('td','No records match these filters.');td.colSpan=data.headers.length+1;row.append(td);table.tBodies[0].append(row);}
  wrap.replaceChildren(table);info.textContent=`Showing ${shown.length} of ${rows.length} entries${rows.length!==data.rows.length?` (filtered from ${data.rows.length})`:''}`;};
 size.onchange=()=>{crPageSize=Number(size.value);draw();};search.oninput=()=>{crSearch=search.value;draw();};
 excel.onclick=()=>{const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';const lines=[['SNO',...data.csvHeaders],...visible().map((r,i)=>[i+1,...r.csv])];const blob=new Blob(['﻿'+lines.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=`${crTab.replaceAll(' ','-')}_${f.from}_${f.to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 pdf.onclick=()=>{const previous=crPageSize;crPageSize=0;draw();window.print();crPageSize=previous;draw();};
 draw();
}
