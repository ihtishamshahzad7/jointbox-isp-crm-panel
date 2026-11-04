'use strict';
let state,current='Dashboard',editing=null,lastAdminSection='Packages',issueRequestKey=null,editorSection=null;
const $=id=>document.getElementById(id), key=label=>label.toLowerCase().replaceAll(' ','_');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const money=v=>Number(v).toLocaleString('en-PK',{maximumFractionDigits:2});
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
async function load(){const response=await fetch('/api/state'+(typeof cityQuery==='function'?cityQuery():''));if(response.status===401){await startAuth();return;}if(!response.ok){const error=await response.json();throw Error(error.error||'Could not load records.');}state=await response.json();if(typeof renderCityPicker==='function')renderCityPicker();if(typeof renderBandwidthReminder==='function')renderBandwidthReminder();if(current!=='Dashboard'&&current!=='Reports'&&current!=='Monthly invoices'&&!(current in state.schemas))current='Dashboard';render();updateAccountHeader();showSampleDataNotice();}
function navigationIcon(section){
 const paths={Dashboard:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',Customers:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',Inventory:'M3 7l9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10 M7 4l10 5',Staff:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 22v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3',Jobs:'M9 5H5v16h14V5h-4 M9 3h6v5H9z M8 12h8 M8 16h5',Payments:'M3 6h17v14H3z M3 6V3h15 M15 11h7v5h-7z',Admin:'M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7z M8 12l3 3 5-6'};
 paths['Equipment recovery']='M3 7l9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10 M8 16h8 M11 13l-3 3 3 3';
 paths.Tickets='M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4z M9 5v3 M9 11v2 M9 16v3';
 paths.Expenses='M5 3h14v18l-3-2-4 2-4-2-3 2z M8 7h8 M8 11h5 M8 15h8';
 paths['Stock issues']='M3 7l9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10 M8 16h8 M13 13l3 3-3 3';
 const icon=svgElement('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.7,'stroke-linecap':'round','stroke-linejoin':'round',class:'nav-icon','aria-hidden':'true'});icon.append(svgElement('path',{d:paths[section]||paths.Dashboard}));return icon;
}
function toggleMenu(open){document.body.classList.toggle('menu-open',open);$('menu-toggle').setAttribute('aria-expanded',String(open));$('menu-backdrop').hidden=!open;if(open)$('navigation').querySelector('button')?.focus();else $('menu-toggle').focus();}
function navigate(section){if(section==='Jobs')section='Tickets';profileCustomerId=null;profilePayload=null;profileRequest++;const adminSections=['Packages','Categories','Designations','Users','TAT settings'].filter(s=>s in state.schemas);current=section==='Admin'?(adminSections.includes(lastAdminSection)?lastAdminSection:adminSections[0]??'Dashboard'):section;if(['Packages','Categories','Designations','Users','TAT settings'].includes(current))lastAdminSection=current;$('search').value='';if(document.body.classList.contains('menu-open'))toggleMenu(false);render();}
function render(){if($('employee-hierarchy'))$('employee-hierarchy').hidden=current!=='Staff';if($('monthly-invoice-tools'))$('monthly-invoice-tools').hidden=current!=='Monthly invoices';$('export').hidden=false;document.body.classList.toggle('company-dashboard-page',current==='Dashboard'&&['Administrator','Manager'].includes(state.user.role));
 $('title').textContent=current==='Dashboard'?'Dashboard':current==='Packages'?'Admin · Packages & pricing':current;$('subtitle').textContent=current==='Packages'?'Set package speeds, monthly selling prices, monthly business costs, and installation fees. Existing customer fees stay unchanged.':current==='Dashboard'?'Your network, customers and operations. Connected in one workspace.':`Manage your ${current.toLowerCase()} and keep operations moving.`;
 $('add').textContent=({'Customers':'+ Add customer','Inventory':'+ Add inventory','Payments':'+ Record payment','Expenses':'+ Add expense','Packages':'+ Add package'}[current]??'+ Add record');
 $('search').placeholder=({'Customers':'Search name, customer ID or username...','Inventory':'Search item, category or location...','Staff':'Search employee name, code or designation...','Tickets':'Search ticket, subject or customer...','Payments':'Search receipt, customer or reference...'}[current]??'Search '+current.toLowerCase()+'...');
 updateWorkspaceHints();
 if(current==='TAT settings'){$('subtitle').textContent='Set default hours by ticket type and priority. Changes apply to new tickets. Adjust an existing ticket from Tickets > Manage. TAT runs continuously from creation.';$('add').textContent='+ Add TAT rule';}
 if(current==='Categories'){
  $('title').textContent='Admin · Inventory categories';
  $('subtitle').textContent='Add inventory categories or mark them inactive. Renaming a category updates its inventory items; categories in use cannot be deleted.';
  $('add').textContent='+ Add category';
 }
 const adminSections=['Packages','Categories','Designations','Users','TAT settings'].filter(s=>s in state.schemas);const isAdmin=adminSections.includes(current);
 $('navigation').replaceChildren();const navigationGroups=[['Workspace',['Dashboard','Customers','Tickets']],['Inventory',['Inventory','Stock issues','Equipment recovery']],['Finance',['Monthly invoices','Payments','Expenses','Reports']],['Team & settings',['Staff','Admin']]];
 for(const [groupName,sections]of navigationGroups){const visible=sections.filter(section=>section==='Dashboard'||(section==='Monthly invoices'?can('read','Payments'):section==='Reports'?(can('read','Payments')||can('read','Inventory')):section==='Admin'?adminSections.length:section in state.schemas));if(!visible.length)continue;const heading=el('p',groupName,'nav-group-heading');$('navigation').append(heading);for(const section of visible){
  const active=section===current||(section==='Admin'&&isAdmin);
  const b=el('button',undefined,(active?'active ':'')+'nav-'+section.toLowerCase());b.setAttribute('aria-label',({'Stock issues':'Stock movements','Equipment recovery':'Device recovery','Admin':'Settings'}[section]??section));b.title=({'Stock issues':'Stock movements','Equipment recovery':'Device recovery','Admin':'Settings'}[section]??section);b.append(navigationIcon(section),el('span',({'Stock issues':'Stock movements','Equipment recovery':'Device recovery','Admin':'Settings'}[section]??section)),el('span','›','nav-chevron'));if(active)b.setAttribute('aria-current','page');if(section==='Reports'){b.setAttribute('aria-expanded',String(reportMenuOpen));b.setAttribute('aria-controls','report-submenu');b.onclick=()=>toggleReportsMenu(b);}else b.onclick=()=>navigate(section);$('navigation').append(b);
  if(['Customers','Inventory','Staff','Jobs'].includes(section)){const badge=el('span',String(state.records[section].length),'nav-count');b.append(badge);}
  if(section==='Tickets'){const badge=el('span',String(state.records.Tickets.filter(t=>!['Resolved','Closed'].includes(t.status)).length),'nav-count');b.append(badge);}
 }
 }
 if(can('read','Payments')||can('read','Inventory'))appendReportNavigation();
 $('admin-panel').hidden=!isAdmin;$('admin-navigation').replaceChildren();
 if(isAdmin){
  $('title').textContent='Admin';
  for(const section of adminSections){const b=el('button',section==='TAT settings'?'Ticket TAT':section==='Users'?'User management':section==='Packages'?'Packages & pricing':section==='Designations'?'Employee designations':'Inventory categories',section===current?'admin-tab selected':'admin-tab');b.setAttribute('aria-pressed',String(section===current));b.onclick=()=>navigate(section);$('admin-navigation').append(b);}
  $('admin-section-title').textContent=current==='TAT settings'?'Ticket TAT settings':current==='Users'?'User management':current==='Packages'?'Packages & pricing':current==='Designations'?'Employee designations':'Inventory categories';
 }
 renderWorkspaceTabs();renderInventoryQrTools();
 $('ticket-tools').hidden=current!=='Tickets';
 if(current==='Tickets'){$('subtitle').textContent='Log customer issues, assign the right person, and track each ticket through to resolution.';$('add').textContent='+ New ticket';renderTicketTools();}
 $('expense-tools').hidden=current!=='Expenses';
 if(current==='Expenses'){$('subtitle').textContent='Track ISP operating costs, outstanding bills, and payments in PKR.';$('add').textContent='+ Add expense';renderExpenseTools();}
 if(current==='Staff'){$('subtitle').textContent='Employee registration, contact details, employment and monthly salary records.';$('add').textContent='+ Register employee';}
 if(current==='Users'){$('subtitle').textContent='Create team logins, link employees, and choose access roles based on designation.';$('add').textContent='+ Create user';}
 $('stock-tools').hidden=current!=='Stock issues';
 if(current==='Stock issues'){$('subtitle').textContent='Issue stock against a customer, system, or network, and record the responsible employee. Full returns restore available stock.';$('add').textContent='+ Issue stock';renderStockTools();}
 $('section-summary').hidden=current==='Reports'||current==='Dashboard'||(current==='Customers'&&profileCustomerId!==null);$('ticket-summary').hidden=true;$('expense-summary').hidden=true;$('add').hidden=current==='TAT settings'||!canCreate();
 const showingProfile=current==='Customers'&&profileCustomerId!==null;document.body.classList.toggle('customer-profile-page',showingProfile);document.body.classList.toggle('customer-list-page',current==='Customers'&&!showingProfile);$('customer-profile').hidden=!showingProfile;$('customer-filter-button').hidden=current!=='Customers'||showingProfile;$('customer-clear-filters').hidden=current!=='Customers'||showingProfile||!Object.values(customerGridFilters).some(Boolean);$('dashboard').hidden=current!=='Dashboard';$('records').hidden=current==='Reports'||current==='Dashboard'||showingProfile;$('reports').hidden=current!=='Reports';if(current==='Reports')renderReports();else if(current==='Dashboard')dashboard();else if(showingProfile)refreshCustomerProfile();else renderTable();
}
function dashboard(){if(['Administrator','Manager'].includes(state.user.role))buildDashboard(state.records,today());else roleDashboard();}
function filtered(){
 const q=$('search').value.toLowerCase();return state.records[current].filter(r=>{
  if(current==='Customers'&&!customerMatchesFilters(r,customerGridFilters))return false;let text=Object.values(r).join(' ');if(current==='Equipment recovery'){const customer=state.records.Customers.find(c=>c.id===r.customer_id);text+=` ${customer?.name??''} ${customer?.payment_id??''} ${customer?.username??''}`;}if(current==='Payments'){const customer=state.records.Customers.find(c=>c.id===r.customer_id);text+=` RCP-${r.id} ${customer?.payment_id??''} ${customer?.username??''} ${customer?.name??''}`;}
  if(current==='Stock issues'){
   const item=state.records.Inventory.find(i=>i.id===r.inventory_id),employee=state.records.Staff.find(s=>s.id===r.employee_id),customer=state.records.Customers.find(c=>c.id===r.customer_id);
   text+=` ISS-${r.id} ${item?.item??''} ${employee?.name??''} ${customer?.name??''}`;
   if($('stock-target').value&&r.issued_against!==$('stock-target').value)return false;
   if($('stock-employee').value&&String(r.employee_id)!==$('stock-employee').value)return false;
   if($('stock-status').value&&r.status!==$('stock-status').value)return false;
  }
  if(current==='Expenses'){
   const month=$('expense-month').value,status=$('expense-status').value,category=$('expense-category').value;
   if(month&&!r.expense_date.startsWith(month))return false;
   if(status&&r.status!==status)return false;
   if(category&&r.category!==category)return false;
  }
  if(current==='Tickets'){
   const customer=state.records.Customers.find(c=>c.id===r.customer_id),staff=state.records.Staff.find(s=>s.id===r.assigned_to);text+=` TKT-${r.id} ${customer?.name??''} ${staff?.name??'Unassigned'}`;
   const status=$('ticket-status').value,assignee=$('ticket-assignee').value,priority=$('ticket-priority').value;
   if(status==='active'&&['Resolved','Closed'].includes(r.status))return false;
   if(status&&status!=='active'&&r.status!==status)return false;
   if(assignee==='unassigned'&&r.assigned_to!==null)return false;
   if(assignee&&assignee!=='unassigned'&&String(r.assigned_to)!==assignee)return false;
   if(priority&&r.priority!==priority)return false;
   if($('ticket-type').value&&r.type!==$('ticket-type').value)return false;
  }return text.toLowerCase().includes(q);
 });
}
function renderTicketTools(){
 if(!$('ticket-type').options.length){const all=el('option','All types');all.value='';$('ticket-type').append(all);for(const type of new Map(state.schemas.Tickets).get('Type')){const option=el('option',type);option.value=type;$('ticket-type').append(option);}}
 const tickets=state.records.Tickets,active=tickets.filter(t=>!['Resolved','Closed'].includes(t.status));
 const summary=$('ticket-summary');summary.replaceChildren();
 for(const[label,value]of [['Active tickets',active.length],['Unassigned',active.filter(t=>t.assigned_to===null).length],['High / urgent',active.filter(t=>['High','Urgent'].includes(t.priority)).length],['Overdue',active.filter(t=>t.due_date<today()).length]]){const card=el('article',undefined,'ticket-stat');card.append(el('small',label),el('strong',value));summary.append(card);}
 const selected=$('ticket-assignee').value;$('ticket-assignee').replaceChildren();
 for(const[value,label]of [['','All staff'],['unassigned','Unassigned'],...state.records.Staff.map(s=>[String(s.id),`${s.name} · ${s.role}`])]){const option=el('option',label);option.value=value;$('ticket-assignee').append(option);}
 $('ticket-assignee').value=selected;if($('ticket-assignee').selectedIndex<0)$('ticket-assignee').value='';
}
function renderExpenseTools(){
 const totals=expenseTotals(state.records.Expenses,today().slice(0,7));$('expense-summary').replaceChildren();
 for(const[label,value]of [['Recorded this month',totals.recorded],['Paid this month',totals.paid],['Pending · all dates',totals.pending]]){const card=el('article',undefined,'ticket-stat');card.append(el('small',label),el('strong',`Rs ${money(value)}`));$('expense-summary').append(card);}
 const selected=$('expense-category').value;$('expense-category').replaceChildren();const all=el('option','All categories');all.value='';$('expense-category').append(all);
 for(const category of new Map(state.schemas.Expenses).get('Category')){const option=el('option',category);option.value=category;$('expense-category').append(option);}$('expense-category').value=selected;
}
function renderStockTools(){
 const selected=$('stock-employee').value;$('stock-employee').replaceChildren();
 for(const[value,label]of [['','All employees'],...state.records.Staff.map(s=>[String(s.id),s.name])]){const option=el('option',label);option.value=value;$('stock-employee').append(option);}$('stock-employee').value=selected;
}
function fillAssignees(input,row,type){
 const previous=input.value;input.replaceChildren();const empty=el('option','Unassigned — assign later');empty.value='';input.append(empty);
 const roles=['Billing','Collection'].includes(type)?['Collector','Manager','Support']:type==='Other'?['Support','Manager']:['Technician','Support'];
 const staff=[...state.records.Staff].sort((a,b)=>Number(roles.includes(b.role))-Number(roles.includes(a.role))||Number(b.status==='Available')-Number(a.status==='Available')||a.name.localeCompare(b.name));
 for(const member of staff){const workload=state.records.Tickets.filter(t=>t.assigned_to===member.id&&!['Resolved','Closed'].includes(t.status)).length;const option=el('option',`${member.name} · ${member.role} · ${member.area||'No area'} · ${member.status} · ${workload} active tickets${roles.includes(member.role)?' · Suggested role':''}`);option.value=member.id;option.disabled=member.status==='On leave'&&row?.assigned_to!==member.id;input.append(option);}input.value=previous;
}
function renderTable(){if(current==='Monthly invoices'){renderMonthlyInvoices();return;}renderSectionSummary(filtered());renderEmployeeHierarchy();if(current==='Equipment recovery'){renderRecoveryTable();return;}if(current==='Customers'){renderCustomerGrid();return;}
 const fields=current==='Staff'?state.schemas[current].filter(([label])=>['Employee code','Name','Phone','Designation','Reports to','Department','Role','Status','Joining date','Monthly salary','Net salary'].includes(label)):state.schemas[current].filter(([label])=>!(current==='Tickets'&&['Description','Resolution notes'].includes(label))&&!(['Expenses','Stock issues'].includes(current)&&label==='Notes')),head=el('tr');$('tbody').classList.toggle('ticket-rows',current==='Tickets');for(const name of ['ID',...fields.map(f=>f[0]),...(current==='Tickets'?['Recovery equipment','TAT / timeline']:[]),...(current==='Packages'?['Active customers']:[]),'Actions'])head.append(el('th',current==='Stock issues'?({'Inventory ID':'Item','Employee ID':'Employee','Customer ID':'Customer'}[name]??name):current==='Inventory'&&name==='Location'?'Warehouse':name));if(current==='Tickets'){for(const th of head.children)if(th.textContent==='Customer ID')th.textContent='Customer';}$('thead').replaceChildren(head);$('tbody').replaceChildren();
 const rows=filtered();for(const row of rows){const tr=el('tr');tr.append(el('td',current==='Tickets'?`TKT-${row.id}`:current==='Stock issues'?`ISS-${row.id}`:row.id));for(const[label,type]of fields){const td=el('td');let value=row[key(label)];if(type==='money')value=(current==='Packages'&&label==='Monthly cost'&&typeof packagePeakCostLabel==='function'&&packagePeakCostLabel(row))||'Rs '+money(value);if(type==='customer'||type==='optionalcustomer'||type==='staff'||type==='optionalstaff'||type==='assignee'||type==='inventory'){const linked=state.records[type==='inventory'?'Inventory':type==='customer'||type==='optionalcustomer'?'Customers':'Staff'].find(r=>r.id===value);value=linked?`${linked.name??linked.item}${type==='inventory'&&linked.location?' · '+linked.location:''} (#${value})`:type==='assignee'?'Unassigned':value;}if(label==='Status'||(current==='Tickets'&&label==='Priority'))td.append(el('span',value,'badge badge-'+String(value).toLowerCase().replaceAll(' ','-')));else td.textContent=value;if(current==='Tickets'&&['Description','Resolution notes'].includes(label)){td.classList.add('ticket-text');td.title=String(value);}tr.append(td);}if(current==='Tickets'){const equipment=el('td',row.type==='Equipment recovery'?recoveryEquipmentNames(row):'-','recovery-equipment-cell');tr.append(equipment);const tat=el('td');tat.append(ticketTatCell(row));tr.append(tat);}
 // Packages: active customers on this package, and how many others (suspended, disconnected, terminated) still use it.
 if(current==='Packages'){const on=(state.records.Customers??[]).filter(c=>c.package_id===row.id),active=on.filter(c=>c.status==='Active').length,cell=el('td');cell.append(el('strong',String(active)));if(on.length>active)cell.append(el('small',`of ${on.length} total`,'grid-username'));tr.append(cell);}const actions=el('td'),edit=el('button','Edit','secondary'),remove=el('button','Delete','danger');edit.onclick=()=>openEditor(row);remove.onclick=()=>deleteRecord(row);if(current==='Payments'){edit.textContent='View';const receipt=el('a','Receipt / Print','document-download');receipt.href='/receipt?id='+row.id;receipt.target='_blank';receipt.rel='noopener';actions.append(receipt,edit);}else if(current==='Tickets'){edit.textContent='Manage';actions.append(edit);if(!['Resolved','Closed'].includes(row.status)&&can('write')){const resolve=el('button','Resolve','secondary');resolve.onclick=()=>openEditor({...row,status:'Resolved'});actions.append(resolve);}}else if(current==='Stock issues'){edit.textContent='View';actions.append(edit);if(row.status==='Issued'&&can('write','Stock issues')){const back=el('button','Return stock','secondary');back.onclick=()=>returnStock(row);actions.append(back);}if(state.user.role==='Administrator'){const drop=el('button','Delete','danger');drop.onclick=()=>deleteStockIssue(row);actions.append(drop);}}else{actions.append(edit,remove);if(current==='Customers'&&canManageCustomerDocuments()){const docs=el('button','Documents','secondary');docs.onclick=()=>openCustomerDocuments(row);actions.append(docs);}if(current==='Customers'&&['Administrator','Manager','Accountant','Support'].includes(state.user.role)){const invoice=el('button','Print invoice','secondary');invoice.onclick=()=>printCustomerInvoice(row);actions.append(invoice);}if(current==='Customers'&&canCreate('Tickets')){const ticket=el('button','Log ticket','customer-ticket-button');ticket.onclick=()=>logCustomerTicket(row);actions.append(ticket);}if(['Inventory','Expenses'].includes(current)){const invoices=el('button',`Invoices${row.invoice_count?' ('+row.invoice_count+')':''}`,'secondary');invoices.onclick=()=>openInvoices(current,row);actions.append(invoices);}if(current==='Inventory'&&canCreate('Inventory')){const batch=el('button','New batch','secondary');batch.title='Receive more of this item as a new batch with its own price';batch.onclick=()=>newInventoryBatch(row);actions.append(batch);}if(current==='Inventory'&&can('write','Inventory')&&typeof openTransfer==='function'){const move=el('button','Transfer','secondary');move.title='Move stock of this batch to another warehouse';move.disabled=row.quantity<1;move.onclick=()=>openTransfer(row);actions.append(move);}if(current==='Inventory'&&canCreate('Stock issues')){const issue=el('button','Issue stock','secondary');issue.disabled=row.quantity<1;issue.onclick=()=>{navigate('Stock issues');openEditor();const field=$('form').elements.namedItem('inventory_id');field.value=row.id;field.dispatchEvent(new Event('change',{bubbles:true}));};actions.append(issue);}}if(!can('delete'))remove.hidden=true;if(['Users','TAT settings'].includes(current))remove.hidden=true;if(!can('write'))edit.textContent='View';tr.append(actions);$('tbody').append(tr);}
 $('empty').hidden=rows.length>0;$('count').textContent=`${rows.length} of ${state.records[current].length} records`;
 if(current==='Expenses')$('count').textContent+=` · Filtered total (excluding cancelled): Rs ${money(rows.filter(r=>r.status!=='Cancelled').reduce((n,r)=>n+Number(r.amount),0))}`;
}
function logCustomerTicket(customer){
 navigate('Tickets');openEditor();
 const fields=$('form').elements;
 fields.namedItem('customer_id').value=String(customer.id);
 $('form-title').textContent=`New ticket · ${customer.name}`;
 const context=el('div',undefined,'customer-ticket-context full-field');
 context.append(el('strong',customer.name),el('small',`${customer.username} · ${customer.phone} · ${customer.package}`));
 $('fields').prepend(context);
 fields.namedItem('subject').placeholder='Describe the customer issue';
 fields.namedItem('description').placeholder='Symptoms, troubleshooting, and details for the assigned employee';
 fields.namedItem('subject').focus();
}
function openEditor(row=null,section=current){const page=current;editorSection=section;try{current=section;buildEditor(row);}finally{current=page;}}
function buildEditor(row=null){stockIssueCustomer=null;
 $('save').textContent='Save record';$('save').hidden=false;issueRequestKey=['Stock issues','Payments'].includes(current)&&!row?crypto.randomUUID():null;
 editing=row;$('fields').replaceChildren();$('form-error').textContent='';$('form-title').textContent=`${row?'Edit':'Add'} ${current.toLowerCase()} record`;
 for(const[label,type]of state.schemas[current]){const name=key(label),wrapper=el('label',current==='Stock issues'?({'Inventory ID':'Inventory item','Employee ID':'Employee name','Customer ID':'Customer'}[label]??label):current==='Customers'&&label==='Joined'?'Creation date':current==='Inventory'&&label==='Location'?'Warehouse':label);let input;
 if(current==='Inventory'&&name==='location'){input=el('select');const names=[...new Set([...(state.warehouses??[]),...(row?.location?[row.location]:[])])];input.append(new Option('Select warehouse',''),...names.map(n=>new Option(n,n)));if(!row&&names.length===1)input.value=names[0];}
 else if(current==='Customers'&&name==='city'){input=el('select');const names=[...new Set([...(state.city_list??[]),...(row?.city?[row.city]:[])])];input.append(new Option('Select city',''),...names.map(n=>new Option(n,n)));if(!row&&(state.city||names.length===1))input.value=state.city||names[0];}
 else if(current==='Customers'&&name==='area'){input=el('select');const blank=el('option','No area assigned');blank.value='';input.append(blank);const options=[...new Set([...(state.area_options??[]),...(row?.area?[row.area]:[])])];for(const value of options){const option=el('option',value);option.value=value;input.append(option);}}else if(type==='assignee'){input=el('select');fillAssignees(input,row,row?.type??'Network outage');}else if(type==='longtext'){input=el('textarea');input.rows=3;wrapper.classList.add('full-field');}else if(type==='category'){
 input=el('select');const placeholder=el('option','Select an inventory category');placeholder.value='';input.append(placeholder);
 for(const category of [...state.records.Categories].sort((a,b)=>a.name.localeCompare(b.name))){
  if(category.status!=='Active'&&category.name!==row?.category)continue;
  const option=el('option',category.name+(category.status==='Inactive'?' (Inactive)':''));option.value=category.name;input.append(option);
 }
 if(row&&!state.records.Categories.some(c=>c.name===row.category)){const option=el('option',row.category);option.value=row.category;input.append(option);}
 }else if(type==='package'){
 input=el('select');const placeholder=el('option','Select a package');placeholder.value='';input.append(placeholder);
 for(const p of state.records.Packages.filter(p=>p.status==='Active'||p.id===row?.package_id)){const o=el('option',`${p.name} · ${p.speed_mbps} Mbps · Rs ${money(p.monthly_price)}/month${p.status==='Inactive'?' (Inactive)':''}`);o.value=p.id;input.append(o);}
 if(row&&!row.package_id){const legacy=el('option',`${row.package} (existing package)`);legacy.value=row.package;input.append(legacy);}
 if(row?.package_id&&!state.records.Packages.some(p=>p.id===row.package_id)){const existing=el('option',row.package);existing.value=row.package_id;input.append(existing);}
 input.onchange=()=>{const p=state.records.Packages.find(p=>String(p.id)===input.value);const fee=$('form').elements.namedItem('monthly_fee');if(fee)fee.value=row&&String(row.package_id)===input.value?row.monthly_fee:p?p.monthly_price:row?.monthly_fee??0;const installation=$('form').elements.namedItem('installation_charge');if(installation&&!row&&!installation.dataset.manual)installation.value=p?p.installation_fee:0;};
 }else if(type==='inventory'){input=el('select');const empty=el('option','Select inventory item');empty.value='';input.append(empty);for(const item of state.records.Inventory){const option=el('option',`${item.item}${item.batch?" / Batch "+item.batch:""} · ${item.location||'No warehouse'} · ${item.quantity} available (#${item.id})`);option.value=item.id;input.append(option);}}
 else if(Array.isArray(type)||type==='customer'||type==='optionalcustomer'||type==='staff'||type==='optionalstaff'){input=el('select');const choices=Array.isArray(type)?type:state.records[type==='customer'||type==='optionalcustomer'?'Customers':'Staff'].map(r=>[r.id,`${r.name}${r.payment_id?' · '+r.username+' · Payment ID '+r.payment_id:''} (#${r.id})`]);if(!Array.isArray(type)){const o=el('option','Select a record');o.value='';input.append(o);}for(const c of choices){const o=el('option',Array.isArray(c)?c[1]:c);o.value=Array.isArray(c)?c[0]:c;input.append(o);}}
 else{input=el('input');input.type=type==='date'||type==='optionaldate'?'date':type==='month'?'month':['money','integer','latitude','longitude'].includes(type)?'number':'text';if(input.type==='number'){input.min='0';input.max='1000000000000';input.step=type==='money'?'0.01':'1';}}
 if(current==='Inventory'&&name==='batch'){input.maxLength=100;input.placeholder='Select a batch or type a new one (optional)';let batches=document.getElementById('inventory-batches');if(!batches){batches=document.createElement('datalist');batches.id='inventory-batches';document.body.append(batches);}batches.replaceChildren(...[...new Set((state.records.Inventory??[]).map(r=>r.batch).filter(Boolean))].sort().map(b=>new Option(b,b)));input.setAttribute('list','inventory-batches');input.autocomplete='off';}if(label==='Email')input.type='email';if(type==='latitude'||type==='longitude'){input.min=type==='latitude'?'-90':'-180';input.max=type==='latitude'?'90':'180';input.step='0.0000001';input.inputMode='decimal';}input.name=name;input.required=type!=='optionaldate'&&type!=='optionalcustomer'&&type!=='optionaltext'&&type!=='assignee'&&type!=='optionalstaff'&&!['Notes','Reference','Address','Location','Area','Resolution notes'].includes(label);if(row)input.value=type==='package'?(row.package_id??row.package):(row[name]??'');else if(type==='date')input.value=today();else if(type==='month')input.value=today().slice(0,7);else if(type==='money'||type==='integer')input.value=0;
 if(type==='generated'){input.readOnly=true;input.required=false;input.placeholder='Generated automatically when saved';}
 if(current==='Customers'&&name==='monthly_fee'){input.readOnly=true;input.title='Set automatically from the selected package. Existing agreed fees are preserved.';}
 if(current==='Packages'&&name==='speed_mbps')input.min='1';
 if(current==='Packages'&&name==='monthly_cost')input.title='Your monthly business cost per customer for this package, in PKR.';
 if(current==='TAT settings'&&row&&['ticket_type','priority'].includes(name))for(const option of input.options)option.disabled=option.value!==input.value;if(current==='TAT settings'&&name==='hours'){input.min='1';input.max='720';input.title='Continuous calendar hours from ticket creation';}wrapper.append(input);$('fields').append(wrapper);
 }if(current==='Staff')setupStaffEditor(row);if(current==='Customers'){setupCustomerEditor(row);if(typeof setupCustomerCity==='function')setupCustomerCity(row);}if(current==='Payments')setupPaymentEditor(row);if(current==='Tickets')setupTicketEditor(row);if(current==='Expenses')setupExpenseEditor(row);if(current==='Stock issues')setupStockIssueEditor(row);if(current==='Inventory')setupInventoryEditor(row);if(['Inventory','Expenses'].includes(current)&&can('write'))setupInvoiceField();if(current==='Users')setupUserEditor(row);applyEditorPermissions(row);$('editor').showModal();$('fields').querySelector('input,select')?.focus();
}
// Each inventory record is one batch of an item, with its own cost and selling price.
function nextBatchNumber(){
 const prefix='B-'+today().slice(2,4)+today().slice(5,7)+'-',used=(state.records.Inventory??[]).map(i=>String(i.batch||'')).filter(b=>b.startsWith(prefix)).map(b=>Number(b.slice(prefix.length))).filter(Number.isInteger);
 return prefix+String(Math.max(0,...used)+1).padStart(3,'0');
}
function setupInventoryEditor(row){
 const batch=$('form').elements.namedItem('batch');
 if(batch&&!row&&!batch.value)batch.value=nextBatchNumber();
 $('fields').append(el('p',row?'Each batch keeps its own unit cost and selling price. To receive more of this item at a different price, use New batch instead of changing these prices.':'The batch number is filled in automatically; you can pick an existing batch from the list or keep the new one. Enter this batch’s own unit cost and selling price.','expense-note full-field'));
}
// Stock issue: choose the warehouse, the item, then one of its batches there; the hidden inventory_id select stays the source of truth.
function setupBatchPicker(stockField){
 const stock=state.records.Inventory??[],houseWrap=el('label','Warehouse'),house=el('select'),itemWrap=el('label','Item'),item=el('select'),batchWrap=el('label','Batch'),batch=el('select');
 const houses=[...new Set(stock.map(i=>i.location).filter(Boolean))].sort((a,b)=>a.localeCompare(b)),inHouse=()=>stock.filter(i=>i.location===house.value);
 house.append(new Option('Select warehouse',''),...houses.map(h=>new Option(`${h} · ${stock.filter(i=>i.location===h).reduce((n,i)=>n+Number(i.quantity),0)} units in stock`,h)));
 if(houses.length===1)house.value=houses[0];
 const fillItems=()=>{const rows=inHouse(),names=[...new Set(rows.map(i=>i.item))].sort((a,b)=>a.localeCompare(b)),keep=item.value;
  item.replaceChildren(new Option(house.value?'Select item':'Select a warehouse first',''),...names.map(name=>{const total=rows.filter(i=>i.item===name).reduce((n,i)=>n+Number(i.quantity),0),o=new Option(`${name} · ${total} available`,name);o.disabled=total<=0;return o;}));
  if(names.includes(keep))item.value=keep;};
 const fillBatches=()=>{const rows=inHouse().filter(i=>i.item===item.value).sort((a,b)=>String(a.batch).localeCompare(String(b.batch)));
  batch.replaceChildren(new Option(rows.length?'Select batch':'Select an item first',''),...rows.map(r=>{const o=new Option(`${r.batch||'No batch'} · ${r.quantity} available · cost Rs ${money(r.unit_cost)} · sale Rs ${money(r.selling_price||0)}`,r.id);o.disabled=Number(r.quantity)<=0;return o;}));
  const open=rows.filter(r=>Number(r.quantity)>0);if(open.length===1)batch.value=String(open[0].id);};
 const pushToStock=()=>{if(stockField.value!==batch.value){stockField.value=batch.value;stockField.dispatchEvent(new Event('change',{bubbles:true}));}};
 house.onchange=()=>{fillItems();fillBatches();pushToStock();};item.onchange=()=>{fillBatches();pushToStock();};batch.onchange=pushToStock;
 // A scanned QR label picks the batch directly; follow it to its warehouse and item.
 const follow=()=>{const r=stock.find(i=>String(i.id)===stockField.value);if(r&&(house.value!==r.location||item.value!==r.item)){house.value=r.location;fillItems();item.value=r.item;fillBatches();}if(batch.value!==stockField.value)batch.value=stockField.value;};
 stockField.addEventListener('change',follow);
 house.required=item.required=batch.required=true;houseWrap.append(house);itemWrap.append(item);batchWrap.append(batch);fillItems();fillBatches();if(stockField.value)follow();
 const original=stockField.closest('label');original.before(houseWrap,itemWrap,batchWrap);original.hidden=true;
}
function newInventoryBatch(from){
 openEditor();const fields=$('form').elements;$('form-title').textContent='New batch of '+from.item;
 for(const name of ['item','category','location','minimum_stock','unit_cost','selling_price']){const input=fields.namedItem(name);if(input&&from[name]!=null){input.value=from[name];input.dispatchEvent(new Event('change',{bubbles:true}));}}
 fields.namedItem('quantity').value='';fields.namedItem('quantity').focus();
}
function setupStockIssueEditor(row){
 if(!row)attachStockQrInput();
 const fields=$('form').elements;$('form-title').textContent=row?`Stock issue ISS-${row.id}`:'Issue inventory';
 if(!row){const stockField=fields.namedItem('inventory_id'),quantity=fields.namedItem('quantity'),available=el('p','Select an item to see available stock.','expense-note full-field');$('fields').append(available);const recovery=fields.namedItem('recovery_required');let recoveryChanged=false;recovery.addEventListener('change',()=>recoveryChanged=true);const updateStock=()=>{const item=state.records.Inventory.find(i=>String(i.id)===stockField.value);if(item){if(!recoveryChanged)recovery.value=['ONT','ONU','OLT','Router','Switch','ONU / ONT','SFP / SFP+ Module','Media Converter','PoE Injector','Power Adapter','UPS','Battery','Splicing Machine','Optical Power Meter','OTDR'].includes(item.category)?'Yes':'No';quantity.max=String(item.quantity);available.textContent=`Available: ${item.quantity} | ${item.item}${item.batch?" / Batch "+item.batch:""}. Issuing stock deducts this quantity immediately.`;}else{quantity.removeAttribute('max');available.textContent='Select an item to see available stock.';}};stockField.addEventListener('change',updateStock);setupBatchPicker(stockField);for(const option of stockField.options){const item=state.records.Inventory.find(i=>String(i.id)===option.value);if(item&&Number(item.quantity)<=0)option.disabled=true;}}
 fields.namedItem('quantity').min='1';if(!row)fields.namedItem('quantity').value='1';
 fields.namedItem('status').disabled=true;fields.namedItem('status').value=row?.status??'Issued';
 const update=()=>{const customer=fields.namedItem('issued_against').value==='Customer';const input=fields.namedItem('customer_id');input.disabled=!customer;input.required=customer;input.closest('label').hidden=!customer;if(!customer)input.value='';fields.namedItem('destination').required=!customer;fields.namedItem('destination').placeholder=customer?'Optional installation address':'System name or network location';};
 fields.namedItem('issued_against').onchange=update;update();
 const note=el('p',row?'Issue history is read-only. Use Return stock to restore the full quantity.':'Saving immediately reduces available stock. Recovery required: choose No for consumables or customer-owned/sold items. Employee name is optional: choose the person receiving or responsible for the items, or leave it blank.','expense-note full-field');$('fields').append(note);
 if(row){for(const input of $('fields').querySelectorAll('input,select,textarea'))input.disabled=true;$('save').hidden=true;if(row.returned_at)note.textContent+=' Returned: '+new Date(row.returned_at).toLocaleString('en-PK',{timeZone:'Asia/Karachi'});}
 setupStockBilling(row);setupDeviceCapture(row);
}
// Device label photo: device-label.js reads make, model, MAC and serial from it in the browser; staff check them before saving.
function setupDeviceCapture(row){
 const title=el('h3','Device details','full-field'),box=el('div',undefined,'device-capture full-field'),status=el('p',undefined,'expense-note'),preview=el('img'),photo=el('input');
 preview.alt='Device label photo';preview.className='device-photo-preview';preview.hidden=true;photo.type='hidden';photo.name='device_photo';
 const details=[['device_make','Make'],['device_model','Model'],['device_mac','MAC address'],['device_serial','Serial number (SN)']].map(([name,label])=>{const wrap=el('label',label),input=el('input');input.name=name;input.maxLength=100;input.value=row?.[name]??'';input.disabled=Boolean(row);input.autocomplete='off';if(name==='device_mac')input.placeholder='e.g. 00:1A:2B:3C:4D:5E';wrap.append(input);return wrap;});
 if(row){if(row.has_photo){preview.src=`/api/stock-issues/${row.id}/photo`;preview.hidden=false;box.append(preview);}else box.append(el('p','No device photo was saved with this issue.','expense-note'));$('fields').append(title,box,...details);return;}
 const pick=el('label',undefined,'device-photo-pick'),file=el('input');file.type='file';file.accept='image/*';file.setAttribute('capture','environment');file.setAttribute('aria-label','Device photo');pick.append(el('span','Add device photo'),file);
 status.textContent='Take or upload a clear photo of the device label. Make, model, MAC and serial number are filled in automatically; check them before saving.';
 file.onchange=async()=>{const chosen=file.files[0];if(!chosen)return;status.textContent='Preparing photo…';try{const data=await shrinkPhoto(chosen);photo.value=data;preview.src=data;preview.hidden=false;const reading=await readDeviceLabel(data,message=>{status.textContent=message;});raw.hidden=false;raw.open=false;rawText.textContent=[reading.codes.length?'Barcodes: '+reading.codes.join(' | '):'No barcode found.',reading.text||'(no text could be read)'].join('\n\n');let found=0;for(const [name,value]of Object.entries(reading.fields)){const input=$('form').elements.namedItem(name);if(input&&value){input.value=value;found++;}}status.textContent=found?`Read ${found} of 4 details from the photo. Check them and correct anything wrong before saving.`:'No details could be read from this photo. Enter them by hand or try a clearer, closer photo.';}catch(error){status.textContent=error.message+' You can still type the details.';}};
 const raw=el('details',undefined,'device-raw-text'),rawText=el('pre');raw.hidden=true;raw.append(el('summary','Text read from photo'),rawText);
 box.append(pick,preview,status,raw,photo);$('fields').append(title,box,...details);
}
async function shrinkPhoto(file){
 const url=URL.createObjectURL(file);
 try{const image=await new Promise((done,fail)=>{const img=new Image();img.onload=()=>done(img);img.onerror=()=>fail(Error('This file is not a photo the browser can open.'));img.src=url;});
  const scale=Math.min(1,1800/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',0.88);}
 finally{URL.revokeObjectURL(url);}
}
async function deleteStockIssue(row){if(!confirm(`Permanently delete issue ISS-${row.id}?${row.status==='Issued'?` Its ${row.quantity} unit(s) go back into stock.`:''} Any unpaid customer charge for it is removed. This cannot be undone.`))return;try{await mutate({section:'Stock issues',id:row.id,action:'delete'});await load();}catch(error){showError(error);}}
async function returnStock(row){if(!confirm(`Return all ${row.quantity} units from issue ISS-${row.id} to stock?`))return;try{await mutate({section:'Stock issues',id:row.id,action:'return'});await load();}catch(error){showError(error);}}
function setupExpenseEditor(row){
 $('form-title').textContent=row?'Edit expense':'Add business expense';const fields=$('form').elements;
 fields.namedItem('amount').min='0.01';
 const allocationNote=el('p','Select the customer this activation cost belongs to, such as labour or transport. Stock issued to the customer is valued separately; enter only additional costs here.','expense-note full-field');
 // Expenses are business costs by default; the customer field only appears when the cost is allocated to one.
 const customerField=fields.namedItem('customer_id'),customerLabel=customerField.closest('label'),allocate=el('label',undefined,'expense-allocate full-field'),toggle=el('input');
 toggle.type='checkbox';toggle.checked=Boolean(row?.customer_id||customerField.value);allocate.append(toggle,document.createTextNode('Charge this cost to a specific customer (activation cost)'));
 customerLabel.firstChild.textContent='Customer';$('fields').append(allocate,customerLabel,allocationNote);
 const syncAllocation=()=>{customerLabel.hidden=allocationNote.hidden=!toggle.checked;if(!toggle.checked&&customerField.value){customerField.value='';customerField.dispatchEvent(new Event('change'));}};toggle.onchange=syncAllocation;customerField.addEventListener('change',()=>{if(customerField.value&&!toggle.checked){toggle.checked=true;syncAllocation();}});syncAllocation();
 const paymentDate=fields.namedItem('payment_date');if(!row)paymentDate.value=today();
 const update=()=>{const paid=fields.namedItem('status').value==='Paid';paymentDate.required=paid;paymentDate.disabled=!paid;if(!paid)paymentDate.value='';else if(!paymentDate.value)paymentDate.value=today();};fields.namedItem('status').onchange=update;update();
}
async function mutate(payload){const response=await fetch(payload.section==='Users'?'/api/users':'/api/record',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify(payload)});const result=await response.json();if(response.status===401){await startAuth();throw Error('Sign in again before saving.');}if(!response.ok)throw Error(result.error||'Could not save record.');return result;}
function setupTicketEditor(row){
 if(row?.type==='Equipment recovery'){const customer=state.records.Customers.find(c=>c.id===row.customer_id),summary=el('div',undefined,'recovery-ticket-summary full-field');summary.append(el('strong','Customer: '+(customer?.name??('Customer #'+row.customer_id))),el('p','Equipment: '+recoveryEquipmentNames(row)));$('fields').prepend(summary);}
setupTicketTat(row);
 $('form-title').textContent=row?`Manage ticket TKT-${row.id}`:'New support ticket';
 const fields=$('form').elements;
 fields.namedItem('type').onchange=()=>fillAssignees(fields.namedItem('assigned_to'),row,fields.namedItem('type').value);
 const requireResolution=()=>{fields.namedItem('resolution_notes').required=['Resolved','Closed'].includes(fields.namedItem('status').value);};
 fields.namedItem('status').onchange=requireResolution;requireResolution();
 if(row){const history=el('section',undefined,'ticket-history full-field');history.append(el('h3','Ticket timeline'));
  const format=value=>value?new Date(value).toLocaleString('en-PK',{timeZone:'Asia/Karachi',dateStyle:'medium',timeStyle:'short'})+' PKT':'—';
  history.append(el('p',`Created: ${format(row.created_at)} · Updated: ${format(row.updated_at)}`));
  if(row.resolved_at)history.append(el('p',`Resolved: ${format(row.resolved_at)}`));
  for(const event of (state.ticket_activity??[]).filter(e=>e.ticket_id===row.id).slice().reverse()){const entry=el('div',undefined,'ticket-event');entry.append(el('small',format(event.created_at)),el('p',event.message));history.append(entry);}$('fields').append(history);
 }
}
$('form').onsubmit=async event=>{event.preventDefault();const section=editorSection??current;if(!can('write',section))return;$('save').disabled=true;try{const documents=section==='Customers'?await customerFormDocuments():[];const customerIssue=section==='Stock issues'?stockIssueCustomer:null;const result=await mutate({documents,section,id:editing?.id,fields:{...(editing??{}),...Object.fromEntries(new FormData($('form'))),...(customerIssue?{customer_id:customerIssue.id,issued_against:'Customer'}:{})},activate_partial:section==='Payments'&&$('partial-activation-choice')?.value==='yes',request_key:issueRequestKey,original_quantity:section==='Inventory'?editing?.quantity:undefined});if(typeof uploadEditorInvoices==='function')await uploadEditorInvoices(section,result.id??editing?.id);$('editor').close();stockIssueCustomer=null;await load();if(customerIssue){returnToStockCustomer(customerIssue);$('notice').textContent='Stock issued to '+customerIssue.name+' and deducted from available inventory.';$('notice').hidden=false;}if(result.recharge){$('notice').textContent=result.recharge.message;if(result.receipt_url){const receipt=el('a',' View receipt '+result.receipt_number);receipt.href=result.receipt_url;receipt.target='_blank';receipt.rel='noopener';$('notice').append(receipt);}$('notice').hidden=false;}}catch(error){if($('editor').open)$('form-error').textContent=error.message;else showError(error);}finally{$('save').disabled=false;}};
async function deleteRecord(row){if(!confirm(`Delete record #${row.id}? This cannot be undone.`))return;try{await mutate({section:current,id:row.id,action:'delete'});await load();}catch(error){showError(error);}}
function showError(error){$('notice').textContent=error.message;$('notice').hidden=false;}
$('menu-toggle').onclick=()=>toggleMenu(!document.body.classList.contains('menu-open'));
// Focus can scroll the collapsed sidebar sideways, which clips its labels once it widens.
$('sidebar').addEventListener('scroll',()=>{if($('sidebar').scrollLeft)$('sidebar').scrollLeft=0;});
$('menu-backdrop').onclick=()=>toggleMenu(false);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('menu-open'))toggleMenu(false);});
$('add').onclick=()=>openEditor();$('close').onclick=$('cancel').onclick=()=>{const customer=stockIssueCustomer;stockIssueCustomer=null;$('editor').close();if(customer)returnToStockCustomer(customer);};$('editor').addEventListener('cancel',()=>{const customer=stockIssueCustomer;stockIssueCustomer=null;if(customer)returnToStockCustomer(customer);});$('search').oninput=()=>{const clear=$('clear-record-search');if(clear)clear.hidden=!$('search').value;renderTable();};for(const id of ['ticket-type','ticket-status','ticket-assignee','ticket-priority','expense-month','expense-status','expense-category','stock-target','stock-employee','stock-status'])$(id).onchange=renderTable;
$('export').onclick=()=>{const columns=['id',...state.schemas[current].map(f=>key(f[0]))];const quote=v=>{let t=String(v??'');if(/^[=+@\-\t\r]/.test(t))t="'"+t;return '"'+t.replaceAll('"','""')+'"';};const csv=[['ID',...state.schemas[current].map(f=>f[0])],...filtered().map(r=>columns.map(c=>{if(current!=='Stock issues')return r[c];const links={inventory_id:['Inventory','item'],employee_id:['Staff','name'],customer_id:['Customers','name']};if(!links[c])return r[c];const [section,label]=links[c];const record=state.records[section].find(item=>item.id===r[c]);return record?`${record[label]} (#${r[c]})`:r[c];}))].map(r=>r.map(quote).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));const a=el('a');a.href=url;a.download=current.toLowerCase()+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('expense-month').value=today().slice(0,7);
$('today').textContent=new Date().toLocaleDateString('en-PK',{day:'numeric',month:'short',year:'numeric'});setupAuthControls();setupDocumentControls();setupCustomerProfileControls();startAuth();

