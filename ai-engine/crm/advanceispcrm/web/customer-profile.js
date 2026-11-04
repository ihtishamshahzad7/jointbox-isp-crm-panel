'use strict';
let profileCustomerId=null,profileTab='Subscriptions',profilePayload=null,profileRequest=0;
let customerGridFilters={},stockIssueCustomer=null;
function customerMatchesFilters(customer,filters){
 const contains=(value,query)=>String(value??'').toLowerCase().includes(String(query??'').trim().toLowerCase());
 const digits=value=>String(value??'').replace(/\D/g,'');
 if(filters.customer_id&&!contains(customer.payment_id,filters.customer_id)&&!contains(customer.id,filters.customer_id)&&!contains(customer.username,filters.customer_id))return false;
 for(const key of ['email','name'])if(filters[key]&&!contains(customer[key],filters[key]))return false;
 if(filters.phone&&!contains(customer.phone,filters.phone)&&!(digits(filters.phone)&&digits(customer.phone).includes(digits(filters.phone))))return false;
 if(filters.cnic&&!digits(customer.cnic).includes(digits(filters.cnic)||'no-match'))return false;
 if(filters.status&&customer.status!==filters.status)return false;
 if(filters.customer_type&&customer.customer_type!==filters.customer_type)return false;
 return true;
}
function profileFinance(invoices){return {invoiced:invoices.reduce((n,i)=>n+Number(i.amount),0),received:invoices.reduce((n,i)=>n+Number(i.paid),0),balance:invoices.reduce((n,i)=>n+Number(i.amount)-Number(i.paid),0)};}
function profileAction(text,handler,cls='secondary'){const button=el('button',text,cls);button.type='button';button.onclick=handler;return button;}
function profileBadge(value){return el('span',value,'badge badge-'+String(value).toLowerCase().replaceAll(' ','-'));}
function openCustomerProfile(customer){profileCustomerId=customer.id;profilePayload=null;profileTab='Subscriptions';current='Customers';render();window.scrollTo({top:0,behavior:'smooth'});}
function closeCustomerProfile(){profileCustomerId=null;profilePayload=null;render();}
async function refreshCustomerProfile(){
 if(current!=='Customers'||!profileCustomerId)return;
 const request=++profileRequest,id=profileCustomerId;
 $('customer-profile').replaceChildren(el('p','Loading customer account...','profile-loading'));
 try{const response=await fetch(`/api/customers/${id}/profile`);const data=await response.json();if(response.status===401){await startAuth();return;}if(!response.ok)throw Error(data.error||'Could not load profile.');
  if(request!==profileRequest||current!=='Customers'||profileCustomerId!==id)return;
  profilePayload=data;renderCustomerProfile();
 }catch(error){if(request===profileRequest&&current==='Customers'&&profileCustomerId===id){$('customer-profile').replaceChildren(el('p',error.message,'profile-loading'),profileAction('Back to customers',closeCustomerProfile),profileAction('Try again',refreshCustomerProfile));}}
}
function renderCustomerGrid(){
 $('thead').replaceChildren();const header=el('tr');for(const label of ['Customer ID','Customer name','Type','City','Area','Status','Expiry date','Monthly bill',...(can('read','Payments')?['Account balance']:[]),'Email','Mobile','Actions'])header.append(el('th',label));$('thead').append(header);$('tbody').replaceChildren();
 const customers=filtered();for(const customer of customers){const row=el('tr');const id=el('td');id.append(profileAction(customer.payment_id,()=>openCustomerProfile(customer),'customer-id-link'));const name=el('td');name.append(profileAction(customer.name,()=>openCustomerProfile(customer),'customer-name-link'),el('small',customer.username,'grid-username'));
  row.append(id,name,el('td',customer.customer_type||'Residential'),el('td',customer.city||'Not set'),el('td',customer.area||'Not assigned'));const status=el('td');status.append(profileBadge(customer.status));if(customer.recovery_status==='Equipment recovery pending')status.append(el('small','Equipment recovery pending','grid-username'));row.append(status);
 // Expiry date with days left; expired and soon-to-expire accounts stand out.
 const expiry=el('td'),days=customer.expiry_date?Math.round((Date.parse(customer.expiry_date)-Date.parse(today()))/864e5):null;expiry.append(el('strong',customer.expiry_date||'Not set',days===null?'':days<0?'expiry-past':days<=7?'expiry-soon':''),el('small',days===null?'':days<0?`Expired ${-days} day${days===-1?'':'s'} ago`:days===0?'Expires today':`${days} day${days===1?'':'s'} left`,'grid-username'));row.append(expiry);
 const bill=el('td');bill.append(el('strong','Rs '+money(Number(customer.monthly_fee||0))),el('small',customer.package||'No package','grid-username'));bill.title='Monthly subscription fee for the current package';row.append(bill);if(can('read','Payments')){const balance=el('td'),value=Number(customer.account_balance??0);balance.append(el('strong',value<0?'Rs '+money(-value)+' credit':'Rs '+money(value),value>0?'customer-balance-due':value<0?'customer-balance-credit':''));balance.title='Ledger balance: saved bills, extra charges and installation less confirmed receipts. Unbilled subscription months are excluded.';row.append(balance);}row.append(el('td',customer.email||'—'),el('td',customer.phone));
  const actions=el('td',undefined,'customer-grid-actions');actions.append(profileAction('View profile',()=>openCustomerProfile(customer),'profile-view-button'));if(canCreate('Payments'))actions.append(profileAction('Recharge',()=>rechargeCustomer(customer),'profile-primary'));
  if(canCreate('Tickets'))actions.append(profileAction('Log ticket',()=>logCustomerTicket(customer),'customer-ticket-button'));
  const more=el('details',undefined,'customer-more');more.append(el('summary','More'));const menu=el('div',undefined,'customer-more-menu');
  if(canCreate('Stock issues'))menu.append(profileAction('Issue stock',()=>issueForProfile(customer)));
  if(can('write','Customers'))menu.append(profileAction('Edit customer',()=>openEditor(customer)));
  if(canManageCustomerDocuments())menu.append(profileAction('Documents',()=>openCustomerDocuments(customer)));
  if(['Administrator','Manager','Accountant','Support'].includes(state.user.role))menu.append(profileAction('Print invoice',()=>printCustomerInvoice(customer)));
  if(can('write','Customers')&&customer.status!=='Terminated')menu.append(profileAction('Terminate account',()=>openTermination(customer),'danger'));
  if(can('delete','Customers'))menu.append(profileAction('Delete customer',()=>deleteRecord(customer),'danger'));
  if(menu.children.length){more.append(menu);actions.append(more);}row.append(actions);$('tbody').append(row);
 }
 $('empty').hidden=customers.length>0;$('count').textContent=`${customers.length} of ${state.records.Customers.length} customers`;
 const count=Object.values(customerGridFilters).filter(Boolean).length;$('customer-filter-button').textContent=count?`Filters (${count})`:'Advanced filters';$('customer-clear-filters').hidden=!count;
}
function profileTable(headers,rows){
 const wrapper=el('div',undefined,'profile-table-wrap'),table=el('table'),head=el('tr');for(const label of headers)head.append(el('th',label));const thead=el('thead');thead.append(head);table.append(thead);const tbody=el('tbody');
 for(const values of rows){const row=el('tr');for(const value of values){const cell=el('td');if(value&&typeof value==='object'&&value.nodeType)cell.append(value);else cell.textContent=value??'—';row.append(cell);}tbody.append(row);}table.append(tbody);wrapper.append(table);
 if(!rows.length)wrapper.append(el('p','No records found.','profile-empty'));return wrapper;
}
function profilePanel(title,note,actions=[]){const panel=el('article',undefined,'profile-panel'),head=el('div',undefined,'profile-panel-heading'),copy=el('div');copy.append(el('h2',title));if(note)copy.append(el('p',note));head.append(copy);if(actions.length){const group=el('div',undefined,'profile-actions');group.append(...actions);head.append(group);}panel.append(head);return panel;}
function profileSearchTable(panel,headers,records,renderRow,placeholder='Search records...'){
 const input=el('input');input.type='search';input.className='profile-table-search';input.placeholder=placeholder;input.setAttribute('aria-label',placeholder);const body=el('div');const update=()=>{const query=input.value.toLowerCase();body.replaceChildren(profileTable(headers,records.filter(record=>Object.values(record).join(' ').toLowerCase().includes(query)).map(renderRow)));};input.oninput=update;panel.append(input,body);update();
}
function customerRecordAction(section,customer,row=null){if(section==='Payments')openEditor(row,'Payments');else{navigate(section);openEditor(row);}if(!row){const field=$('form').elements.namedItem('customer_id');if(field){field.value=customer.id;field.dispatchEvent(new Event('change',{bubbles:true}));}}}
function returnToStockCustomer(customer){navigate('Customers');openCustomerProfile(customer);profileTab='Hardware details';}
function issueForProfile(customer){
 if(!canCreate('Stock issues'))return;
 navigate('Stock issues');openEditor();stockIssueCustomer=customer;
 const form=$('form').elements;form.namedItem('issued_against').value='Customer';form.namedItem('issued_against').dispatchEvent(new Event('change',{bubbles:true}));form.namedItem('customer_id').value=String(customer.id);
 form.namedItem('issued_against').disabled=true;form.namedItem('customer_id').disabled=true;
 $('form-title').textContent='Issue stock - '+customer.name;$('save').textContent='Issue and deduct stock';
 const context=el('div',undefined,'customer-ticket-context full-field');context.append(el('strong',customer.name),el('p',`Customer ID: ${customer.payment_id} | Username: ${customer.username}`),el('p','Choose the inventory item, employee and quantity. Saving issues the items to this customer and immediately deducts available stock.'));$('fields').prepend(context);
}

