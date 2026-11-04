'use strict';
let collectionPeriod = 'month';
function expenseTotals(expenses,month){
 const rows=expenses??[];
 return {recorded:rows.filter(e=>e.status!=='Cancelled'&&e.expense_date.startsWith(month)).reduce((n,e)=>n+Number(e.amount),0),
  paid:rows.filter(e=>e.status==='Paid'&&e.payment_date?.startsWith(month)).reduce((n,e)=>n+Number(e.amount),0),
  pending:rows.filter(e=>e.status==='Pending').reduce((n,e)=>n+Number(e.amount),0)};
}
const chartColors = ['#159c88','#eab45c','#de7c88','#6389cf','#9d86cb'];
function dashboardIcon(index){
 const paths=['M3 9a14 14 0 0 1 18 0 M6 12a9 9 0 0 1 12 0 M9 15a5 5 0 0 1 6 0 M12 19h.01','M4 17l6-6 4 3 6-9 M14 5h6v6','M3 5h18v14H3z M7 9h.01 M17 15h.01 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0','M9 5H5v16h14V5h-4 M9 3h6v5H9z M8 12h8 M8 16h5','M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M18 8l2 2 3-4','M3 7l9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10'];
 const icon=svgElement('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.7,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'});icon.append(svgElement('path',{d:paths[index%paths.length]}));return icon;
}