function setupStaffEditor(row){
 $('form-title').textContent=(row?'Employee details - '+row.name:'Register employee');
 const fields=$('form').elements;
 const employeeCode=fields.namedItem('employee_code');if(employeeCode){employeeCode.readOnly=true;employeeCode.placeholder='Generated automatically when saved';employeeCode.closest('label').append(el('small','Unique employee code assigned automatically.'));}
 const designation=fields.namedItem('designation');if(designation){const select=el('select');select.name='designation';select.append(new Option('No designation (optional)',''));for(const item of state.records.Designations??[]){if(item.status==='Active'||item.name===row?.designation)select.append(new Option(item.name,item.name));}if(row?.designation&&![...select.options].some(o=>o.value===row.designation))select.append(new Option(row.designation,row.designation));select.value=row?.designation??'';designation.replaceWith(select);}
 const manager=fields.namedItem('reports_to');if(manager){for(const option of [...manager.options])if(row&&String(row.id)===option.value)option.remove();manager.options[0].textContent='No manager / top level';}
 const employeeEmail=fields.namedItem('email');if(employeeEmail){employeeEmail.type='email';employeeEmail.autocomplete='email';employeeEmail.required=!row;employeeEmail.closest('label').append(el('small','Used for password recovery when linked to a user login.'));}
 for(const [name,title]of [['name','Basic details'],['employee_code','Identity & contact'],['emergency_contact_name','Emergency contact'],['designation','Employment details'],['monthly_salary','Monthly salary (PKR)'],['bank_name','Salary payment details']]){const input=fields.namedItem(name);if(input){const heading=el('h3',title,'full-field');input.closest('label').before(heading);}}
 const salary=fields.namedItem('net_salary');
 if(salary){const update=()=>salary.value=(Number(fields.namedItem('monthly_salary').value||0)+Number(fields.namedItem('allowances').value||0)-Number(fields.namedItem('deductions').value||0)).toFixed(2);for(const name of ['monthly_salary','allowances','deductions'])fields.namedItem(name).addEventListener('input',update);update();}
 $('fields').append(el('p','Monthly net salary = base salary + allowances - deductions. Saving salary records the agreed pay; record actual salary payments in Expenses. Identity, emergency, banking and salary details are visible only to administrators and managers.','expense-note full-field'));
}

