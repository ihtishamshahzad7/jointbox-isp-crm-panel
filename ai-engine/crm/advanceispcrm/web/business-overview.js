'use strict';
// Reports > Business Overview: every part of the business for one period on a single page —
// customers, billing and collections, expenses and profit, inventory, support tickets and team.
// Each section appears only for users who may read that data.
let boFrom='',boTo='',boExport=[];
function boPreset(name){
 const t=today(),y=+t.slice(0,4),m=+t.slice(5,7),iso=(yy,mm,dd)=>new Date(Date.UTC(yy,mm-1,dd)).toISOString().slice(0,10);
 if(name==='This month')return [t.slice(0,8)+'01',t];
 if(name==='Last month')return [iso(y,m-1,1),iso(y,m,0)];
 if(name==='Last 3 months')return [iso(y,m-2,1),t];
 if(name==='This year')return [y+'-01-01',t];
 const dates=[...(state.records.Customers??[]).map(c=>c.joined),...(state.records.Payments??[]).map(p=>p.payment_date),...(state.records.Expenses??[]).map(e=>e.expense_date)].filter(Boolean).sort();
 return [dates[0]||t,t];
}
function boSection(output,title,note){const s=el('section',undefined,'bo-section');s.append(el('h3',title));if(note)s.append(el('p',note,'expense-note'));output.append(s);return s;}
// Card values: a number is rupees, boN(n) is a plain count, a string is shown as it is.
const boN=count=>({count});
function boCards(parent,cards,section){const grid=el('div',undefined,'report-summary');for(const [label,value,hint,tone] of cards){const count=value&&typeof value==='object',shown=count?Number(value.count).toLocaleString('en-PK'):typeof value==='number'?'Rs '+money(value):String(value);const card=el('article',undefined,'report-summary-card'+(tone?' '+tone:''));card.append(el('small',label),el('strong',shown),el('span',hint||''));grid.append(card);boExport.push([section,label,count?value.count:typeof value==='number'?value:String(value),hint||'']);}parent.append(grid);}
function boTable(parent,title,headers,rows,section,moneyCols=[]){
 const box=el('div',undefined,'bo-table');box.append(el('h4',title));
 if(!rows.length){box.append(el('p','Nothing in this period.','expense-note'));parent.append(box);return;}
 const wrap=el('div',undefined,'table-wrap'),table=el('table'),tr=el('tr');headers.forEach(h=>tr.append(el('th',h)));table.append(el('thead'),el('tbody'));table.tHead.append(tr);
 for(const r of rows){const row=el('tr');r.forEach((v,i)=>row.append(el('td',moneyCols.includes(i)&&typeof v==='number'?money(v):v==null||v===''?'—':String(v))));table.tBodies[0].append(row);boExport.push([section+' · '+title,...r]);}
 wrap.append(table);box.append(wrap);parent.append(box);
}
function boGroup(items,key){const m=new Map();for(const i of items){const k=key(i)||'Not set';if(!m.has(k))m.set(k,[]);m.get(k).push(i);}return [...m].sort((a,b)=>b[1].length-a[1].length||String(a[0]).localeCompare(String(b[0])));}
const boSum=(items,f)=>items.reduce((n,i)=>n+Number(f(i)||0),0);
const boPct=(a,b)=>b?(a/b*100).toFixed(1)+'%':'—';
function renderBusinessOverview(output){
 if(!boFrom)[boFrom,boTo]=boPreset('This month');
 output.replaceChildren();boExport=[];
 const r=state.records,from=boFrom,to=boTo,t=today(),inRange=d=>Boolean(d)&&String(d).slice(0,10)>=from&&String(d).slice(0,10)<=to;
 const pkDay=v=>v?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v)):'';
 // Period controls.
 const controls=el('div',undefined,'bo-controls');
 for(const [label,get,set] of [['From',()=>boFrom,v=>boFrom=v],['To',()=>boTo,v=>boTo=v]]){const wrap=el('label',label),input=el('input');input.type='date';input.value=get();input.onchange=()=>{set(input.value);if(boFrom&&boTo&&boFrom<=boTo)renderBusinessOverview(output);};wrap.append(input);controls.append(wrap);}
 for(const name of ['This month','Last month','Last 3 months','This year','All time']){const b=el('button',name,'secondary');b.type='button';b.onclick=()=>{[boFrom,boTo]=boPreset(name);renderBusinessOverview(output);};controls.append(b);}
 const csv=el('button','Export CSV','secondary'),print=el('button','Print / PDF','secondary');csv.type=print.type='button';controls.append(csv,print);output.append(controls);
 output.append(el('h2','Business overview'),el('p',`${from} to ${to} · generated ${new Date().toLocaleString('en-PK',{timeZone:'Asia/Karachi'})}`,'expense-note'));
 const customers=r.Customers??[],payments=r.Payments??[],invoices=r.Invoices??[],expenses=r.Expenses??[],inventory=r.Inventory??[],issues=r['Stock issues']??[],tickets=r.Tickets??[],staff=r.Staff??[];
 const canPay=can('read','Payments'),canCust=can('read','Customers'),canExp=can('read','Expenses'),canInv=can('read','Inventory'),canTic=can('read','Tickets'),canStaff=can('read','Staff');
 const received=payments.filter(p=>inRange(p.payment_date)),collected=boSum(received,p=>p.amount);
 // Latest unpaid bill per customer carries the full outstanding amount (earlier arrears are carried forward into it).
 const latestBill=new Map();for(const i of invoices){const prev=latestBill.get(i.customer_id);if(!prev||i.billing_month>prev.billing_month)latestBill.set(i.customer_id,i);}
 const outstandingOf=id=>Math.max(0,Number(latestBill.get(id)?.remaining||0)),outstanding=[...latestBill.keys()].reduce((n,id)=>n+outstandingOf(id),0),defaulters=[...latestBill.keys()].filter(id=>outstandingOf(id)>0);
 const health=canPay&&canExp&&typeof reportData==='function'?reportData(r,'Business Health (Net Profit)',from,to):null,healthValue=label=>health?.summary?.find(s=>s[0]===label)?.[1]??0;
 const paidExpenses=expenses.filter(e=>e.status==='Paid'&&inRange(e.payment_date||e.expense_date)),spent=boSum(paidExpenses,e=>e.amount);
 const active=customers.filter(c=>c.status==='Active'),joined=customers.filter(c=>inRange(c.joined));
 const openTickets=tickets.filter(x=>!['Resolved','Closed'].includes(x.status)),stockValue=boSum(inventory,i=>Number(i.quantity)*Number(i.unit_cost));
 // Headline numbers.
 const head=[];
 if(canPay)head.push(['Revenue collected',collected,`${received.length} payments · ${new Set(received.map(p=>p.customer_id)).size} customers`,'good']);
 if(canExp)head.push(['Expenses paid',spent,`${paidExpenses.length} expenses`]);
 if(health){const net=healthValue('Net profit');head.push(['Net profit',net,'Revenue − package cost − expenses',net>=0?'good':'bad']);}
 if(canPay)head.push(['Outstanding now',outstanding,`${defaulters.length} customers with unpaid bills`,outstanding>0?'bad':'']);
 if(canCust)head.push(['Active customers',boN(active.length),`of ${customers.length} total`],['New customers',boN(joined.length),'joined in this period']);
 if(canTic)head.push(['Open tickets',boN(openTickets.length),`${openTickets.filter(x=>x.due_at&&new Date(x.due_at)<new Date()).length} overdue`]);
 if(canInv)head.push(['Stock value',stockValue,`${boSum(inventory,i=>i.quantity)} units at cost`]);
 if(r.Assets)head.push(['Asset value',boSum(r.Assets.filter(a=>a.condition!=='Destroyed'),a=>a.value),`${r.Assets.filter(a=>a.condition!=='Destroyed').length} assets in use`]);
 boCards(output,head,'Headline');
 if(canCust){
  const s=boSection(output,'Customers','Status today; new customers by join date in this period. Run-rate is the monthly fees of active customers.'),week=new Date(Date.parse(t+'T00:00:00Z')+7*864e5).toISOString().slice(0,10);
  const runRate=boSum(active,c=>c.monthly_fee),expiring=active.filter(c=>c.expiry_date>=t&&c.expiry_date<=week),expired=customers.filter(c=>c.status!=='Terminated'&&c.expiry_date&&c.expiry_date<t);
  boCards(s,[['Total customers',boN(customers.length),''],['Active',boN(active.length),boPct(active.length,customers.length)+' of all'],['Monthly run-rate',runRate,'Active customers’ monthly fees'],['Average fee (ARPU)',active.length?Math.round(runRate/active.length):0,'Per active customer'],['Expiring in 7 days',boN(expiring.length),'Active, expiry by '+week],['Expired',boN(expired.length),'Expiry date passed, not terminated',expired.length?'bad':'']],'Customers');
  const grid=el('div',undefined,'bo-grid');s.append(grid);
  boTable(grid,'By status',['Status','Customers','Share'],boGroup(customers,c=>c.status).map(([k,v])=>[k,v.length,boPct(v.length,customers.length)]),'Customers');
  boTable(grid,'By area',['Area','City','Customers','Active','New','Run-rate (Rs)'].concat(canPay?['Collected (Rs)','Outstanding (Rs)']:[]),boGroup(customers,c=>c.area).map(([k,v])=>{const ids=new Set(v.map(c=>c.id));return [k,v[0].city||'',v.length,v.filter(c=>c.status==='Active').length,v.filter(c=>inRange(c.joined)).length,boSum(v.filter(c=>c.status==='Active'),c=>c.monthly_fee),...(canPay?[boSum(received.filter(p=>ids.has(p.customer_id)),p=>p.amount),v.reduce((n,c)=>n+outstandingOf(c.id),0)]:[])];}),'Customers',[5,6,7]);
  boTable(grid,'By package',['Package','Customers','Active','Run-rate (Rs)'],boGroup(customers,c=>c.package).map(([k,v])=>[k,v.length,v.filter(c=>c.status==='Active').length,boSum(v.filter(c=>c.status==='Active'),c=>c.monthly_fee)]),'Customers',[3]);
  boTable(grid,'Expiring in the next 7 days',['Customer','Internet ID','Phone','Area','Expiry'],expiring.sort((a,b)=>a.expiry_date.localeCompare(b.expiry_date)).slice(0,50).map(c=>[c.name,c.username,c.phone,c.area,c.expiry_date]),'Customers');
 }
 if(canPay){
  const s=boSection(output,'Billing & collections','Collections by payment date. Bills by billing month inside this period; collection rate compares what was paid against those bills.');
  const months=new Set();for(let m=from.slice(0,7);m<=to.slice(0,7);m=new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),1)).toISOString().slice(0,7))months.add(m);
  const bills=invoices.filter(i=>months.has(i.billing_month)),billed=boSum(bills,i=>i.amount),billPaid=bills.reduce((n,i)=>n+Math.min(Number(i.paid||0),Number(i.amount||0)),0);
  const mrc=boSum(received.filter(p=>p.revenue_type!=='OTC'),p=>p.amount),deleted=(r['Deleted payments']??[]).filter(d=>inRange(pkDay(d.deleted_at)));
  boCards(s,[['Collected',collected,`${received.length} payments`,'good'],['Monthly (MRC)',mrc,'Subscriptions'],['One-time (OTC)',collected-mrc,'Installation, equipment, services'],['Bills raised',billed,`${bills.length} bills`],['Collection rate',boPct(billPaid,billed),`Rs ${money(billPaid)} of those bills paid`],['Outstanding now',outstanding,`${defaulters.length} defaulters`,outstanding>0?'bad':''],...(deleted.length?[['Payments deleted',boSum(deleted,d=>d.amount),`${deleted.length} deleted in this period`,'bad']]:[])],'Billing & collections');
  const grid=el('div',undefined,'bo-grid');s.append(grid);
  boTable(grid,'By payment method',['Method','Payments','Amount (Rs)','Share'],boGroup(received,p=>p.method).map(([k,v])=>[k,v.length,boSum(v,p=>p.amount),boPct(boSum(v,p=>p.amount),collected)]),'Billing',[2]);
  boTable(grid,'By collector',['Collected by','Payments','Customers','Amount (Rs)'],boGroup(received,p=>p.recorded_by).map(([k,v])=>[k,v.length,new Set(v.map(p=>p.customer_id)).size,boSum(v,p=>p.amount)]),'Billing',[3]);
  boTable(grid,'By month paid',['Month','Payments','MRC (Rs)','OTC (Rs)','Total (Rs)'],boGroup(received,p=>p.payment_date.slice(0,7)).sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>[k,v.length,boSum(v.filter(p=>p.revenue_type!=='OTC'),p=>p.amount),boSum(v.filter(p=>p.revenue_type==='OTC'),p=>p.amount),boSum(v,p=>p.amount)]),'Billing',[2,3,4]);
  const byId=new Map(customers.map(c=>[c.id,c]));
  boTable(grid,'Top defaulters',['Customer','Internet ID','Phone','Area','Outstanding (Rs)'],defaulters.sort((a,b)=>outstandingOf(b)-outstandingOf(a)).slice(0,25).map(id=>{const c=byId.get(id)??{};return [c.name,c.username,c.phone,c.area,outstandingOf(id)];}),'Billing',[4]);
 }
 if(canExp){
  const s=boSection(output,'Expenses & profit','Cash basis: paid expenses by payment date. Profit uses the same rules as the Business Health report.');
  const pending=expenses.filter(e=>e.status==='Pending');
  boCards(s,[['Expenses paid',spent,`${paidExpenses.length} expenses`],['Pending bills',boSum(pending,e=>e.amount),`${pending.length} not yet paid`,pending.length?'bad':''],...(health?[['Package / bandwidth cost',healthValue('Package cost'),'Cost of bills raised'],['Net profit',healthValue('Net profit'),boPct(healthValue('Net profit'),collected)+' margin',healthValue('Net profit')>=0?'good':'bad']]:[])],'Expenses & profit');
  const grid=el('div',undefined,'bo-grid');s.append(grid);
  boTable(grid,'Paid expenses by category',['Category','Expenses','Amount (Rs)','Share'],boGroup(paidExpenses,e=>e.category).map(([k,v])=>[k,v.length,boSum(v,e=>e.amount),boPct(boSum(v,e=>e.amount),spent)]),'Expenses',[2]);
  boTable(grid,'Pending bills',['Title','Payee','Category','Date','Amount (Rs)'],pending.slice(0,25).map(e=>[e.title,e.payee,e.category,e.expense_date,Number(e.amount)]),'Expenses',[4]);
 }
 if(canInv){
  const s=boSection(output,'Inventory','Stock on hand today; stock issued and returned in this period.');
  const low=inventory.filter(i=>Number(i.quantity)<=Number(i.minimum_stock)),issued=issues.filter(x=>inRange(x.issue_date)),returned=issues.filter(x=>inRange(pkDay(x.returned_at))),pendingRecovery=issues.filter(x=>x.status==='Issued'&&x.recovery_required==='Yes');
  boCards(s,[['Stock value (cost)',stockValue,`${inventory.length} batch lines`],['Retail value',boSum(inventory,i=>Number(i.quantity)*Number(i.selling_price||i.unit_cost)),'At selling prices'],['Units in stock',boN(boSum(inventory,i=>i.quantity)),`${new Set(inventory.map(i=>i.item)).size} different items`],['Low stock',boN(low.length),'At or below minimum',low.length?'bad':''],['Units issued',boN(boSum(issued,x=>x.quantity)),`${issued.length} issues · Rs ${money(boSum(issued,x=>Number(x.quantity)*Number(x.unit_cost_at_issue||0)))} at cost`],['Units returned',boN(boSum(returned,x=>x.quantity)),`${returned.length} returns`],['Awaiting recovery',boN(pendingRecovery.length),'Issued items to be recovered']],'Inventory');
  const grid=el('div',undefined,'bo-grid');s.append(grid);
  boTable(grid,'Low stock',['Item','Batch','Warehouse','In stock','Minimum'],low.map(i=>[i.item,i.batch,i.location,i.quantity,i.minimum_stock]),'Inventory');
  boTable(grid,'By warehouse',['Warehouse','Batch lines','Units','Value (Rs)'],boGroup(inventory,i=>i.location).map(([k,v])=>[k,v.length,boSum(v,i=>i.quantity),boSum(v,i=>Number(i.quantity)*Number(i.unit_cost))]),'Inventory',[3]);
  boTable(grid,'By category',['Category','Items','Units','Value (Rs)'],boGroup(inventory,i=>i.category).map(([k,v])=>[k,new Set(v.map(i=>i.item)).size,boSum(v,i=>i.quantity),boSum(v,i=>Number(i.quantity)*Number(i.unit_cost))]),'Inventory',[3]);
  boTable(grid,'Issued in this period',['Issued to','Issues','Units','Cost (Rs)'],boGroup(issued,x=>x.issued_against).map(([k,v])=>[k,v.length,boSum(v,x=>x.quantity),boSum(v,x=>Number(x.quantity)*Number(x.unit_cost_at_issue||0))]),'Inventory',[3]);
 }
 if(r.Assets){
  const s=boSection(output,'Assets','Company equipment and property today (Operations › Assets); purchases by purchase date in this period.');
  const assets=r.Assets,inUse=assets.filter(a=>a.condition!=='Destroyed'),bought=assets.filter(a=>inRange(a.purchased_on)),attention=assets.filter(a=>['Under repair','Damaged'].includes(a.condition));
  boCards(s,[['Assets in use',boN(inUse.length),`${new Set(inUse.map(a=>a.location).filter(Boolean)).size} locations`],['Asset value',boSum(inUse,a=>a.value),'Purchase value of assets in use'],['Bought in period',boSum(bought,a=>a.value),`${bought.length} assets`],['Needing attention',boN(attention.length),'Under repair or damaged',attention.length?'bad':''],['Without invoice',boN(assets.filter(a=>!a.invoice_count).length),'No bill attached yet']],'Assets');
  const grid=el('div',undefined,'bo-grid');s.append(grid);
  boTable(grid,'By condition',['Condition','Assets','Value (Rs)'],boGroup(assets,a=>a.condition).map(([k,v])=>[k,v.length,boSum(v,a=>a.value)]),'Assets',[2]);
  boTable(grid,'By location',['Location','Assets','Value (Rs)'],boGroup(inUse,a=>a.location).map(([k,v])=>[k,v.length,boSum(v,a=>a.value)]),'Assets',[2]);
  boTable(grid,'Bought in this period',['Asset','Serial','Batch','Location','Purchased','Value (Rs)'],bought.slice(0,50).map(a=>[a.name,a.serial,a.batch,a.location,a.purchased_on,Number(a.value||0)]),'Assets',[5]);
  boTable(grid,'Needing attention',['Asset','Serial','Location','Condition','Value (Rs)'],attention.map(a=>[a.name,a.serial,a.location,a.condition,Number(a.value||0)]),'Assets',[4]);
 }
 if(canTic){
  const s=boSection(output,'Support tickets','Opened and resolved by date in this period; open and overdue as of now.');
  const opened=tickets.filter(x=>inRange(pkDay(x.created_at))),resolved=tickets.filter(x=>inRange(pkDay(x.resolved_at))),overdue=openTickets.filter(x=>x.due_at&&new Date(x.due_at)<new Date());
  const hours=resolved.filter(x=>x.created_at).map(x=>(new Date(x.resolved_at)-new Date(x.created_at))/36e5),avg=hours.length?(hours.reduce((a,b)=>a+b,0)/hours.length).toFixed(1)+' h':'—';
  boCards(s,[['Opened',boN(opened.length),'In this period'],['Resolved',boN(resolved.length),'In this period','good'],['Open now',boN(openTickets.length),`${openTickets.filter(x=>!x.assigned_to).length} unassigned`],['Overdue now',boN(overdue.length),'Past their due time',overdue.length?'bad':''],['Average resolution',avg,'Created to resolved']],'Tickets');
  const grid=el('div',undefined,'bo-grid');s.append(grid);
  boTable(grid,'Opened by type',['Type','Opened','Resolved','Still open'],boGroup(opened,x=>x.type).map(([k,v])=>[k,v.length,v.filter(x=>['Resolved','Closed'].includes(x.status)).length,v.filter(x=>!['Resolved','Closed'].includes(x.status)).length]),'Tickets');
  boTable(grid,'Open by priority',['Priority','Open','Overdue'],boGroup(openTickets,x=>x.priority).map(([k,v])=>[k,v.length,v.filter(x=>x.due_at&&new Date(x.due_at)<new Date()).length]),'Tickets');
  if(canStaff){const names=new Map(staff.map(m=>[m.id,m.name]));boTable(grid,'Open by assignee',['Assigned to','Open','Overdue'],boGroup(openTickets,x=>names.get(x.assigned_to)||'Unassigned').map(([k,v])=>[k,v.length,v.filter(x=>x.due_at&&new Date(x.due_at)<new Date()).length]),'Tickets');}
 }
 if(canStaff){
  const s=boSection(output,'Team','Employees today.');
  boCards(s,[['Employees',boN(staff.length),''],['Available',boN(staff.filter(m=>m.status==='Available').length),''],['On duty',boN(staff.filter(m=>m.status==='On duty').length),''],['On leave',boN(staff.filter(m=>m.status==='On leave').length),'']],'Team');
  const grid=el('div',undefined,'bo-grid');s.append(grid);
  boTable(grid,'By role',['Role','Employees','Available'],boGroup(staff,m=>m.role).map(([k,v])=>[k,v.length,v.filter(m=>m.status==='Available').length]),'Team');
  boTable(grid,'By area',['Area','Employees'],boGroup(staff,m=>m.area).map(([k,v])=>[k,v.length]),'Team');
 }
 csv.onclick=()=>{const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';const lines=[['Business overview',from,to],[],['Section','Metric / row','Value','Details'],...boExport];const blob=new Blob(['﻿'+lines.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=`Business-overview_${from}_${to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 print.onclick=()=>window.print();
}
