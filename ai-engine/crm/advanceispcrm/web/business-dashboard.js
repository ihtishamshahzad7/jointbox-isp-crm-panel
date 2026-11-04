'use strict';
let businessDay=null,businessMonth=null;
function businessFigures(records,day,month){
 const invoices=records.Invoices??[],payments=records.Payments??[],expenses=records.Expenses??[],customers=records.Customers??[],activations=records.Recharges??[];
 const sum=(rows,field='amount')=>rows.reduce((n,r)=>n+Number(r[field]||0),0);
 const pktDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
 function period(match){
  const receipts=payments.filter(p=>match(p.payment_date)),bills=invoices.filter(i=>match(i.issue_date));
  const mrc=sum(receipts.filter(p=>p.revenue_type!=='OTC')),otc=sum(receipts.filter(p=>p.revenue_type==='OTC'));
  const paidExpenses=sum(expenses.filter(e=>e.status==='Paid'&&e.payment_date&&match(e.payment_date)));
  const billed=sum(bills);const terminations=(records['Equipment recovery']??[]).filter(t=>match(t.terminated_on));
  const terminatedCustomers=new Set(terminations.map(t=>t.customer_id??('event-'+t.id))).size,activeCustomers=customers.filter(c=>c.status==='Active').length;
  return {terminatedCustomers,totalCustomers:customers.length,activeCustomers,terminationPercent:customers.length?100*terminatedCustomers/customers.length:null,terminatedToActivePercent:activeCustomers?100*terminatedCustomers/activeCustomers:null,terminations:terminations.length,revenueLost:sum(terminations,'monthly_revenue_loss'),sales:billed+otc,billed,billCount:bills.length,mrc,otc,collected:mrc+otc,paidExpenses,netCash:mrc+otc-paidExpenses,newCustomers:customers.filter(c=>match(c.joined)).length,activations:activations.filter(a=>match(pktDay(a.activated_at))).length};
 }
 const daily=period(value=>value===day),monthly=period(value=>String(value??'').startsWith(month));
 const byCustomer=new Map(),issuedKeys=new Set();
 for(const invoice of invoices.filter(i=>i.issue_date<=day)){byCustomer.set(invoice.customer_id,(byCustomer.get(invoice.customer_id)||0)+Number(invoice.amount));issuedKeys.add(invoice.customer_id+'|'+invoice.billing_month);}
 for(const p of payments.filter(p=>p.revenue_type!=='OTC'&&p.payment_date<=day&&issuedKeys.has(p.customer_id+'|'+p.billing_month)))byCustomer.set(p.customer_id,(byCustomer.get(p.customer_id)||0)-Number(p.amount));
 const outstanding=[...byCustomer.values()].reduce((n,v)=>n+Math.max(0,v),0),owing=[...byCustomer.values()].filter(v=>v>0).length;
 const methods=[...new Set(payments.filter(p=>p.payment_date.startsWith(month)).map(p=>p.method))].sort().map(method=>{const rows=payments.filter(p=>p.method===method&&p.payment_date.startsWith(month));return {method,mrc:sum(rows.filter(p=>p.revenue_type!=='OTC')),otc:sum(rows.filter(p=>p.revenue_type==='OTC')),total:sum(rows)};});
 const [year,monthNo]=month.split('-').map(Number),days=new Date(Date.UTC(year,monthNo,0)).getUTCDate();
 const breakdown=Array.from({length:days},(_,i)=>{const date=month+'-'+String(i+1).padStart(2,'0');return {date,...period(value=>value===date)};});
 return {daily,monthly,outstanding,owing,methods,breakdown};
}
function buildFinancialDashboard(records,todayString,includeProfit=true){
 const root=el('section',undefined,'business-dashboard');root.setAttribute('aria-label','Sales billing and collection dashboard');
 const draw=()=>{
  const day=businessDay??todayString,month=businessMonth??todayString.slice(0,7),data=businessFigures(records,day,month);
  const head=el('div',undefined,'business-heading'),copy=el('div');copy.append(el('h2','Sales, billing & collections'),el('p','MRC = monthly bills | OTC = one-time charges. All dates use Pakistan time.'));
  const filters=el('div',undefined,'business-filters');
  for(const [title,type,value,update]of [['Daily date','date',day,v=>businessDay=v],['Monthly period','month',month,v=>businessMonth=v]]){const label=el('label',title),input=el('input');input.type=type;input.value=value;input.required=true;input.onchange=()=>{if(input.value&&input.checkValidity()){update(input.value);draw();}};label.append(input);filters.append(label);}
  head.append(copy,filters);root.replaceChildren(head,buildDailyGraphs(records,month));
  const groups=el('div',undefined,'business-periods');
  for(const [title,period,figures]of [['Daily performance',day,data.daily],['Monthly performance',month,data.monthly]]){
   const section=el('article',undefined,'business-period');section.append(el('h3',title+' - '+period));const grid=el('div',undefined,'business-metrics');
   for(const [label,value,tone,currency=true]of [['Total sales',figures.sales,'blue'],['MRC bills raised',figures.billed,'blue'],['OTC sales (paid)',figures.otc,'purple'],['MRC bill collection',figures.mrc,'green'],['OTC collection',figures.otc,'purple'],['Total collection',figures.collected,'green'],['Paid expenses',figures.paidExpenses,'orange'],['Net cash',figures.netCash,'blue'],['Monthly MRC lost to terminations',figures.revenueLost,'orange'],['Terminated accounts',figures.terminations,'orange',false]]){const tile=el('div',undefined,'business-metric '+tone);tile.append(el('small',label),el('strong',(currency?'Rs ':'')+money(value)));grid.append(tile);}
   for(const [label,value,note]of [['Termination percentage',figures.terminationPercent,`${figures.terminatedCustomers} distinct customers terminated in this period ÷ ${figures.totalCustomers} total customer accounts currently recorded × 100.`],['Terminated-to-active percentage',figures.terminatedToActivePercent,`${figures.terminatedCustomers} distinct customers terminated in this period ÷ ${figures.activeCustomers} currently active accounts × 100.`]]){const tile=el('div',undefined,'business-metric orange');tile.append(el('small',label),el('strong',value===null?'N/A':value.toFixed(2)+'%'),el('p',note,'business-note'));grid.append(tile);}
   section.append(grid,el('p',`${figures.billCount} bills raised | ${figures.newCustomers} new customers | ${figures.activations} recharges / activations | ${figures.terminations} terminations`,'business-note'));groups.append(section);
  }root.append(groups,el('p','Termination percentages use distinct customers terminated in the selected day/month and today’s customer counts. They are comparison ratios, not historical churn rates. A zero denominator is shown as N/A.','business-note'));
  if(includeProfit&&typeof reportData==='function'&&can('read','Expenses'))root.append(buildProfitPanel(records,month));
  const arrears=el('div',undefined,'business-arrears');arrears.append(el('strong',`Outstanding billed balance: Rs ${money(data.outstanding)}`),el('span',`${data.owing} customer accounts owing | As of ${day}`));root.append(arrears);
  const table=(headers,rows)=>{const wrap=el('div',undefined,'business-table-wrap'),table=el('table'),head=el('tr'),thead=el('thead'),body=el('tbody');for(const h of headers)head.append(el('th',h));thead.append(head);table.append(thead);for(const values of rows){const row=el('tr');for(const value of values)row.append(el('td',value));body.append(row);}table.append(body);wrap.append(table);if(!rows.length)wrap.append(el('p','No records in this period.','business-note'));return wrap;};
  const methods=el('details',undefined,'business-detail');methods.append(el('summary','Monthly collection by payment method'),table(['Method','MRC (PKR)','OTC (PKR)','Total (PKR)'],data.methods.map(m=>[m.method,money(m.mrc),money(m.otc),money(m.total)])));root.append(methods);
  const detail=el('details',undefined,'business-detail');detail.append(el('summary','Daily breakdown for '+month),table(['Date','MRC billed','OTC sales (paid)','Total sales','Bill collection','OTC collection','Total collection','Paid expenses','Net cash','Terminations','Monthly MRC lost'],data.breakdown.map(r=>[r.date,...[r.billed,r.otc,r.sales,r.mrc,r.otc,r.collected,r.paidExpenses,r.netCash,r.terminations,r.revenueLost].map(money)])));root.append(detail);
  root.append(el('p','Sales = MRC subscription invoices raised + paid OTC charges. OTC sales are currently recognized only when paid; unpaid installation charges are tracked separately in customer Finance. Collections use payment dates. Carried arrears are not counted again as sales. Termination loss is the monthly subscription run-rate at termination, not cash lost in that day. Net cash = receipts minus paid expenses, not profit. Outstanding covers saved bills less matched MRC receipts, including later-month arrears settlements; unbilled months are excluded.','business-note'));
 };draw();return root;
}
// Monthly profit & loss, from the same calculation as the Profit & Loss Statement report.
function buildProfitPanel(records,month,pickMonth=false){
 const [year,monthNo]=month.split('-').map(Number),from=month+'-01',to=month+'-'+String(new Date(Date.UTC(year,monthNo,0)).getUTCDate()).padStart(2,'0');
 const data=reportData(records,'Profit & Loss Statement',from,to),value=label=>data.rows.find(r=>r[0]===label)?.[1]??0,share=label=>data.rows.find(r=>r[0]===label)?.[2]??'—';
 const gross=data.rows.find(r=>/^Gross (profit|loss)$/.test(r[0])),net=data.rows.find(r=>/^Net (profit|loss)$/.test(r[0]));
 const section=el('article',undefined,'business-period business-profit'),head=el('div',undefined,'business-profit-heading'),open=el('button','Open full statement','secondary');
 open.type='button';open.onclick=()=>{reportChoice='Profit & Loss Statement';reportFrom=from;reportTo=to;navigate('Reports');};
 const actions=el('div',undefined,'business-profit-actions');
 if(pickMonth){const label=el('label','Month'),input=el('input');input.type='month';input.value=month;input.required=true;input.onchange=()=>{if(input.value)section.replaceWith(buildProfitPanel(records,input.value,true));};label.append(input);actions.append(label);}
 actions.append(open);head.append(el('h3','Profit & loss - '+month),actions);section.append(head);
 const grid=el('div',undefined,'business-metrics');
 for(const [label,amount,tone,note]of [['Income',value('Total income'),'blue','Money collected'],['Cost of service',value('Total cost of service'),'orange','Package / bandwidth cost'],[gross[0],gross[1],gross[1]>=0?'green':'red','Margin '+gross[2]],['Operating expenses',value('Total operating expenses'),'orange','Paid business expenses'],[net[0],net[1],net[1]>=0?'green':'red',net[1]>=0?'Margin '+net[2]:'Costs exceed income'],['Stock issued',value('Equipment & stock issued (at cost)'),'purple','At cost · not deducted from profit']]){const tile=el('div',undefined,'business-metric '+tone);tile.append(el('small',label),el('strong','Rs '+money(amount)),el('p',note,'business-note'));grid.append(tile);}
 const statement=el('details',undefined,'business-detail'),wrap=el('div',undefined,'business-table-wrap'),table=el('table'),thead=el('thead'),headRow=el('tr'),body=el('tbody');
 for(const h of data.headers)headRow.append(el('th',h));thead.append(headRow);
 for(const values of data.rows){const row=el('tr');values.forEach(v=>row.append(el('td',typeof v==='number'?money(v):v)));const kind=data.rowKinds?.get(values[0]);if(kind)row.className=kind.split(' ').map(k=>'statement-'+k).join(' ');body.append(row);}
 table.append(thead,body);wrap.append(table);statement.append(el('summary','Profit & loss statement for '+month),wrap);
 section.append(grid,statement,el('p','Profit = income − package (bandwidth) cost − paid expenses. Stock issued is shown separately and not deducted. Set each package’s monthly cost in Settings → Packages so profit is accurate.','business-note'));
 return section;
}
if(typeof module!=='undefined')module.exports={businessFigures};
function dashboardOverview(records,dateString){
 const month=dateString.slice(0,7),figures=businessFigures(records,dateString,month),customers=records.Customers??[];
 const tomorrow=days=>new Date(Date.parse(dateString+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
 const expiring=days=>customers.filter(c=>c.status==='Active'&&c.expiry_date>=dateString&&c.expiry_date<=tomorrow(days));
 const note=rows=>{let cost=0,fees=0;for(const c of rows){fees+=Number(c.monthly_fee||0);cost+=Number((records.Packages??[]).find(p=>p.id===c.package_id)?.monthly_cost||0);}return `Monthly package cost: Rs ${moneyForOverview(cost)} | Monthly fees: Rs ${moneyForOverview(fees)}`;};
 const monthBills=(records.Invoices??[]).filter(i=>i.billing_month===month&&i.issue_date<=dateString),dueByCustomer=new Map();
 for(const i of monthBills)dueByCustomer.set(i.customer_id,(dueByCustomer.get(i.customer_id)||0)+Number(i.amount));
 for(const p of (records.Payments??[]).filter(p=>p.revenue_type!=='OTC'&&p.billing_month===month&&p.payment_date<=dateString&&dueByCustomer.has(p.customer_id)))dueByCustomer.set(p.customer_id,dueByCustomer.get(p.customer_id)-Number(p.amount));
 const pending=[...dueByCustomer.values()].reduce((n,v)=>n+Math.max(0,v),0);
 const card=(id,label,value,note,section,color)=>({id,label,value,note,section,color});
 return [
 card('terminated-day','Terminations today',figures.daily.terminations,'Termination events recorded today','Equipment recovery','red'),
 card('terminated-month','Terminations this month',figures.monthly.terminations,'Termination events recorded this month','Equipment recovery','coral'),
 card('loss-day','MRC lost - terminated today',figures.daily.revenueLost,'Monthly fee run-rate at termination','Equipment recovery','red'),
 card('loss-month','MRC lost - terminated this month',figures.monthly.revenueLost,'Monthly fee run-rate at termination','Equipment recovery','orange'),
 card('recovery','Equipment recovery pending',(records['Equipment recovery']??[]).filter(r=>r.status==='Equipment recovery pending').length,'Accounts awaiting equipment return','Equipment recovery','amber'),
 card('clients','Total clients',customers.length,'All customer accounts','Customers','teal'),
 card('active','Active clients',customers.filter(c=>c.status==='Active').length,'Currently marked active','Customers','green'),
 card('new','New clients this month',customers.filter(c=>c.joined?.startsWith(month)).length,'By customer joining date','Customers','peach'),
 card('billed','MRC receivable this month',monthBills.reduce((n,i)=>n+Number(i.amount),0),'Saved subscription bills for '+month,'Customers','cyan'),
 card('collected','Collected this month',figures.monthly.collected,'MRC + OTC receipts by payment date','Payments','green'),
 card('pending','Pending this month',pending,'Unpaid current-month MRC bills','Customers','peach'),
 card('expires7','Expiring next 7 days',expiring(7).length,note(expiring(7)),'Customers','amber'),
 card('tickets','Open tickets',(records.Tickets??[]).filter(t=>!['Resolved','Closed'].includes(t.status)).length,'Installations, maintenance and customer issues','Tickets','orange'),
 card('today','Today collections',figures.daily.collected,'All payments received today','Payments','green'),
 card('balance','Total billed balance',figures.outstanding,'Outstanding saved MRC bills, all periods','Customers','teal'),
 card('expires3','Expiring next 3 days',expiring(3).length,note(expiring(3)),'Customers','coral'),
 card('expires0','Expiring today',expiring(0).length,note(expiring(0)),'Customers','red'),
 card('mrc','MRC collected this month',figures.monthly.mrc,'Monthly bill payments received','Payments','blue'),
 card('otc','OTC collected this month',figures.monthly.otc,'Routers, inventory and one-time charges','Payments','purple'),
 card('expired','Expired accounts',customers.filter(c=>c.expiry_date&&c.expiry_date<dateString).length,'Recorded expiry before today','Customers','red'),
 card('stock','Low-stock items',(records.Inventory??[]).filter(i=>Number(i.quantity)<=Number(i.minimum_stock)).length,'At or below minimum available quantity','Inventory','amber'),
 // Assets (Operations > Assets) are only present for users allowed to see them.
 ...(records.Assets?(()=>{const assets=records.Assets,inUse=assets.filter(a=>a.condition!=='Destroyed'),attention=assets.filter(a=>['Under repair','Damaged'].includes(a.condition));return [
  card('assets','Total assets',inUse.length,`${new Set(inUse.map(a=>a.location).filter(Boolean)).size} locations · ${assets.length-inUse.length} destroyed`,'Assets','teal'),
  card('assets-value','Asset value',assets.filter(a=>a.condition!=='Destroyed').reduce((n,a)=>n+Number(a.value||0),0),'Purchase value of assets in use','Assets','blue'),
  card('assets-attention','Assets needing attention',attention.length,`${attention.filter(a=>a.condition==='Under repair').length} under repair · ${attention.filter(a=>a.condition==='Damaged').length} damaged`,'Assets','amber'),
  card('assets-new','Assets added this month',assets.filter(a=>String(a.purchased_on||'').startsWith(month)).length,'By purchase date','Assets','peach')];})():[])
 ];
}
function moneyForOverview(value){return Number(value).toLocaleString('en-PK',{maximumFractionDigits:2});}
function dashboardCardPreferenceKey(){return 'ispcrm-dashboard-cards:'+(typeof state!=='undefined'?state?.user?.id??'local':'local');}
function hiddenDashboardCards(){try{const value=JSON.parse(localStorage.getItem(dashboardCardPreferenceKey())||'[]');return new Set(Array.isArray(value)?value:[]);}catch{return new Set();}}
function customizeDashboardCards(metrics){
 const dialog=el('dialog',undefined,'dashboard-customizer'),heading=el('div',undefined,'dialog-heading');heading.append(el('h2','Customize dashboard'));
 const close=el('button','Close','secondary');close.type='button';close.onclick=()=>dialog.close();heading.append(close);dialog.append(heading,el('p','Choose the overview cards shown on this browser.','business-note'));
 const hidden=hiddenDashboardCards(),list=el('div',undefined,'dashboard-card-options');const inputs=[];
 for(const metric of metrics){const label=el('label'),input=el('input');input.type='checkbox';input.checked=!hidden.has(metric.id);label.append(input,el('span',metric.label));list.append(label);inputs.push([metric.id,input]);}dialog.append(list);
 const actions=el('div',undefined,'form-actions'),reset=el('button','Show all','secondary'),save=el('button','Save layout');reset.type=save.type='button';reset.onclick=()=>{for(const [,input]of inputs)input.checked=true;};save.onclick=()=>{try{localStorage.setItem(dashboardCardPreferenceKey(),JSON.stringify(inputs.filter(([,input])=>!input.checked).map(([id])=>id)));}catch{const selected=new Set(inputs.filter(([,input])=>!input.checked).map(([id])=>id));for(const card of document.querySelectorAll('[data-dashboard-card]'))card.hidden=selected.has(card.dataset.dashboardCard);for(const group of document.querySelectorAll('.dashboard-category'))group.hidden=![...group.querySelectorAll('[data-dashboard-card]')].some(card=>!card.hidden);dialog.close();return;}dialog.close();dashboard();};actions.append(reset,save);dialog.append(actions);dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
}
if(typeof module!=='undefined')module.exports.dashboardOverview=dashboardOverview;

function dashboardGroups(metrics){const definitions=[
 ['Customers','Customer base and new connections',['clients','active','new']],
 ['Billing & balances','Bills raised and amounts still outstanding',['billed','pending','balance']],
 ['Collections','Money received today and this month',['today','collected','mrc','otc']],
 ['Expiry & renewals','Accounts approaching expiry or already expired',['expires0','expires3','expires7','expired']],
 ['Support & inventory','Open work, low stock and equipment recovery',['tickets','stock','recovery']],
 ['Assets','Company equipment and property',['assets','assets-value','assets-attention','assets-new']],
 ['Terminations & revenue loss','Daily and monthly termination impact',['terminated-day','terminated-month','loss-day','loss-month']]
];const assigned=new Set();const groups=definitions.map(([title,description,ids])=>({title,description,metrics:ids.map(id=>metrics.find(m=>m.id===id)).filter(Boolean)})).filter(g=>g.metrics.length);for(const group of groups)for(const metric of group.metrics)assigned.add(metric.id);const other=metrics.filter(m=>!assigned.has(m.id));if(other.length)groups.push({title:'Other metrics',description:'Additional business indicators',metrics:other});return groups;}
if(typeof module!=='undefined')module.exports.dashboardGroups=dashboardGroups;


function dashboardAnalysis(records,day,now=Date.now()){
 const month=day.slice(0,7),customers=records.Customers??[],bills=(records.Invoices??[]).filter(i=>i.billing_month===month),tickets=(records.Tickets??[]).filter(t=>!['Resolved','Closed'].includes(t.status));
 const sum=(rows,field)=>rows.reduce((n,r)=>n+Number(r[field]??0),0);
 const billed=bills.reduce((n,i)=>n+Number(i.amount)+Number(i.service_amount??0),0),allocated=bills.reduce((n,i)=>n+Math.min(Number(i.paid??0),Number(i.amount)+Number(i.service_amount??0)),0);
 const owing=customers.filter(c=>Number(c.account_balance)>0).sort((a,b)=>Number(b.account_balance)-Number(a.account_balance));
 const expired=customers.filter(c=>c.status!=='Terminated'&&c.expiry_date&&c.expiry_date<day);
 const renewal=customers.filter(c=>c.status!=='Terminated'&&c.expiry_date>=day&&c.expiry_date<=new Date(Date.parse(day+'T00:00:00Z')+7*86400000).toISOString().slice(0,10));
 const overdue=tickets.filter(t=>Number.isFinite(Date.parse(t.due_at))?Date.parse(t.due_at)<now:t.due_date<day);
 return {billed,allocated,pending:Math.max(0,billed-allocated),collectionRate:billed?100*allocated/billed:null,owing,owed:sum(owing,'account_balance'),expired,renewal,renewalMrc:sum(renewal,'monthly_fee'),overdue,unassigned:tickets.filter(t=>!t.assigned_to),active:customers.filter(c=>c.status==='Active').length,total:customers.length};
}
function buildDashboardAnalysis(records,day){
 const data=dashboardAnalysis(records,day),root=el('section',undefined,'dashboard-analysis');root.setAttribute('aria-label','Business analysis');
 const heading=el('div',undefined,'analysis-heading');heading.append(el('h2','Business health & priorities'),el('p','Current month billing, account balances and work requiring attention.'));root.append(heading);
 const grid=el('div',undefined,'analysis-grid');
 const facts=[['Current-month bill recovery',data.collectionRate===null?'No bills yet':data.collectionRate.toFixed(1)+'%',`Rs ${money(data.allocated)} allocated against Rs ${money(data.billed)} in MRC and stock/service charges. Excludes brought-forward dues.`,'blue'],['Current-month charges unpaid','Rs '+money(data.pending),'Charges raised for this month less payments allocated to these invoices.','amber'],['Total customer dues','Rs '+money(data.owed),`${data.owing.length} accounts with a debit ledger balance, including stock/services and installation. Credits are not offset against other customers.`,'purple'],['Renewals due in 7 days',String(data.renewal.length),'Rs '+money(data.renewalMrc)+' monthly fees associated with accounts expiring today through the next 7 days.','green']];
 const icons={blue:'M5 12l4 4L19 6 M4 4h5 M4 4v5 M20 20h-5 M20 20v-5',amber:'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',purple:'M3 6h18v14H3z M3 6V3h14 M16 11h5v5h-5z',green:'M5 5h14v16H5z M8 3v4 M16 3v4 M5 10h14 M9 15l2 2 4-4'};
 for(const [label,value,note,tone]of facts){
  const card=el('article',undefined,'analysis-card '+tone),circle=el('div',undefined,'analysis-circle'),ring=svgElement('svg',{viewBox:'0 0 200 200',class:'analysis-ring','aria-hidden':'true'});
  ring.append(svgElement('circle',{cx:100,cy:100,r:93,class:'analysis-ring-track'}));const progress=tone==='blue'?Math.max(0,Math.min(100,data.collectionRate??0)):100;
  ring.append(svgElement('circle',{cx:100,cy:100,r:93,class:'analysis-ring-value',pathLength:100,'stroke-dasharray':`${progress} 100`,transform:'rotate(-90 100 100)'}));
  const content=el('div',undefined,'analysis-circle-content'),badge=el('span',undefined,'analysis-icon'),icon=svgElement('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.8,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'});icon.append(svgElement('path',{d:icons[tone]}));badge.append(icon);content.append(badge,el('strong',value));circle.append(ring,content);
  if(tone==='blue'&&data.collectionRate!==null){circle.setAttribute('role','meter');circle.setAttribute('aria-label','Current-month bill recovery');circle.setAttribute('aria-valuemin','0');circle.setAttribute('aria-valuemax','100');circle.setAttribute('aria-valuenow',String(data.collectionRate));}
  card.append(circle,el('h3',label),el('p',note));grid.append(card);
 }root.append(grid);
 const panels=el('div',undefined,'analysis-panels'),priority=el('article',undefined,'analysis-panel');priority.append(el('h3','Action priorities'));
 for(const [label,value,section]of [['Overdue tickets',data.overdue.length,'Tickets'],['Unassigned tickets',data.unassigned.length,'Tickets'],['Expired accounts (excluding terminated)',data.expired.length,'Customers'],['Equipment recoveries pending',(records['Equipment recovery']??[]).filter(r=>r.status==='Equipment recovery pending').length,'Equipment recovery'],['Items at or below minimum stock',(records.Inventory??[]).filter(i=>Number(i.quantity)<=Number(i.minimum_stock)).length,'Inventory']]){const button=el('button',undefined,'analysis-action secondary');const icon=el('span',undefined,'priority-icon');icon.append(dashboardMetricIcon(label));button.append(icon,el('span',label),el('strong',String(value)));button.onclick=()=>navigate(section);priority.append(button);}
 const dues=el('article',undefined,'analysis-panel');dues.append(el('h3','Largest outstanding customer balances'));if(!data.owing.length)dues.append(el('p','No customer debit balances recorded.'));
 for(const customer of data.owing.slice(0,5)){const row=el('div',undefined,'analysis-debtor');row.append(el('span',customer.name),el('strong','Rs '+money(customer.account_balance)));dues.append(row);}
 dues.append(el('p',`${data.active} of ${data.total} accounts marked active. Expiry is evaluated separately; an active status can still have an expired date.`,'business-note'));panels.append(priority,dues);root.append(panels);return root;
}
if(typeof module!=='undefined')module.exports.dashboardAnalysis=dashboardAnalysis;

function dashboardMetricIcon(label){
 const text=label.toLowerCase();let path;
 if(/ticket|jobs/.test(text))path=/overdue/.test(text)?'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0':'M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4z M9 5v14';
 else if(/stock|equipment|recover/.test(text))path='M3 7l9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10';
 else if(/expir|renew/.test(text))path='M5 5h14v16H5z M8 3v4 M16 3v4 M5 10h14 M9 15h6 M12 12v6';
 else if(/terminat/.test(text))path='M12 3v9 M6 5a9 9 0 1 0 12 0';
 else if(/collect|receip|cash/.test(text))path='M3 5h18v14H3z M3 9h18 M7 15h3 M16 13l2 2 3-3';
 else if(/bill|mrc|otc|fee|charge|balance|dues|sale|expense|revenue|pending/.test(text))path='M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6 M9 16h3';
 else if(/new/.test(text))path='M15 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M19 7v6 M16 10h6';
 else path='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M17 5a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87';
 const icon=svgElement('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.8,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'});icon.append(svgElement('path',{d:path}));return icon;
}