function showSampleDataNotice(){let note=$('sample-data-notice');if(state.user.username==='demo-reviewer'){if(!note){note=el('p','Preview workspace - Fictional sample records','sample-data-notice');note.id='sample-data-notice';document.querySelector('.app-topbar').after(note);}}else if(note)note.remove();}

function updateWorkspaceHints(){let clear=$('clear-record-search');if(!clear){clear=el('button','Clear search','secondary');clear.id='clear-record-search';clear.type='button';clear.onclick=()=>{$('search').value='';clear.hidden=true;renderTable();$('search').focus();};$('search').after(clear);}clear.hidden=!$('search').value;let note=$('access-mode-note');if(!note){note=el('p','View-only access. You can browse and search these records. Contact your administrator if you need to make changes.','access-mode-note');note.id='access-mode-note';$('records').before(note);}note.hidden=['Dashboard','Reports'].includes(current)||can('write',current);}

function setupStockBilling(row){const fields=$('form').elements,modeWrap=el('label','Customer charge'),mode=el('select'),wrap=el('label','Unit selling price (PKR)'),price=el('input'),discountWrap=el('label','Discount (%)'),discount=el('input'),total=el('p',undefined,'expense-note full-field');
 mode.name='charge_mode';for(const [value,text]of [['Charge','Charge full price'],['Discount','Apply discount'],['Waived','Waive off (free)']])mode.append(new Option(text,value));mode.value=row?(row.waived?'Waived':Number(row.discount_percent)>0?'Discount':'Charge'):'Charge';
 price.name='unit_selling_price';price.type='number';price.min='0';price.max='1000000000';price.step='0.01';price.value=row?(row.list_price??row.unit_selling_price??0):0;
 discount.name='discount_percent';discount.type='number';discount.min='0.01';discount.max='99.99';discount.step='0.01';discount.placeholder='e.g. 10';discount.value=row&&Number(row.discount_percent)>0&&!row.waived?row.discount_percent:'';
 if(row)for(const input of [mode,price,discount])input.disabled=true;
 modeWrap.append(mode);wrap.append(price);discountWrap.append(discount);$('fields').append(modeWrap,wrap,discountWrap,total);
 // Mirrors stock_issue_price on the server, which decides the final charge.
 const update=()=>{const customer=fields.namedItem('issued_against').value==='Customer',waived=mode.value==='Waived',discounted=mode.value==='Discount',qty=Number(fields.namedItem('quantity').value||0),list=Number(price.value||0),off=discounted?Number(discount.value||0):0,unit=waived?0:Math.round(list*(100-off))/100;
  modeWrap.hidden=!customer;wrap.hidden=!customer||waived;discountWrap.hidden=!customer||!discounted;
  if(!row){mode.disabled=!customer;price.disabled=!customer||waived;discount.disabled=!customer||!discounted;price.required=customer&&!waived;discount.required=customer&&discounted;}
  total.textContent=!customer?'System and network stock movements do not create a customer bill.':waived?`Waived off: the customer is not charged for this item${list?` (list price Rs ${money(list)} each)`:''}. Stock is still deducted.`:!list?'This item has no selling price in Inventory. Enter the price, or choose Waive off.':`Customer bill charge: ${qty} × Rs ${money(unit)}${off?` (${off}% off Rs ${money(list)})`:''} = Rs ${money(unit*qty)}. Added to the invoice for the issue month. Returning stock does not automatically cancel or refund this charge.`;};
 fields.namedItem('inventory_id').addEventListener('change',()=>{if(!row){const item=state.records.Inventory.find(i=>String(i.id)===fields.namedItem('inventory_id').value);price.value=item?(Number(item.selling_price)||Number(item.unit_cost)||0):0;}update();});
 for(const name of ['issued_against','quantity'])fields.namedItem(name).addEventListener(name==='quantity'?'input':'change',update);for(const input of [mode,price,discount])input.addEventListener(input===mode?'change':'input',update);update();}