function renderCustomerProfile(){
 const data=profilePayload,customer=data.customer;
 $('title').textContent='Customer account';$('subtitle').textContent=`${customer.name} · ${customer.username}`;
 const top=el('div',undefined,'profile-topline');top.append(profileAction('← Customer list',closeCustomerProfile,'profile-back'));
 const actions=el('div',undefined,'profile-actions');if(can('write','Customers'))actions.append(profileAction('Edit customer',()=>openEditor(customer)));if(canCreate('Tickets'))actions.append(profileAction('+ Log ticket',()=>logCustomerTicket(customer),'profile-primary'));if(['Administrator','Manager','Accountant','Support'].includes(state.user.role))actions.append(profileAction('Print invoice',()=>printCustomerInvoice(customer)));if(can('write','Customers'))actions.append(profileAction('Customer app access',()=>manageCustomerApp(customer)),profileAction('Send app notification',()=>notifyCustomerApp(customer)));actions.append(profileAction('Refresh',refreshCustomerProfile));if(canCreate('Stock issues'))actions.append(profileAction('Issue stock',()=>issueForProfile(customer),'profile-primary'));if(can('write','Customers')&&customer.status!=='Terminated')actions.append(profileAction('Terminate account',()=>openTermination(customer),'danger'));if(canCreate('Payments')&&customer.status!=='Terminated')actions.append(profileAction('Recharge customer',()=>rechargeCustomer(customer),'profile-primary'));top.append(actions);
 const layout=el('div',undefined,'customer-account-layout'),sidebar=el('aside',undefined,'customer-account-sidebar');
 const avatar=el('div',undefined,'profile-avatar-cover');avatar.append(el('div',customer.name.replace('[DEMO] ','').split(' ').slice(0,2).map(n=>n[0]).join(''),'profile-avatar'),profileBadge(customer.status));
 const identity=el('div',undefined,'profile-identity');identity.append(el('h2',customer.name),el('p','Customer ID · '+customer.payment_id),el('small',customer.username));sidebar.append(avatar,identity);
 const facts=el('div',undefined,'profile-facts');
 if(data.access.finance){const balance=profileFinance(data.invoices).balance;const row=el('div',undefined,'profile-highlight');row.append(el('span','Invoiced balance'),el('strong',data.invoices.length?`PKR ${money(balance)}`:'No invoices yet'));facts.append(row);}
 if(customer.status==='Terminated'){const recovery=el('div',undefined,'profile-highlight');recovery.append(el('span','Equipment recovery'),profileBadge(customer.recovery_status));facts.append(recovery);}
 if(data.ledger){const balance=el('div',undefined,'profile-highlight');balance.append(el('span','Account balance'),el('strong','PKR '+money(data.ledger.balance)));facts.append(balance);}
 const kind=el('div',undefined,'profile-highlight');kind.append(el('span','Customer type'),profileBadge(customer.customer_type||'Residential'));facts.append(kind);
 const detail=el('details',undefined,'profile-details');detail.open=true;detail.append(el('summary','Customer details'));
 for(const[label,value]of [['Payment ID',customer.payment_id],['CNIC',customer.cnic],['Passport',customer.passport],['Mobile',customer.phone],['Telephone',customer.telephone],['NTN',customer.ntn],['Billing email',customer.email],['Billing address',customer.address],['City',customer.city],['Area',customer.area],['Creation date',customer.joined],['Expiry date',customer.expiry_date]]){const item=el('div');item.append(el('strong',label),el('span',value||'Not provided'));detail.append(item);}const location=el('div');location.append(el('strong','Deployment pin'));const mapUrl=customerMapUrl(customer);if(mapUrl){location.append(el('span',`${customer.latitude}, ${customer.longitude}`));const map=el('a','View deployment on map');map.href=mapUrl;map.target='_blank';map.rel='noopener noreferrer';location.append(map);}else location.append(el('span','Location not recorded'));detail.append(location);facts.append(detail);sidebar.append(facts);
 const main=el('div',undefined,'customer-account-main'),tabs=el('nav',undefined,'profile-tabs');tabs.setAttribute('aria-label','Customer account sections');
 const available=['Subscriptions'];if(data.access.documents)available.push('Documents');if(data.access.finance)available.push('Finance','Ledger','Payment history');if(data.access.costs)available.push('Activation costs');if(data.access.tickets)available.push('Tickets');if(data.access.hardware)available.push('Hardware details');if(data.access.tickets)available.push('Activity');
 if(!available.includes(profileTab))profileTab='Subscriptions';
 for(const name of available){const button=profileAction(name,()=>{profileTab=name;renderCustomerProfile();},name===profileTab?'profile-tab active':'profile-tab');button.setAttribute('aria-pressed',String(name===profileTab));tabs.append(button);}main.append(tabs);
 if(profileTab==='Subscriptions'){
  const buttons=can('write','Customers')?[profileAction('Change package / expiry',()=>openEditor(customer))]:[];
  const panel=profilePanel('Internet subscription','Current connection and monthly subscription.',buttons);
  panel.append(profileTable(['Product / package','Status','Monthly fee','Activated / joined','Expiry date'],[[customer.package,profileBadge(customer.status),`PKR ${money(customer.monthly_fee)}`,customer.joined,customer.expiry_date]]));
  const note=el('p','Expiry is the date recorded on the account. Router provisioning and additional services are not connected.','profile-footnote');panel.append(note);main.append(panel);
 }
 if(profileTab==='Documents')renderProfileDocuments(main,data);
 if(profileTab==='Finance')renderProfileFinance(main,data);
 if(profileTab==='Ledger')renderCustomerLedger(main,data);
 if(profileTab==='Payment history')renderCustomerPaymentHistory(main,data);
 if(profileTab==='Activation costs')renderActivationCosts(main,data);
 if(profileTab==='Tickets')renderProfileTickets(main,data);
 if(profileTab==='Hardware details'){
  const panel=profilePanel('Issued hardware & materials','Inventory issued specifically against this customer.',canCreate('Stock issues')?[profileAction('+ Issue stock',()=>issueForProfile(customer))]:[]);
  profileSearchTable(panel,['Issue','Item','Quantity','Employee','Issue date','Status','Actions'],data.records['Stock issues'],issue=>{const actions=el('div',undefined,'profile-actions');actions.append(profileAction('View',()=>customerRecordAction('Stock issues',customer,issue)));if(can('write','Stock issues')&&issue.status==='Issued')actions.append(profileAction('Return stock',async()=>{await returnStock(issue);await refreshCustomerProfile();}));return [`ISS-${issue.id}`,state.records.Inventory.find(i=>i.id===issue.inventory_id)?.item??`Item #${issue.inventory_id}`,issue.quantity,(issue.employee_id==null?'Not assigned':state.records.Staff.find(s=>s.id===issue.employee_id)?.name??`Staff #${issue.employee_id}`),issue.issue_date,profileBadge(issue.status),actions];});main.append(panel);
 }
 if(profileTab==='Activity'){
  const panel=profilePanel('Ticket activity','Recorded assignment and resolution changes.');profileSearchTable(panel,['Ticket','Event','Date (PKT)'],data.events,event=>[`TKT-${event.ticket_id}`,event.message,new Date(event.created_at).toLocaleString('en-PK',{timeZone:'Asia/Karachi'})]);main.append(panel);
 }
 layout.append(sidebar,main);$('customer-profile').replaceChildren(top,layout);
}
function renderProfileDocuments(main,data){
 const panel=profilePanel('Documents','Private attachments for this customer.',[profileAction('+ Add document',()=>openCustomerDocuments(data.customer))]);
 profileSearchTable(panel,['Attachment','Document type','Uploaded by','Uploaded date','Actions'],data.documents,record=>{const link=el('a',record.original_name);link.href='/api/customer-documents/'+record.id;link.download=record.original_name;return [link,record.document_type,record.uploaded_name||'Former user',new Date(record.uploaded_at).toLocaleString('en-PK',{timeZone:'Asia/Karachi'}),profileAction('Manage',()=>openCustomerDocuments(data.customer))];},'Search documents...');main.append(panel);
}
function renderProfileFinance(main,data){
 renderCustomerServices(main,data);
 if(data.installation){const i=data.installation;const panel=profilePanel('Installation charges','One-time charges, separate from monthly subscription bills.',canCreate('Payments')&&Number(i.due)>0?[profileAction('Record installation payment',()=>recordInstallationPayment(data.customer),'profile-primary')]:[]);const summary=el('div',undefined,'profile-finance-summary');for(const [label,value]of [['Installation charge',i.charge],['Installation paid',i.paid],['Installation outstanding',i.due]]){const card=el('div');card.append(el('small',label),el('strong','PKR '+money(value)));summary.append(card);}panel.append(summary);main.append(panel);}

 const history=profilePanel('Recharge history','CRM activations from confirmed receipts, including approved partial payments.');
 profileSearchTable(history,['Billing month','Confirmed total (PKR)','Fee (PKR)','Activation','Unpaid at activation','Previous expiry','New expiry','Activated (PKT)'],data.recharges??[],r=>[r.billing_month,money(r.received_amount),money(r.monthly_fee),r.partial_activation?'Partial payment approved':'Fully paid',money(r.outstanding_amount??0),r.previous_expiry,r.expiry_date,new Date(r.activated_at).toLocaleString('en-PK',{timeZone:'Asia/Karachi'})]);
 main.append(history);

 const totals=data.ledger?{invoiced:data.ledger.debits,received:data.ledger.credits,balance:data.ledger.balance}:profileFinance(data.invoices),summary=el('div',undefined,'profile-finance-summary');for(const[label,value]of [['Account charges',totals.invoiced],['Confirmed payments',totals.received],['Ledger balance',totals.balance]]){const card=el('div');card.append(el('small',label),el('strong',`PKR ${money(value)}`));summary.append(card);}main.append(summary);
 const payments=profilePanel('Payments','Receipts recorded for this customer.',canCreate('Payments')?[profileAction('+ Add payment',()=>customerRecordAction('Payments',data.customer))]:[]);
 profileSearchTable(payments,['Receipt','Revenue type','Amount (PKR)','Payment method','Billing month','Reference','Posted on'],data.records.Payments,p=>{const receipt=el('a',`RCP-${p.id}`);receipt.href='/receipt?id='+p.id;receipt.target='_blank';receipt.rel='noopener';return [receipt,p.revenue_type==='OTC'?'OTC / '+(p.otc_type??'Other'):'MRC',money(p.amount),p.method,p.billing_month,p.reference||'-',p.payment_date];},'Search payments...');main.append(payments);
 const invoiceActions=['Administrator','Manager','Accountant','Support'].includes(state.user.role)?[profileAction('Create / print invoice',()=>printCustomerInvoice(data.customer))]:[];
 const invoices=profilePanel('Monthly Invoices','Saved monthly invoices. Payments are matched by billing month.',invoiceActions);
 profileSearchTable(invoices,['Issue date','Invoice number','Month','Monthly charge','Services','Previous balance','Total bill','Received','Remaining','Status','Download'],data.invoices,i=>{const link=el('a','Open / print');link.href='/invoice?id='+i.id;link.target='_blank';link.rel='noopener';return [i.issue_date,i.invoice_number,i.billing_month,money(i.amount),money(i.service_amount??0),money(i.previous_balance??0),money(i.total??i.amount),money(i.paid),money(Math.max(0,Number(i.total??i.amount)-Number(i.paid))),profileBadge(Number(i.paid)>=Number(i.total??i.amount)?'Paid':Number(i.paid)>0?'Partially paid':'Unpaid'),link];},'Search invoices...');main.append(invoices,el('p','Balance covers saved invoices and receipts matched to those invoices. Uninvoiced months are not treated as arrears.','profile-footnote'));
}
function renderProfileTickets(main,data){
 const panel=profilePanel('Tickets','Customer issues and their assigned employees.',canCreate('Tickets')?[profileAction('+ Log ticket',()=>logCustomerTicket(data.customer))]:[]);
 profileSearchTable(panel,['Ticket','Subject','Priority','Status','Assigned employee','TAT / timeline','Actions'],data.records.Tickets,t=>[`TKT-${t.id}`,t.subject,profileBadge(t.priority),profileBadge(t.status),state.records.Staff.find(s=>s.id===t.assigned_to)?.name??'Unassigned',ticketTatCell(t),profileAction(can('write','Tickets')?'Manage':'View',()=>customerRecordAction('Tickets',data.customer,t))],'Search tickets...');main.append(panel);
}
function setupCustomerProfileControls(){
 $('customer-filter-button').onclick=()=>{$('customer-filter-form').reset();for(const[key,value]of Object.entries(customerGridFilters))if($('customer-filter-form').elements.namedItem(key))$('customer-filter-form').elements.namedItem(key).value=value;$('customer-filter-dialog').showModal();};
 $('customer-filter-close').onclick=()=>$('customer-filter-dialog').close();
 $('customer-filter-form').onsubmit=event=>{event.preventDefault();customerGridFilters=Object.fromEntries(new FormData($('customer-filter-form')));$('customer-filter-dialog').close();renderTable();};
 const clear=()=>{customerGridFilters={};$('customer-filter-form').reset();renderTable();};$('customer-filter-reset').onclick=clear;$('customer-clear-filters').onclick=clear;
}
if(typeof module!=='undefined')module.exports={customerMatchesFilters,profileFinance};