function dailyGraphData(records,month){
 const dateOf=value=>{if(!value)return '';const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(date):'';};
 const [year,m]=month.split('-').map(Number),days=new Date(Date.UTC(year,m,0)).getUTCDate(),figures=businessFigures(records,month+'-01',month);
 const expiry=new Map();for(const c of records.Customers??[])if(c.expiry_date)expiry.set(c.id+'|'+c.expiry_date,c.expiry_date);for(const r of records.Recharges??[])if(r.previous_expiry)expiry.set(r.customer_id+'|'+r.previous_expiry,r.previous_expiry);
 return Array.from({length:days},(_,i)=>{const date=month+'-'+String(i+1).padStart(2,'0'),base=figures.breakdown[i];return {date,sales:base.sales,activated:new Set((records.Recharges??[]).filter(r=>dateOf(r.activated_at)===date).map(r=>r.customer_id)).size,collection:base.collected,recovered:(records['Stock issues']??[]).filter(s=>s.status==='Returned'&&s.issued_against==='Customer'&&s.recovery_required==='Yes'&&dateOf(s.returned_at)===date).reduce((n,s)=>n+Number(s.quantity),0),terminations:base.terminations,expiry:[...expiry.values()].filter(d=>d===date).length,reactivations:(records.Recharges??[]).filter(r=>dateOf(r.activated_at)===date&&r.previous_expiry&&r.previous_expiry<date).length};});
}
function buildDailyGraphs(records,month){
 const root=el('section',undefined,'daily-graphs');root.setAttribute('aria-label','Day-wise activity graphs');root.append(el('h3','Day-wise activity · '+month));const rows=dailyGraphData(records,month),grid=el('div',undefined,'daily-graph-grid');
 const definitions=[['activated','Daily activated connections','Distinct customer connections activated through successful recharges each day, including renewals and reactivations.','#2563b5',false],['collection','Daily collection','All confirmed receipts by payment date.','#087f65',true],['recovered','Daily devices recovered','Quantity of customer equipment physically returned, marked recovery required.','#7550b6',false],['terminations','Daily terminations','Recorded customer termination events.','#bd3156',false],['expiry','Daily expiries','Recorded expiry dates, including previous expiry snapshots from recharges. Not an historical status count.','#9d620a',false],['reactivations','Daily expired-account activations','Successful recharges where previous expiry was before activation day. Excludes early renewals.','#087e99',false]];
 for(const [key,title,note,color,currency]of definitions){const panel=el('article',undefined,'daily-graph-panel'),total=rows.reduce((n,r)=>n+r[key],0);panel.append(el('h4',title),el('strong',(currency?'Rs ':'')+money(total)),el('p',note));
 const svg=svgElement('svg',{viewBox:'0 0 620 220',role:'img','aria-label':title+' for '+month,class:'daily-bar-chart'}),max=currency?Math.max(1,...rows.map(r=>r[key])):Math.max(4,Math.ceil(Math.max(0,...rows.map(r=>r[key]))/4)*4),step=540/rows.length;
 for(let i=0;i<=4;i++){const y=175-i*37;svg.append(svgElement('line',{x1:60,y1:y,x2:605,y2:y,class:'daily-chart-grid'}));const label=svgElement('text',{x:52,y:y+4,'text-anchor':'end',class:'daily-axis'});label.textContent=money(currency?max*i/4:Math.ceil(max*i/4));svg.append(label);}
 for(const [i,row]of rows.entries()){const height=row[key]/max*148,x=62+i*step,bar=svgElement('rect',{x,y:175-height,width:Math.max(2,step-4),height:Math.max(row[key]>0?2:0,height),rx:2,fill:color,tabindex:0,'aria-label':row.date+': '+(currency?'Rs ':'')+money(row[key])}),tip=svgElement('title');tip.textContent=row.date+': '+(currency?'Rs ':'')+money(row[key]);bar.append(tip);svg.append(bar);if(i===0||(i+1)%5===0||i===rows.length-1){const tick=svgElement('text',{x:x+(step-4)/2,y:197,'text-anchor':'middle',class:'daily-axis'});tick.textContent=String(i+1);svg.append(tick);}}
 panel.append(svg);if(!total)panel.append(el('p','No recorded activity for this month.','business-note'));const details=el('details'),summary=el('summary','View daily values');details.append(summary);const table=el('table'),head=el('tr');head.append(el('th','Date'),el('th',currency?'Amount (PKR)':'Count'));table.append(head);for(const row of rows){const tr=el('tr');tr.append(el('td',row.date),el('td',money(row[key])));table.append(tr);}details.append(table);panel.append(details);grid.append(panel);
 }root.append(grid,el('p','Month selection above controls all six graphs. Dates use Pakistan time. Expiry history is limited to dates retained in customer and recharge records.','business-note'));return root;
}
if(typeof module!=='undefined')module.exports.dailyGraphData=dailyGraphData;