let invoiceMonthFilter='',invoiceStatusFilter='';
function renderMonthlyInvoices(){
 $('title').textContent='Monthly Invoices';$('subtitle').textContent='One saved invoice per customer and month. Active customers are billed automatically each month, starting this month.';
 $('add').hidden=true;$('section-summary').hidden=true;$('export').hidden=true;
 let tools=$('monthly-invoice-tools');if(!tools){tools=el('div',undefined,'ticket-filters');tools.id='monthly-invoice-tools';$('records').querySelector('.toolbar').after(tools);}tools.replaceChildren();
 const month=el('input');month.type='month';month.value=invoiceMonthFilter;month.setAttribute('aria-label','Invoice month');month.onchange=()=>{invoiceMonthFilter=month.value;renderMonthlyInvoices();};
 const status=el('select');status.setAttribute('aria-label','Invoice status');for(const label of ['All statuses','Unpaid','Partially paid','Paid']){const option=el('option',label);option.value=label==='All statuses'?'':label;status.append(option);}status.value=invoiceStatusFilter;status.onchange=()=>{invoiceStatusFilter=status.value;renderMonthlyInvoices();};tools.append(month,status);
 const statusOf=i=>Number(i.remaining)<=0?'Paid':Number(i.paid)>0?'Partially paid':'Unpaid',q=$('search').value.toLowerCase();
 const rows=(state.records.Invoices??[]).filter(i=>(!invoiceMonthFilter||i.billing_month===invoiceMonthFilter)&&(!invoiceStatusFilter||statusOf(i)===invoiceStatusFilter)&&[i.invoice_number,i.customer_name,i.customer_payment_id,i.username,i.billing_month].join(' ').toLowerCase().includes(q));
 $('thead').replaceChildren();const head=el('tr');for(const label of ['Month','Invoice','Customer ID','Customer','MRC','Stock / services','Previous balance','Total bill','Received','Remaining','Status','Actions'])head.append(el('th',label));$('thead').append(head);$('tbody').replaceChildren();
 for(const i of rows){const tr=el('tr');for(const value of [i.billing_month,i.invoice_number,i.customer_payment_id,i.customer_name,...[i.amount,i.service_amount,i.previous_balance,i.total,i.paid,i.remaining].map(n=>'Rs '+money(n)),statusOf(i)])tr.append(el('td',value));const td=el('td'),link=el('a','Open / print','document-download');link.href='/invoice?id='+i.id;link.target='_blank';link.rel='noopener';td.append(link);tr.append(td);$('tbody').append(tr);}
 $('empty').hidden=rows.length>0;$('count').textContent=rows.length+' monthly invoices';
}