function renderActivationCosts(main,data){
 const costs=data.costs,summary=el('div',undefined,'profile-finance-summary');
 for(const[label,value]of [['Issued inventory (net)',costs.inventory_cost],['Additional costs (paid + pending)',costs.additional_cost],['Recorded activation cost',costs.total]]){const card=el('div');card.append(el('small',label),el('strong','PKR '+money(value)));summary.append(card);}main.append(summary);
 const stock=profilePanel('Inventory cost breakdown','Unit costs are captured when items are issued. Returned stock is excluded from net cost.');
 profileSearchTable(stock,['Issue','Item','Quantity','Unit cost (PKR)','Cost (PKR)','Employee','Date','Status','Cost basis'],costs.issues,i=>[`ISS-${i.id}`,i.item,i.quantity,money(i.unit_cost_at_issue??0),money(i.cost),i.employee_name,i.issue_date,profileBadge(i.status),i.cost_estimated?'Historical estimate':'Saved at issue']);main.append(stock);
 const expenses=profilePanel('Additional activation expenses','Only expenses explicitly allocated to this customer. Cancelled entries are excluded from totals.',canCreate('Expenses')?[profileAction('+ Add activation expense',()=>customerRecordAction('Expenses',data.customer))]:[]);
 profileSearchTable(expenses,['Expense','Title','Category','Amount (PKR)','Status','Expense date'],costs.expenses,e=>[`EXP-${e.id}`,e.title,e.category,money(e.amount),profileBadge(e.status),e.expense_date]);main.append(expenses);
 main.append(el('p',`Returned inventory value: PKR ${money(costs.returned_cost)}. Historical estimated issues: ${costs.estimated_issues}. Unpriced outstanding issues: ${costs.unpriced_issues}.`,'profile-footnote'));
 main.append(el('p',`Recurring monthly package cost: ${costs.monthly_package_cost===null?'Not linked to a package':'PKR '+money(costs.monthly_package_cost)}. Recurring costs and customer selling fees are separate from the activation total. Totals cover only recorded stock issues and allocated expenses.`,'profile-footnote'));
}

