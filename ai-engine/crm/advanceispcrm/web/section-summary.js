'use strict';
function sectionSummary(section,rows,date){
 const count=status=>rows.filter(r=>r.status===status).length;
 const sum=(list,key)=>list.reduce((total,r)=>total+Number(r[key]||0),0);
 const card=(label,value,note='',tone='',currency=false)=>({label,value,note,tone,currency});
 const month=date.slice(0,7);
 switch(section){
 case 'Equipment recovery':return [card('Terminations',rows.length),card('Recovery pending',count('Equipment recovery pending'),'','warning'),card('Recovered',count('Recovered'),'','good'),card('Monthly MRC lost',sum(rows,'monthly_revenue_loss'),'Monthly fee run-rate at termination','',true)];
 case 'Inventory':return [card('Inventory items',rows.length,'Different stock records'),card('In stock',rows.filter(r=>Number(r.quantity)>0).length,'Items with stock available','good'),card('Low stock',rows.filter(r=>Number(r.quantity)>0&&Number(r.quantity)<=Number(r.minimum_stock)).length,'Above zero, at or below minimum','warning'),card('Out of stock',rows.filter(r=>Number(r.quantity)===0).length,'Items needing replenishment','danger'),card('Stock value',rows.reduce((n,r)=>n+Number(r.quantity)*Number(r.unit_cost),0),'Available quantity × unit cost','',true)];
 case 'Customers':return [card('Customers',rows.length),card('Active',count('Active'),'','good'),card('Suspended / disconnected',count('Suspended')+count('Disconnected')),card('Expired',rows.filter(r=>r.expiry_date&&r.expiry_date<date).length,'Expiry before today','danger'),card('Expiring in 7 days',rows.filter(r=>r.expiry_date&&r.expiry_date>=date&&r.expiry_date<=new Date(Date.parse(date+'T00:00:00Z')+7*86400000).toISOString().slice(0,10)).length,'Includes today','warning'),card('Active monthly fees',sum(rows.filter(r=>r.status==='Active'),'monthly_fee'),'Subscription charges, not collections','',true)];
 case 'Staff':return [card('Employees',rows.length),card('Available',count('Available'),'','good'),card('On duty',count('On duty')),card('On leave',count('On leave'),'','warning'),...(rows.some(r=>r.monthly_salary!==undefined)?[card('Monthly net salary',rows.reduce((n,r)=>n+Number(r.net_salary??0),0),'Agreed pay, not payments made','',true)]:[])];
 case 'Jobs':return [card('Jobs',rows.length),card('Open',count('Open')),card('In progress',count('In progress')),card('Completed',count('Completed'),'','good'),card('Overdue',rows.filter(r=>r.status!=='Completed'&&r.due_date<date).length,'Unfinished and due before today','danger')];
 case 'Tickets':{const active=rows.filter(r=>!['Resolved','Closed'].includes(r.status));return [card('Tickets',rows.length),card('Active',active.length),card('Unassigned',active.filter(r=>r.assigned_to==null).length,'Active tickets','warning'),card('High / urgent',active.filter(r=>['High','Urgent'].includes(r.priority)).length,'Active tickets','warning'),card('Overdue',active.filter(r=>r.due_at?Date.parse(r.due_at)<Date.now():r.due_date<date).length,'Active tickets past their target time','danger'),card('Resolved / closed',rows.length-active.length,'','good')];}
 case 'Payments':return [card('Receipts',rows.length),card('MRC received',sum(rows.filter(r=>r.revenue_type!=='OTC'),'amount'),'Monthly bill receipts','good',true),card('OTC received',sum(rows.filter(r=>r.revenue_type==='OTC'),'amount'),'One-time charge receipts','',true),card('Total received',sum(rows,'amount'),'All matching receipts','good',true),card('Received this month',sum(rows.filter(r=>r.payment_date?.startsWith(month)),'amount'),'By payment date','',true),...['Cash','Card','Bank transfer','Mobile wallet','1LINK','Easypaisa','JazzCash'].map(method=>card(method,sum(rows.filter(r=>r.method===method),'amount'),'Recorded receipts','',true))];
 case 'Expenses':return [card('Expenses',rows.length),card('Recorded amount',sum(rows.filter(r=>r.status!=='Cancelled'),'amount'),'Excludes cancelled expenses','',true),card('Paid amount',sum(rows.filter(r=>r.status==='Paid'),'amount'),'Matching paid expenses','good',true),card('Pending amount',sum(rows.filter(r=>r.status==='Pending'),'amount'),'Matching pending expenses','warning',true),card('Cancelled',count('Cancelled'),'Excluded from totals')];
 case 'Stock issues':return [card('Issue records',rows.length),card('Issued',count('Issued'),'Outstanding issue records','warning'),card('Returned',count('Returned'),'','good'),...['Customer','System','Network'].map(target=>card('Against '+target,rows.filter(r=>r.issued_against===target&&r.status==='Issued').length,'Outstanding issue records'))];
 case 'Packages':return [card('Packages',rows.length),card('Active',count('Active'),'','good'),card('Inactive',count('Inactive')),card('Average selling price',rows.length?sum(rows,'monthly_price')/rows.length:0,'Monthly price per package','',true),card('Average package cost',rows.length?sum(rows,'monthly_cost')/rows.length:0,'Monthly business cost per package','',true)];
 case 'Categories':return [card('Categories',rows.length),card('Active',count('Active'),'','good'),card('Inactive',count('Inactive'))];
 case 'Users':return [card('User accounts',rows.length),card('Active',count('Active'),'','good'),card('Inactive',count('Inactive')),card('Administrators',rows.filter(r=>r.role==='Administrator').length),card('Linked employees',rows.filter(r=>r.staff_id!=null).length)];
 default:return [];
 }
}
function renderSectionSummary(rows){
 const container=$('section-summary');container.replaceChildren();
 const cards=sectionSummary(current,rows,today());container.hidden=!cards.length;
 if(!cards.length)return;
 const heading=el('div',undefined,'section-summary-heading');heading.append(el('h2',current+' summary'),el('p','Matching records · Updates with search and filters · Only records you can access'));container.append(heading);
 const grid=el('div',undefined,'section-summary-grid');
 for(const metric of cards){const card=el('article',undefined,'section-summary-card '+metric.tone);card.append(el('small',metric.label),el('strong',metric.currency?'Rs '+money(metric.value):String(metric.value)));if(metric.note)card.append(el('p',metric.note));grid.append(card);}container.append(grid);
}
if(typeof module!=='undefined')module.exports={sectionSummary};