function renderEmployeeHierarchy(){
 let root=$('employee-hierarchy');if(current!=='Staff'){if(root)root.hidden=true;return;}if(!root){root=el('details',undefined,'employee-hierarchy');root.id='employee-hierarchy';$('records').before(root);}root.hidden=false;const wasOpen=root.open;root.replaceChildren(el('summary','Employee reporting hierarchy'));root.open=wasOpen;
 const staff=state.records.Staff??[],byId=new Map(staff.map(s=>[s.id,s])),children=new Map(),seen=new Set();for(const member of staff){const parent=byId.has(member.reports_to)?member.reports_to:null;if(!children.has(parent))children.set(parent,[]);children.get(parent).push(member);}
 const draw=parent=>{const list=el('ul');for(const member of (children.get(parent)??[]).sort((a,b)=>a.name.localeCompare(b.name))){if(seen.has(member.id))continue;seen.add(member.id);const item=el('li'),card=el('div',undefined,'hierarchy-person');card.append(el('strong',member.name),el('small',[member.employee_code,member.designation||member.role,member.department].filter(Boolean).join(' · ')));item.append(card);if(children.has(member.id))item.append(draw(member.id));list.append(item);}return list;};root.append(draw(null));if(!staff.length)root.append(el('p','Register employees and select Reports to to build the hierarchy.'));
}