async function portalStaffRequest(route,payload){const response=await fetch('/api/customer-portal/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify(payload)}),data=await response.json();if(!response.ok)throw Error(data.error||'Request failed.');return data;}
async function manageCustomerApp(customer){if(!confirm('Create or reset app access for '+customer.name+'? Existing customer app sessions will be signed out.'))return;try{const data=await portalStaffRequest('access',{customer_id:customer.id}),dialog=el('dialog'),close=profileAction('Close',()=>{dialog.close();dialog.remove();});dialog.append(el('h2','Customer app access'),el('p','Portal: '+location.origin+'/customer/'),el('p','Customer ID: '+customer.payment_id),el('p','Temporary password: '+data.temporary_password),el('p','Share these details privately. The customer must choose a new password on first sign-in.'),close);document.body.append(dialog);dialog.showModal();}catch(e){showError(e);}}
function notifyCustomerApp(customer){const dialog=el('dialog'),form=el('form'),title=el('input'),message=el('textarea'),error=el('p');title.placeholder='Notification title';title.setAttribute('aria-label','Notification title');title.maxLength=150;title.required=true;message.placeholder='Message for the customer';message.setAttribute('aria-label','Notification message');message.maxLength=2000;message.required=true;const save=el('button','Send notification'),close=el('button','Cancel','secondary');close.type='button';close.onclick=()=>{dialog.close();dialog.remove();};form.append(el('h2','Notify '+customer.name),title,message,error,save,close);form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{await portalStaffRequest('notify',{customer_id:customer.id,title:title.value,body:message.value});dialog.close();dialog.remove();}catch(e){error.textContent=e.message;save.disabled=false;}};dialog.append(form);document.body.append(dialog);dialog.showModal();}

function renderCustomerLedger(main,data){const ledger=data.ledger??{entries:[],balance:0,debits:0,credits:0};const panel=profilePanel('Customer ledger','Dated account activity. Monthly invoice charges, service charges and installation are debited once; carried balances are not added again. Positive balance = amount owed; negative = account credit. All recorded dates included.');const summary=el('div',undefined,'profile-finance-summary');for(const [label,value]of [['Charges',ledger.debits],['Payments',ledger.credits],['Closing balance',ledger.balance]]){const card=el('div');card.append(el('small',label),el('strong','PKR '+money(value)));summary.append(card);}panel.append(summary);profileSearchTable(panel,['Date','Reference','Description','Debit (PKR)','Credit (PKR)','Running balance'],ledger.entries,e=>[e.date,e.reference,e.description,money(e.debit),money(e.credit),money(e.balance)],'Search ledger...');main.append(panel);}
function renderCustomerPaymentHistory(main,data){const panel=profilePanel('Payment history','Every confirmed receipt for this customer, including monthly bills, installation and service payments.');profileSearchTable(panel,['Receipt','Date','Billing month','Revenue','Method','Reference','Amount (PKR)'],data.records.Payments,p=>{const receipt=el('a','RCP-'+p.id);receipt.href='/receipt?id='+p.id;receipt.target='_blank';receipt.rel='noopener';return [receipt,p.payment_date,p.billing_month,p.revenue_type==='OTC'?'OTC / '+p.otc_type:'MRC',p.method,p.reference||'-',money(p.amount)];},'Search payment history...');main.append(panel);}
function renderCustomerServices(main,data){const panel=profilePanel('Extra services & charges','Services appear on the invoice for the month of the service date. Collections are recorded separately as OTC Service, preserving MRC billing.',canCreate('Payments')?[profileAction('+ Add service charge',()=>addCustomerService(data.customer),'profile-primary')]:[]);profileSearchTable(panel,['Service date','Description','Charge','Paid','Due','Added by','Actions'],data.services??[],s=>[s.service_date,s.description,money(s.amount),money(s.paid),money(s.due),s.created_by,canCreate('Payments')&&Number(s.due)>0?profileAction('Record payment',()=>payCustomerService(data.customer,s)):'-'],'Search services...');main.append(panel);}
function addCustomerService(customer){const dialog=el('dialog'),form=el('form'),error=el('p');form.append(el('h2','Add service charge - '+customer.name));for(const [name,label,type,value]of [['description','Service / equipment description','text',''],['service_date','Service date (sets invoice month)','date',today()],['amount','Customer selling price (PKR)','number','']]){const wrap=el('label',label),input=el('input');input.name=name;input.type=type;input.value=value;input.required=true;if(type==='number'){input.min='.01';input.step='.01';input.max='1000000000';}if(name==='description')input.maxLength=300;wrap.append(input);form.append(wrap);}const save=el('button','Save service charge'),cancel=el('button','Cancel','secondary');cancel.type='button';cancel.onclick=()=>{dialog.close();dialog.remove();};form.append(error,save,cancel);const key=crypto.randomUUID();form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{const response=await fetch('/api/customer-services',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify({customer_id:customer.id,request_key:key,...Object.fromEntries(new FormData(form))})}),result=await response.json();if(!response.ok)throw Error(result.error||'Could not save service.');dialog.close();dialog.remove();await refreshCustomerProfile();}catch(e){error.textContent=e.message;save.disabled=false;}};dialog.append(form);document.body.append(dialog);dialog.showModal();}
function payCustomerService(customer,service){openEditor(null,'Payments');const fields=$('form').elements;for(const [name,value]of [['customer_id',customer.id],['billing_month',service.service_date.slice(0,7)],['revenue_type','OTC'],['otc_type',service.charge_type||'Service']]){const input=fields.namedItem(name);input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));}fields.namedItem('amount').value=Number(service.due).toFixed(2);fields.namedItem('reference').value='SVC-'+service.id+' '+service.description;const hidden=el('input');hidden.type='hidden';hidden.name='service_charge_id';hidden.value=service.id;$('fields').append(hidden);$('form-title').textContent='Service payment - '+customer.name;}
