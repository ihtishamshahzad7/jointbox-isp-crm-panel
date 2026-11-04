'use strict';
const reportNames=['Business Health (Net Profit)','Profit & Loss Statement','Inventory Reconciliation','Monthwise Collection','Collection Reports','Promise Date Report','Expiry Report','Staff Collection','Collection Report 1','Accounts Report','Daily Sales Report','Transaction Wise Report','Recharge Report','Package Wise Report'];
function availableReportNames(){return reportNames.filter(name=>name==='Inventory Reconciliation'?can('read','Inventory'):['Business Health (Net Profit)','Profit & Loss Statement'].includes(name)?can('read','Payments')&&can('read','Expenses'):can('read','Payments'));}
let reportMenuOpen=false;
let reportChoice=reportNames[0],reportFrom='',reportTo='',reportQuery='';
// Cost of one monthly bill. Transworld Panel (and any other provider) uses the package's Monthly cost.
// Bandwidth providers share that month's peak by package speed:
// peak Mbps × (package speed ÷ total speed billed on that provider that month) × price per Mbps.
// A month with no peak entered falls back to the package's Monthly cost.
const BANDWIDTH_PROVIDERS=['Transworld Bandwidth','Nayatel bandwidth'];
function billCostModel(records){
 const packages=records.Packages??[],customers=records.Customers??[],peaks=records['Bandwidth peaks']??[];
 const pkg=i=>packages.find(p=>p.name===i.package_name)??packages.find(p=>p.id===customers.find(c=>c.id===i.customer_id)?.package_id);
 const shared=p=>p&&BANDWIDTH_PROVIDERS.includes(p.service_provider),sold=new Map();
 for(const i of records.Invoices??[]){const p=pkg(i);if(shared(p)){const k=i.billing_month+'|'+p.service_provider;sold.set(k,(sold.get(k)||0)+Number(p.speed_mbps||0));}}
 const peakFor=(month,provider)=>peaks.find(r=>r.month===month&&r.provider===provider);
 const cost=i=>{const p=pkg(i);if(!p)return 0;const peak=shared(p)&&peakFor(i.billing_month,p.service_provider),total=Number(peak?.sold_mbps)||sold.get(i.billing_month+'|'+p.service_provider);
  return peak&&total?Number(peak.peak_mbps)*Number(p.speed_mbps||0)/total*Number(peak.price_per_mbps):Number(p.monthly_cost||0);};
 // Months with bills on a bandwidth provider but no peak entered yet.
 cost.missing=months=>[...new Set([...sold.keys()].filter(k=>months.has(k.split('|')[0])&&!peakFor(...k.split('|'))))].map(k=>k.replace('|',' · '));
 return cost;
}
function reportData(records,name,from,to,query=''){
 const customers=records.Customers??[],payments=records.Payments??[],invoices=records.Invoices??[];
 const inRange=date=>Boolean(date)&&(!from||date>=from)&&(!to||date<=to);
 const customer=id=>customers.find(c=>c.id===id)??{};
 const sum=rows=>rows.reduce((n,r)=>n+Number(r.amount||0),0);
 const info=id=>{const c=customer(id);return [c.payment_id??id,c.name??'Unavailable'];};
 const receipts=payments.filter(p=>inRange(p.payment_date));let headers,rows,summary=null,rowKinds=null,note='Amounts in PKR. Collection dates are payment dates; monthly bills and OTC are separate.';
 const grouped=(items,key)=>{const groups=new Map();for(const item of items){const k=key(item);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(item);}return [...groups].sort((a,b)=>String(a[0]).localeCompare(String(b[0])));};
 if(name==='Business Health (Net Profit)'){
  // Cash basis: revenue is money collected; costs are package costs of bills raised and paid expenses. Stock issued is shown but not deducted.
  const packages=records.Packages??[],month=d=>String(d).slice(0,7),monthsInRange=[];
  for(let m=month(from||today());m<=month(to||today());m=new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),1)).toISOString().slice(0,7))monthsInRange.push(m);
  const packageCost=billCostModel(records),missingPeaks=packageCost.missing(new Set(monthsInRange));
  const bills=invoices.filter(i=>monthsInRange.includes(i.billing_month)),expenses=(records.Expenses??[]).filter(e=>e.status==='Paid'&&inRange(e.payment_date||e.expense_date)),issues=(records['Stock issues']??[]).filter(s=>s.status!=='Returned'&&inRange(s.issue_date));
  const line=m=>{const revenue=sum(receipts.filter(p=>month(p.payment_date)===m)),pkg=bills.filter(i=>i.billing_month===m).reduce((n,i)=>n+packageCost(i),0),spent=sum(expenses.filter(e=>month(e.payment_date||e.expense_date)===m)),stock=issues.filter(s=>month(s.issue_date)===m).reduce((n,s)=>n+Number(s.quantity)*Number(s.unit_cost_at_issue||0),0),costs=pkg+spent;return [revenue,pkg,spent,costs,revenue-costs,stock];};
  const margin=(revenue,profit)=>revenue?(profit/revenue*100).toFixed(1)+'%':'—';
  const lines=monthsInRange.map(m=>[m,...line(m)]),totals=lines.reduce((t,r)=>t.map((v,i)=>v+r[i+1]),[0,0,0,0,0,0]);
  headers=['Month','Revenue collected','Package cost','Business expenses','Total costs','Net profit','Profit margin','Stock issued (not in profit)'];
  rows=[...lines.map(r=>[r[0],r[1],r[2],r[3],r[4],r[5],margin(r[1],r[5]),r[6]]),['Total',totals[0],totals[1],totals[2],totals[3],totals[4],margin(totals[0],totals[4]),totals[5]]];
  summary=[['Total revenue',totals[0],'Money collected (MRC + OTC)'],['Package cost',totals[1],'Upstream cost of bills raised'],['Business expenses',totals[2],'Paid expenses'],['Net profit',totals[4],totals[4]>=0?'Revenue minus package cost and expenses':'Loss: costs exceed revenue',totals[4]>=0?'good':'bad'],['Profit margin',margin(totals[0],totals[4]),'Net profit ÷ revenue'],['Stock issued',totals[5],'At cost · not deducted from profit']];
  note='Cash basis for the selected dates. Revenue = payments collected (monthly bills and one-time charges). Package cost = for Transworld Panel, each bill raised × the monthly cost set on its package; for Transworld Bandwidth and Nayatel bandwidth, that month\'s peak Mbps × price per Mbps (Operations → Bandwidth → Bandwidth peaks), shared between bills by package speed. Business expenses = Paid expenses only; pending and cancelled are excluded. Net profit = revenue − package cost − business expenses. Stock issued (inventory at cost, returned stock excluded) is shown separately and is not deducted. If you also record upstream bandwidth bills as expenses, set package costs to 0 to avoid counting that cost twice.'+(missingPeaks.length?' No peak entered yet for '+missingPeaks.join(', ')+'; those bills use the package monthly cost.':'');
 }else if(name==='Profit & Loss Statement'){
  // Same cash basis as Business Health, laid out as a statement: income, cost of service, gross profit, operating expenses, net.
  const packages=records.Packages??[],months=new Set(),month=d=>String(d).slice(0,7);
  for(let m=month(from||today());m<=month(to||today());m=new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),1)).toISOString().slice(0,7))months.add(m);
  const packageCost=billCostModel(records);
  const otc=type=>sum(receipts.filter(p=>p.revenue_type==='OTC'&&(p.otc_type||'Other')===type));
  const income=[['Monthly subscriptions (MRC)',sum(receipts.filter(p=>p.revenue_type!=='OTC'))],['Installation charges',otc('Installation')],['Equipment sales',otc('Equipment')],['Service charges',otc('Service')],['Other income',otc('Other')]];
  // Stock issued is reported separately and is not deducted from profit.
  const costs=[['Package / bandwidth cost',invoices.filter(i=>months.has(i.billing_month)).reduce((n,i)=>n+packageCost(i),0)]];
  const stockIssued=(records['Stock issues']??[]).filter(s=>s.status!=='Returned'&&inRange(s.issue_date)).reduce((n,s)=>n+Number(s.quantity)*Number(s.unit_cost_at_issue||0),0);
  const spent=new Map();for(const e of (records.Expenses??[]).filter(e=>e.status==='Paid'&&inRange(e.payment_date||e.expense_date)))spent.set(e.category||'Other',(spent.get(e.category||'Other')||0)+Number(e.amount||0));
  const expenses=[...spent].sort((a,b)=>b[1]-a[1]);
  const total=list=>list.reduce((n,[,v])=>n+v,0),totalIncome=total(income),totalCost=total(costs),gross=totalIncome-totalCost,totalExpenses=total(expenses),net=gross-totalExpenses;
  const share=v=>totalIncome?(v/totalIncome*100).toFixed(1)+'%':'—',line=(label,value,kind='')=>[label,value,share(value),kind],heading=label=>[label,'','','heading'];
  const statement=[heading('Income'),...income.map(([l,v])=>line(l,v)),line('Total income',totalIncome,'total'),
   heading('Cost of service'),...costs.map(([l,v])=>line(l,v)),line('Total cost of service',totalCost,'total'),
   line(gross>=0?'Gross profit':'Gross loss',gross,'result'),
   heading('Operating expenses'),...(expenses.length?expenses.map(([l,v])=>line(l,v)):[line('No paid expenses in this period',0)]),line('Total operating expenses',totalExpenses,'total'),
   line(net>=0?'Net profit':'Net loss',net,net>=0?'result good':'result bad'),
   heading('Stock issued (separate, not in profit)'),line('Equipment & stock issued (at cost)',stockIssued)];
  headers=['Line','Amount (PKR)','% of income'];rows=statement.map(r=>r.slice(0,3));rowKinds=new Map(statement.map(r=>[r[0],r[3]]));
  summary=[['Total income',totalIncome,'Money collected'],['Cost of service',totalCost,'Package / bandwidth cost'],['Gross profit',gross,'Margin '+share(gross),gross>=0?'good':'bad'],['Operating expenses',totalExpenses,'Paid business expenses'],['Net profit',net,net>=0?'Margin '+share(net):'Loss for this period',net>=0?'good':'bad'],['Stock issued',stockIssued,'At cost · not deducted from profit']];
  note='Cash basis for the selected dates: income is payments collected by payment date and type; cost of service is the monthly cost set on each package for bills raised in these months; operating expenses are Paid expenses by category. Stock issued (at cost, returned stock excluded) is shown separately and is not deducted from profit. Set package costs in Settings → Packages for an accurate gross profit.';
 }else if(name==='Inventory Reconciliation'){headers=['Item','Store quantity','QR in store','QR issued','Damaged / repair in store','Unlabelled stock','Stock value'];rows=(records.Inventory??[]).map(i=>{const units=(records['Inventory units']??[]).filter(u=>u.inventory_id===i.id),stored=units.filter(u=>u.state==='Available');return [i.item,Number(i.quantity),stored.length,units.filter(u=>u.state==='Issued').length,stored.filter(u=>u.condition!=='Good').length,Number(i.quantity)-stored.length,Number(i.quantity)*Number(i.unit_cost)];});note='Current physical stock, including damaged/repair devices. QR devices cannot be issued while damaged or under repair. Unlabelled stock can include bulk consumables; negative values require investigation. Dates do not apply.';}else if(['Monthwise Collection','Collection Reports','Staff Collection','Collection Report 1'].includes(name)){
  const label=name==='Monthwise Collection'?'Payment month':name==='Staff Collection'?'Recorded by':name==='Collection Report 1'?'Payment method':'Payment date';
  const group=p=>name==='Monthwise Collection'?p.payment_date.slice(0,7):name==='Staff Collection'?(p.recorded_by||'Unknown'):name==='Collection Report 1'?p.method:p.payment_date;
  headers=[label,'Receipts','MRC collected','OTC collected','Total collected'];rows=grouped(receipts,group).map(([k,v])=>[k,v.length,sum(v.filter(p=>p.revenue_type!=='OTC')),sum(v.filter(p=>p.revenue_type==='OTC')),sum(v)]);
  if(name==='Staff Collection')note+=' Staff means the person who recorded the receipt; gateway and historical receipts retain their recorded source.';
 }else if(['Promise Date Report','Expiry Report'].includes(name)){
  const field=name==='Expiry Report'?'expiry_date':'promise_date';headers=['Customer ID','Customer','Username','Status',name==='Expiry Report'?'Expiry date':'Promise date','Monthly fee','Phone'];rows=customers.filter(c=>inRange(c[field])).sort((a,b)=>a[field].localeCompare(b[field])).map(c=>[...info(c.id),c.username,c.status,c[field],Number(c.monthly_fee),c.phone]);
  note=name==='Promise Date Report'?'Payment follow-up dates saved in the customer Promise date field. Edit the customer to record or clear a promise.':'Customers whose expiry falls in the selected range, including inactive accounts.';
 }else if(name==='Accounts Report'){
  headers=['Customer ID','Customer','MRC billed','MRC received against bills','MRC outstanding','Installation charge','Installation received','Installation outstanding'];
  rows=customers.map(c=>{const bills=invoices.filter(i=>i.customer_id===c.id&&(!to||i.issue_date<=to)),months=new Set(bills.map(i=>i.billing_month)),paid=payments.filter(p=>p.customer_id===c.id&&(!to||p.payment_date<=to)),mrc=sum(paid.filter(p=>p.revenue_type!=='OTC'&&months.has(p.billing_month))),installation=sum(paid.filter(p=>p.revenue_type==='OTC'&&p.otc_type==='Installation'));return [...info(c.id),sum(bills),mrc,Math.max(0,sum(bills)-mrc),Number(c.installation_charge||0),installation,Math.max(0,Number(c.installation_charge||0)-installation)];});
  note='As of the end date (start date is ignored). MRC balance uses saved bills and receipts matched by billing month, excluding unbilled months. Installation charges use the current agreed customer charge.';
 }else if(name==='Daily Sales Report'){
  headers=['Date','MRC bills raised','OTC sales paid','Total sales'];const bills=invoices.filter(i=>inRange(i.issue_date)),otc=receipts.filter(p=>p.revenue_type==='OTC');rows=[...new Set([...bills.map(i=>i.issue_date),...otc.map(p=>p.payment_date)])].sort().map(d=>{const m=sum(bills.filter(i=>i.issue_date===d)),o=sum(otc.filter(p=>p.payment_date===d));return [d,m,o,m+o];});note='Sales = new monthly subscription invoice charges plus paid OTC. Carried debt is not counted again; unpaid installation charges are excluded.';
 }else if(name==='Recharge Report'){
  headers=['Customer ID','Customer','Activated (PKT)','Billing month','Activation type'];rows=(records.Recharges??[]).filter(r=>inRange(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.activated_at)))).map(r=>[...info(r.customer_id),new Date(r.activated_at).toLocaleString('en-PK',{timeZone:'Asia/Karachi'}),r.billing_month??'-',r.partial_activation?'Partial approved':'Full payment']);note='CRM activations from confirmed payments, by activation date in Pakistan time.';
 }else if(name==='Package Wise Report'){
  headers=['Current package','Customers','Active','Monthly fee run-rate','MRC collected','OTC collected'];rows=grouped(customers,c=>c.package||'Unassigned').map(([k,v])=>{const ids=new Set(v.map(c=>c.id)),paid=receipts.filter(p=>ids.has(p.customer_id));return [k,v.length,v.filter(c=>c.status==='Active').length,v.filter(c=>c.status==='Active').reduce((n,c)=>n+Number(c.monthly_fee),0),sum(paid.filter(p=>p.revenue_type!=='OTC')),sum(paid.filter(p=>p.revenue_type==='OTC'))];});note='Groups by the current customer package, not the historical package at payment time. Collections use the selected dates; active monthly fees are current run-rate.';
 }else{
  headers=['Receipt','Customer ID','Customer','Date','Billing month','Revenue','Charge type','Method','Reference','Recorded by','Amount'];rows=receipts.map(p=>['RCP-'+p.id,...info(p.customer_id),p.payment_date,p.billing_month,p.revenue_type||'MRC',p.revenue_type==='OTC'?(p.otc_type||'Other'):'Monthly bill',p.method,p.reference||'',p.recorded_by||'Unknown',Number(p.amount)]);
 }
 const term=query.trim().toLowerCase();return {headers,rows:rows.filter(r=>r.some(v=>String(v??'').toLowerCase().includes(term))),note,summary,rowKinds};
}
function toggleReportsMenu(button){reportMenuOpen=!reportMenuOpen;const submenu=$('report-submenu');if(submenu)submenu.hidden=!reportMenuOpen;button.setAttribute('aria-expanded',String(reportMenuOpen));}
function appendReportNavigation(){const group=el('div',undefined,'report-nav');group.id='report-submenu';group.hidden=!reportMenuOpen;for(const name of availableReportNames()){const button=el('button',name,name===reportChoice?'selected':'');button.onclick=()=>{reportChoice=name;navigate('Reports');};group.append(button);}$('navigation').querySelector('.nav-reports').after(group);}
function renderReports(){
 const root=$('reports');root.replaceChildren();if(!can('read','Payments')&&!can('read','Inventory')){root.append(el('p','You do not have access to financial reports.'));return;}
 if(!availableReportNames().includes(reportChoice))reportChoice=availableReportNames()[0];
 if(!reportFrom)reportFrom=today().slice(0,7)+'-01';if(!reportTo)reportTo=today();
 const controls=el('div',undefined,'report-controls');const select=el('select');select.setAttribute('aria-label','Report');for(const name of availableReportNames()){const option=el('option',name);option.value=name;select.append(option);}select.value=reportChoice;select.onchange=()=>{reportChoice=select.value;render();};controls.append(select);
 for(const [label,value,change]of [['From',reportFrom,v=>reportFrom=v],['To',reportTo,v=>reportTo=v]]){const wrap=el('label',label),input=el('input');input.type='date';input.value=value;input.onchange=()=>{change(input.value);renderReports();};wrap.append(input);controls.append(wrap);}
 const search=el('input');search.type='search';search.placeholder='Search this report';search.value=reportQuery;search.setAttribute('aria-label','Search report');controls.append(search);root.append(controls);
 const output=el('div',undefined,'report-output');root.append(output);
 const draw=()=>{output.replaceChildren();if(reportFrom>reportTo){output.append(el('p','Choose an end date on or after the start date.'));return;}const data=reportData(state.records,reportChoice,reportFrom,reportTo,reportQuery);output.append(el('h2',reportChoice),el('p',`${reportFrom} to ${reportTo} | ${data.rows.length} rows`));if(data.summary){const cards=el('div',undefined,'report-summary');for(const [label,value,hint,tone]of data.summary){const card=el('article',undefined,'report-summary-card'+(tone?' '+tone:''));card.append(el('small',label),el('strong',typeof value==='number'?'Rs '+money(value):value),el('span',hint));cards.append(card);}output.append(cards);}output.append(el('p',data.note,'expense-note'));const actions=el('div',undefined,'report-actions'),csv=el('button','Export CSV','secondary'),print=el('button','Print','secondary');csv.onclick=()=>{const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';const blob=new Blob(['\uFEFF'+[data.headers,...data.rows].map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=reportChoice.replaceAll(' ','-')+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};print.onclick=()=>window.print();actions.append(csv,print);output.append(actions);const wrap=el('div',undefined,'table-wrap'),table=el('table'),head=el('thead'),tr=el('tr');data.headers.forEach(h=>tr.append(el('th',h)));head.append(tr);table.append(head);const body=el('tbody');for(const values of data.rows){const row=el('tr');values.forEach(value=>row.append(el('td',typeof value==='number'?money(value):value)));const kind=data.rowKinds?.get(values[0]);if(kind)row.className=kind.split(' ').map(k=>'statement-'+k).join(' ');body.append(row);}table.append(body);wrap.append(table);output.append(wrap);if(!data.rows.length)output.append(el('p','No records match these filters.'));};search.oninput=()=>{reportQuery=search.value;draw();};draw();
}
if(typeof module!=='undefined')module.exports={reportData,reportNames,billCostModel,BANDWIDTH_PROVIDERS};