function renderWorkspaceTabs(){
 setupWorkspaceLayout();
 let tabs=$('workspace-tabs');if(!tabs){tabs=el('nav',undefined,'workspace-tabs');tabs.id='workspace-tabs';tabs.setAttribute('aria-label','Workspace shortcuts');document.querySelector('main>header').before(tabs);}if(document.documentElement.dataset.layout==='studio')document.querySelector('.app-topbar').append(tabs);else document.querySelector('main>header').before(tabs);tabs.replaceChildren();
 for(const [label,section]of [['Overview','Dashboard'],['Customers','Customers'],['Support','Tickets'],['Inventory','Inventory'],['Finance','Monthly invoices'],['Reports','Reports']]){
  const allowed=section==='Dashboard'||section==='Monthly invoices'&&can('read','Payments')||section==='Reports'&&(can('read','Payments')||can('read','Inventory'))||section in state.schemas;if(!allowed)continue;
  const button=el('button',label);button.type='button';button.setAttribute('aria-pressed',String(current===section));if(current===section)button.setAttribute('aria-current','page');button.onclick=()=>navigate(section);tabs.append(button);
 }
}

function setupWorkspaceLayout(){
 let button=$('layout-toggle');if(!button){button=el('button',undefined,'secondary');button.id='layout-toggle';button.type='button';document.querySelector('.theme-switcher').before(button);button.onclick=()=>{const layout=document.documentElement.dataset.layout==='studio'?'standard':'studio';document.documentElement.dataset.layout=layout;try{localStorage.setItem('ispcrm-layout',layout);}catch{}render();};}button.textContent='Layout: '+(document.documentElement.dataset.layout==='studio'?'Studio':'Standard');button.setAttribute('aria-label','Switch dashboard layout');
}

function recoveryEquipmentNames(ticket){
 const lines=String(ticket.description??'').split('\n'),items=lines.filter(line=>/^ISS-\d+:/.test(line.trim())).map(line=>line.trim().replace(/^ISS-\d+:\s*/,''));
 if(items.length)return items.join('; ');
 const issues=(state.records['Stock issues']??[]).filter(issue=>issue.customer_id===ticket.customer_id&&issue.status==='Issued'&&issue.recovery_required==='Yes');
 const names=issues.map(issue=>{const item=state.records.Inventory?.find(i=>i.id===issue.inventory_id);return (item?.item??'Inventory #'+issue.inventory_id)+' x '+issue.quantity;});
 return names.length?names.join('; '):'No recoverable equipment recorded';
}