function dashboardData(records, dateString, period='month') {
 const active=records.Customers.filter(c=>c.status==='Active');
 const month=dateString.slice(0,7), year=Number(dateString.slice(0,4)), monthIndex=Number(dateString.slice(5,7))-1;
 const buckets=period==='month'
  ? Array.from({length:new Date(year,monthIndex+1,0).getDate()},(_,i)=>({key:`${month}-${String(i+1).padStart(2,'0')}`,label:String(i+1),value:0}))
  : Array.from({length:6},(_,i)=>{const d=new Date(year,monthIndex-5+i,1);return {key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`,label:d.toLocaleDateString('en',{month:'short',year:'2-digit'}),value:0};});
 const bucketMap=new Map(buckets.map(b=>[b.key,b]));
 for(const p of records.Payments){const bucket=bucketMap.get(period==='month'?p.payment_date:p.payment_date.slice(0,7));if(bucket)bucket.value+=Number(p.amount);}
 const groups=new Map();
 for(const c of active){const id=c.package_id?`id:${c.package_id}`:`name:${c.package}`;if(!groups.has(id))groups.set(id,{name:c.package,value:0,count:0});const group=groups.get(id);group.value+=Number(c.monthly_fee);group.count++;}
 return {active,expected:active.reduce((n,c)=>n+Number(c.monthly_fee),0),
  mrc:records.Payments.filter(p=>p.payment_date.startsWith(month)&&p.revenue_type!=='OTC').reduce((n,p)=>n+Number(p.amount),0),
  otc:records.Payments.filter(p=>p.payment_date.startsWith(month)&&p.revenue_type==='OTC').reduce((n,p)=>n+Number(p.amount),0),
  collected:records.Payments.filter(p=>p.payment_date.startsWith(month)).reduce((n,p)=>n+Number(p.amount),0),
  statuses:['Active','Suspended','Disconnected','Terminated'].map(name=>({name,value:records.Customers.filter(c=>c.status===name).length})),
  openTickets:(records.Tickets??[]).filter(t=>!['Resolved','Closed'].includes(t.status)).sort((a,b)=>a.due_date.localeCompare(b.due_date)||a.id-b.id),
  openJobs:records.Jobs.filter(j=>j.status!=='Completed').sort((a,b)=>a.due_date.localeCompare(b.due_date)||a.id-b.id),
  lowStock:records.Inventory.filter(i=>i.quantity<=i.minimum_stock).sort((a,b)=>(a.quantity-a.minimum_stock)-(b.quantity-b.minimum_stock)),
  available:records.Staff.filter(s=>s.status==='Available').length,
  packages:[...groups.values()].sort((a,b)=>b.value-a.value),buckets};
}

function svgElement(tag,attrs={},text){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;}
function chartPanel(title,note){const panel=el('article',undefined,'dash-panel');const head=el('div',undefined,'chart-heading');const copy=el('div');copy.append(el('h2',title),el('p',note));head.append(copy);panel.append(head);return {panel,head};}
function emptyChart(text){return el('p',text,'chart-empty');}
function chartSummary(entries){const details=el('details',undefined,'chart-details');details.append(el('summary','View chart data'));const table=el('table');const head=el('tr');head.append(el('th','Period / category'),el('th','Value'));const thead=el('thead');thead.append(head);table.append(thead);const tbody=el('tbody');for(const entry of entries){const row=el('tr');row.append(el('td',entry.label??entry.name),el('td',money(entry.value)));tbody.append(row);}table.append(tbody);details.append(table);return details;}

function collectionsChart(data){
 const {panel,head}=chartPanel('Collections over time','Actual receipts by payment date · PKR');
 panel.classList.add('collections-panel');
 const periods=el('div',undefined,'collections-periods');periods.setAttribute('role','group');periods.setAttribute('aria-label','Collections chart period');for(const [value,label]of [['month','This month'],['six','6 months']]){const button=el('button',label,'secondary');button.type='button';button.setAttribute('aria-pressed',String(collectionPeriod===value));button.onclick=()=>{collectionPeriod=value;dashboard();};periods.append(button);}head.append(periods);
 const total=data.buckets.reduce((n,b)=>n+b.value,0),peak=data.buckets.reduce((best,b)=>b.value>best.value?b:best,{value:0,label:'?'}),stats=el('div',undefined,'collections-stats');
 for(const [label,value,note]of [['Total collected',`Rs ${money(total)}`,'Confirmed payment receipts'],[collectionPeriod==='month'?'Highest collection day':'Highest collection month',`Rs ${money(peak.value)}`,peak.value?peak.key:'No receipts yet'],[collectionPeriod==='month'?'Days with receipts':'Months with receipts',String(data.buckets.filter(b=>b.value>0).length),collectionPeriod==='month'?'In the selected month':'In the last six months']]){const item=el('div');item.append(el('small',label),el('strong',value),el('span',note));stats.append(item);}panel.append(stats);
 const plot=el('div',undefined,'collections-plot'),readout=el('p','Hover over a point or use Tab to see its collection amount.','collections-readout');readout.setAttribute('aria-live','polite');
 const svg=svgElement('svg',{viewBox:'0 0 640 235',role:'img','aria-label':'Collections trend in Pakistani rupees',class:'trend-chart'});
 const max=Math.max(1,...data.buckets.map(b=>b.value)),left=62,right=620,top=18,bottom=190;
 for(let i=0;i<=4;i++){const y=bottom-(bottom-top)*i/4;svg.append(svgElement('line',{x1:left,x2:right,y1:y,y2:y,class:'chart-grid'}),svgElement('text',{x:left-10,y:y+4,'text-anchor':'end',class:'axis-label'},Math.round(max*i/4).toLocaleString()));}
 const points=data.buckets.map((b,i)=>({x:left+i*(right-left)/Math.max(1,data.buckets.length-1),y:bottom-b.value/max*(bottom-top),b}));
 svg.append(svgElement('polygon',{points:`${left},${bottom} ${points.map(p=>`${p.x},${p.y}`).join(' ')} ${right},${bottom}`,class:'trend-fill'}));
 svg.append(svgElement('polyline',{points:points.map(p=>`${p.x},${p.y}`).join(' '),class:'trend-line'}));
 for(const[pIndex,p]of points.entries()){const dot=svgElement('circle',{cx:p.x,cy:p.y,r:4,class:'trend-dot',tabindex:0,'aria-label':`${p.b.key}: Rs ${money(p.b.value)}`});dot.append(svgElement('title',{},`${p.b.key}: Rs ${money(p.b.value)}`));const showValue=()=>{readout.textContent=`${p.b.key} · Rs ${money(p.b.value)} collected`;};dot.addEventListener('pointerenter',showValue);dot.addEventListener('focus',showValue);svg.append(dot);if(collectionPeriod!=='month'||pIndex%5===0||pIndex===points.length-1)svg.append(svgElement('text',{x:p.x,y:217,'text-anchor':'middle',class:'axis-label'},p.b.label));}
 plot.append(svg);panel.append(plot,readout);if(!total)panel.append(el('p','No receipts recorded in this period.','chart-note'));panel.append(chartSummary(data.buckets));return panel;
}

function statusChart(data){
 const {panel}=chartPanel('Customer connections','Current account status');const total=data.statuses.reduce((n,s)=>n+s.value,0);
 const wrap=el('div',undefined,'donut-wrap');const svg=svgElement('svg',{viewBox:'0 0 200 200',class:'donut-chart',role:'img','aria-label':`${total} customers. ${data.statuses.map(s=>`${s.name}: ${s.value}`).join(', ')}`});
 svg.append(svgElement('circle',{cx:100,cy:100,r:72,class:'donut-track'}));let offset=0,circumference=2*Math.PI*72;
 data.statuses.forEach((s,i)=>{if(!s.value||!total)return;const length=s.value/total*circumference;const arc=svgElement('circle',{cx:100,cy:100,r:72,fill:'none',stroke:chartColors[i],'stroke-width':20,'stroke-dasharray':`${length} ${circumference-length}`,'stroke-dashoffset':-offset,transform:'rotate(-90 100 100)'});arc.append(svgElement('title',{},`${s.name}: ${s.value}`));svg.append(arc);offset+=length;});
 svg.append(svgElement('text',{x:100,y:99,'text-anchor':'middle',class:'donut-total'},total),svgElement('text',{x:100,y:120,'text-anchor':'middle',class:'axis-label'},'total customers'));wrap.append(svg);
 const legend=el('div',undefined,'chart-legend');data.statuses.forEach((s,i)=>{const row=el('div',undefined,'legend-row');row.append(el('span','●',`legend-dot tone-${i}`),el('span',s.name),el('strong',s.value),el('small',`${total?Math.round(s.value/total*100):0}%`));legend.append(row);});panel.append(wrap,legend);return panel;
}

function packageChart(data){
 const {panel}=chartPanel('Revenue by package','Expected monthly fees from active customers · PKR');
 if(!data.packages.length){panel.append(emptyChart('Assign packages to active customers to see revenue here.'));return panel;}
 // Keep the chart readable while retaining every package in the data table.
 const entries=data.packages.slice(0,5);if(data.packages.length>5)entries.push({name:'Other packages',count:data.packages.slice(5).reduce((n,p)=>n+p.count,0),value:data.packages.slice(5).reduce((n,p)=>n+p.value,0)});
 const max=Math.max(1,...entries.map(p=>p.value));const list=el('div',undefined,'package-bars');
 entries.forEach((p,i)=>{const row=el('div',undefined,'package-row');const caption=el('div',undefined,'bar-caption');caption.append(el('span',p.name),el('strong',`Rs ${money(p.value)}`));
 const svg=svgElement('svg',{viewBox:'0 0 400 12',class:'bar-chart',role:'img','aria-label':`${p.name}: Rs ${money(p.value)}, ${p.count} active customers`});svg.append(svgElement('rect',{width:400,height:12,rx:6,fill:'#edf2f6'}),svgElement('rect',{width:p.value/max*400,height:12,rx:6,fill:chartColors[i%chartColors.length]}));row.append(caption,svg,el('small',`${p.count} active ${p.count===1?'customer':'customers'}`));list.append(row);});panel.append(list,chartSummary(data.packages));return panel;
}

function workPanel(data,records,dateString){
 const {panel,head}=chartPanel('Ticket work queue',`${data.openTickets.length} tickets awaiting completion`);const link=el('button','View tickets','text-button');link.onclick=()=>navigate('Tickets');head.append(link);
 if(!data.openTickets.length)panel.append(emptyChart('All caught up. No active tickets.'));
 for(const ticket of data.openTickets.slice(0,4)){const row=el('div',undefined,'work-row');const copy=el('div');copy.append(el('strong',ticket.subject));const worker=records.Staff.find(s=>s.id===ticket.assigned_to);copy.append(el('small',`${ticket.type} | ${worker?.name??'Unassigned'} | Due ${ticket.due_date}`));const late=ticket.due_at?Date.parse(ticket.due_at)<Date.now():ticket.due_date<dateString;const status=el('span',late?'Overdue':ticket.status,late?'pill pill-warning':'pill');row.append(copy,status);panel.append(row);}return panel;
}

function stockPanel(data){
 const {panel,head}=chartPanel('Stock watch',`${data.lowStock.length} items need attention`);const link=el('button','View stock →','text-button');link.onclick=()=>navigate('Inventory');head.append(link);
 if(!data.lowStock.length)panel.append(emptyChart('Stock levels look good. No items below their threshold.'));
 for(const item of data.lowStock.slice(0,4)){const row=el('div',undefined,'work-row');const copy=el('div');copy.append(el('strong',item.item),el('small',`${item.category} · Minimum ${item.minimum_stock}`));row.append(copy,el('span',`${item.quantity} left`,'pill pill-warning'));panel.append(row);}return panel;
}

function recentReceipts(records){
 const {panel,head}=chartPanel('Recent receipts','The latest payments across your customer accounts');
 const link=el('button','All payments →','text-button');link.onclick=()=>navigate('Payments');head.append(link);
 const payments=[...records.Payments].sort((a,b)=>b.payment_date.localeCompare(a.payment_date)||b.id-a.id).slice(0,4);
 if(!payments.length)panel.append(emptyChart('Your latest customer payments will appear here.'));
 for(const payment of payments){const customer=records.Customers.find(c=>c.id===payment.customer_id);const row=el('div',undefined,'receipt-row');const avatar=el('span',(customer?.name??'Customer').replace('[DEMO] ','').split(' ').slice(0,2).map(n=>n[0]).join(''),'receipt-avatar');const copy=el('div',undefined,'receipt-copy');copy.append(el('strong',customer?.name??`Customer #${payment.customer_id}`),el('small',`${payment.payment_date} · ${payment.method}`));const amount=el('div',undefined,'receipt-amount');amount.append(el('strong',`Rs ${money(payment.amount)}`),el('small','Received'));row.append(avatar,copy,amount);panel.append(row);}
 return panel;
}

function ticketQueue(records,dateString){
 const tickets=(records.Tickets??[]).filter(t=>!['Resolved','Closed'].includes(t.status));
 const rank={Urgent:0,High:1,Normal:2,Low:3};tickets.sort((a,b)=>rank[a.priority]-rank[b.priority]||a.due_date.localeCompare(b.due_date)||a.id-b.id);
 const {panel,head}=chartPanel('Support tickets',`${tickets.length} active · ${tickets.filter(t=>t.assigned_to===null).length} unassigned · ${tickets.filter(t=>t.due_date<dateString).length} overdue`);panel.classList.add('ticket-dashboard');
 const controls=el('div',undefined,'steps');const view=el('button','View tickets →','text-button'),add=el('button','+ New ticket','secondary');view.onclick=()=>navigate('Tickets');add.onclick=()=>{navigate('Tickets');openEditor();};controls.append(view,add);head.append(controls);
 if(!tickets.length)panel.append(emptyChart('No active support tickets. Create a ticket to assign a customer issue to your team.'));
 const list=el('div',undefined,'ticket-dashboard-list');for(const ticket of tickets.slice(0,6)){const row=el('div',undefined,'work-row');const copy=el('div');const name=el('button',`TKT-${ticket.id} · ${ticket.subject}`,'ticket-link');name.onclick=()=>{navigate('Tickets');openEditor(ticket);};const member=records.Staff.find(s=>s.id===ticket.assigned_to);copy.append(name,el('small',`${member?.name??'Unassigned'} · ${ticket.status} · Due ${ticket.due_date}`));row.append(copy,el('span',`${ticket.priority}${ticket.due_date<dateString?' · Overdue':''}`,'pill '+(['Urgent','High'].includes(ticket.priority)?'pill-warning':'')));list.append(row);}panel.append(list);return panel;
}
function expensesOverview(records,dateString){
 const month=dateString.slice(0,7),totals=expenseTotals(records.Expenses,month);
 const receipts=records.Payments.filter(p=>p.payment_date.startsWith(month)).reduce((n,p)=>n+Number(p.amount),0);
 const {panel,head}=chartPanel('Expenses & cash flow','This month · paid expenses use payment dates; pending bills include all dates');panel.classList.add('expense-dashboard');
 const link=el('button','Manage expenses →','text-button');link.onclick=()=>navigate('Expenses');head.append(link);
 const summary=el('div',undefined,'expense-dashboard-summary');
 for(const[label,value]of [['Paid this month',totals.paid],['Pending bills · all dates',totals.pending],['Net cash this month',receipts-totals.paid]]){const tile=el('div');tile.append(el('small',label),el('strong',`Rs ${money(value)}`));summary.append(tile);}panel.append(summary,el('p','Net cash = recorded customer receipts minus paid expenses. Package costs and inventory purchases are included only when entered as expenses.','expense-note'));
 return panel;
}

function buildDashboard(records,dateString){
 const data=dashboardData(records,dateString,collectionPeriod);const top=el('div',undefined,'dashboard-top');const intro=el('div');intro.append(el('span','BUSINESS AT A GLANCE','eyebrow'),el('p','Your network. Your people. One clear picture.'));
 const controls=el('div',undefined,'dashboard-actions'),refresh=el('button','↻ Refresh','secondary'),add=el('button','+ New customer');refresh.onclick=async()=>{refresh.disabled=true;try{await load();}catch(error){showError(error);refresh.disabled=false;}};add.onclick=()=>{navigate('Customers');openEditor();};controls.append(refresh,add);top.append(intro,controls);
 const fallbackMetrics=[['Active connections',data.active.length,`${records.Customers.length} total customer accounts`,'Customers','◎'],['MRC expected monthly fees',`Rs ${money(data.expected)}`,'Current active customer subscriptions','Customers','↗'],['MRC collected this month',`Rs ${money(data.mrc)}`,'Monthly bill payments received this month','Payments','▥'],['OTC collected this month',`Rs ${money(data.otc)}`,'One-time charges: routers, inventory and installation','Payments','?'],['Open tickets',data.openTickets.length,'Installations, complaints, maintenance and collections','Tickets','▤'],['Available staff',data.available,`${records.Staff.length} team members in total`,'Staff','♧'],['Low-stock items',data.lowStock.length,'At or below the minimum quantity','Inventory','◇']];
 const overview=typeof dashboardOverview==='function'?dashboardOverview(records,dateString):null;if(overview){const order=['clients','active','new','billed','collected','pending','today','balance','expiry-today','expiry3','expiry7','expired','mrc','otc','tickets','stock','recovery'];overview.sort((a,b)=>{const rank=id=>order.includes(id)?order.indexOf(id):order.length;return rank(a.id)-rank(b.id);});}const metrics=overview?overview.map(m=>[m.label,['billed','collected','pending','today','balance','mrc','otc','loss-day','loss-month','assets-value'].includes(m.id)?'Rs '+money(m.value):m.value,m.note,m.section]):fallbackMetrics;
 if(overview){const customize=el('button','Customize Dashboard','secondary');customize.onclick=()=>customizeDashboardCards(overview);controls.prepend(customize);}
 const cards=el('div',undefined,'cards dashboard-cards'+(overview?' reference-overview':''));metrics.forEach(([label,value,note,section],i)=>{const card=el('button',undefined,`card metric-card metric-${i}`);if(overview){card.classList.add('overview-card','overview-'+overview[i].color);card.dataset.dashboardCard=overview[i].id;card.hidden=hiddenDashboardCards().has(overview[i].id);}const heading=el('div',undefined,'metric-heading');const icon=el('span',undefined,'metric-icon');icon.append(dashboardMetricIcon(label));heading.append(el('span',label),icon);card.append(heading,el('strong',value),el('small',note));const arrow=el('span','↗','metric-arrow');arrow.setAttribute('aria-hidden','true');card.append(arrow);card.onclick=()=>section==='Assets'&&typeof openAssetsModule==='function'?openAssetsModule():navigate(section);cards.append(card);});
 if(overview&&typeof dashboardGroups==='function'){const buttons=new Map([...cards.children].map(card=>[card.dataset.dashboardCard,card]));cards.className='dashboard-categories';for(const group of dashboardGroups(overview)){const section=el('section',undefined,'dashboard-category'),heading=el('div',undefined,'dashboard-category-heading'),title=el('h2',group.title);heading.append(title,el('p',group.description));const grid=el('div',undefined,'cards dashboard-cards reference-overview');for(const metric of group.metrics)grid.append(buttons.get(metric.id));section.hidden=![...grid.children].some(card=>!card.hidden);section.append(heading,grid);cards.append(section);}}
 const charts=el('div',undefined,'dashboard-grid');const trend=collectionsChart(data);trend.classList.add('chart-wide');charts.append(trend,statusChart(data),packageChart(data),workPanel(data,records,dateString));
 const bottom=el('div',undefined,'dashboard-bottom');bottom.append(expensesOverview(records,dateString),ticketQueue(records,dateString),stockPanel(data),recentReceipts(records));
 if(document.documentElement.dataset.layout==='studio'){
  buildStudioDashboard(records,dateString,top,cards,charts,bottom);
 }else{
 $('dashboard').replaceChildren(top,...(typeof buildDashboardAnalysis==='function'?[buildDashboardAnalysis(records,dateString)]:[]),cards,...(typeof buildFinancialDashboard==='function'?[buildFinancialDashboard(records,dateString)]:[]),charts,bottom);
 }
}
if(typeof module!=='undefined')module.exports={dashboardData,expenseTotals};

function buildStudioDashboard(records,day,top,cards,charts,bottom){
 const figures=businessFigures(records,day,day.slice(0,7)),health=dashboardAnalysis(records,day),hero=el('section',undefined,'studio-overview');hero.setAttribute('aria-label','Workspace overview');
 const feature=el('article',undefined,'studio-feature'),tag=el('span','MONTHLY COLLECTIONS','studio-tag');feature.append(tag,el('strong','Rs '+money(figures.monthly.collected)),el('p','Confirmed receipts | '+day.slice(0,7)));
 const progress=el('progress');progress.max=100;progress.value=health.collectionRate??0;progress.setAttribute('aria-label','Current-month bill recovery');feature.append(progress,el('p',health.collectionRate===null?'No current-month bills recorded':health.collectionRate.toFixed(1)+'% of current-month charges paid | excludes carried dues'));
 const receiptButton=el('button','View payments','secondary');receiptButton.onclick=()=>navigate('Payments');feature.append(receiptButton);
 const network=el('article',undefined,'studio-network');network.append(el('h2','Network overview'),el('p','Current customer and service health.','business-note'));
 for(const [label,value,section]of [['Total customers',health.total,'Customers'],['Active connections',health.active,'Customers'],['Expired accounts',health.expired.length,'Customers'],['Open tickets',(records.Tickets??[]).filter(t=>!['Resolved','Closed'].includes(t.status)).length,'Tickets']]){const button=el('button',undefined,'studio-network-row');button.append(el('span',label),el('strong',String(value)));button.onclick=()=>navigate(section);network.append(button);}hero.append(feature,network);
 const analysis=buildDashboardAnalysis(records,day),priority=analysis.querySelector('.analysis-panels').firstElementChild;priority.classList.add('studio-priorities');const activity=el('section',undefined,'studio-activity');activity.setAttribute('aria-label','Priorities and recent activity');activity.append(priority,recentReceipts(records));
 const metrics=el('details',undefined,'studio-details');metrics.append(el('summary','Business health & all dashboard metrics'),analysis,cards);
 const performance=el('details',undefined,'studio-details');performance.append(el('summary','Daily graphs, sales & collection analysis'),buildFinancialDashboard(records,day,false),charts);
 const operations=el('details',undefined,'studio-details');operations.append(el('summary','Tickets, inventory & operating activity'),bottom);
 // Profit & loss stays visible rather than inside a collapsed section.
 const profit=typeof reportData==='function'&&can('read','Payments')&&can('read','Expenses')?[buildProfitPanel(records,day.slice(0,7),true)]:[];
 $('dashboard').replaceChildren(top,hero,...profit,activity,metrics,performance,operations);
}
