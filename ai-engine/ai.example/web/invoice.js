'use strict';
const byId=id=>document.getElementById(id);
const currency=value=>Number(value).toLocaleString('en-PK',{minimumFractionDigits:2,maximumFractionDigits:2});
const formatDate=value=>new Date(value+'T00:00:00Z').toLocaleDateString('en-PK',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
const params=new URLSearchParams(location.search);
let customerId=Number(params.get('customer'));
byId('billing-month').value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit'}).format(new Date()).slice(0,7);
async function request(path,options){const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw Error(data.error||'Could not load invoice.');return data;}
async function loadInvoice(invoiceId=null){
 byId('load-invoice').disabled=true;byId('print').disabled=true;byId('invoice').hidden=true;byId('message').hidden=false;byId('message').textContent='Preparing invoice...';
 try{
  if(!invoiceId){
   if(!Number.isSafeInteger(customerId)||customerId<=0)throw Error('Open an invoice from the customer list.');
   const session=await request('/api/auth/status');if(!session.user)throw Error('Sign in to the CRM, then reopen this invoice.');
   const saved=await request('/api/invoices',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':session.token},body:JSON.stringify({customer_id:customerId,billing_month:byId('billing-month').value})});invoiceId=saved.id;
  }
  const result=await request('/api/invoices/'+encodeURIComponent(invoiceId)),invoice=result.invoice;customerId=invoice.customer_id;
  byId('billing-month').value=invoice.billing_month;
  const values={'number':invoice.invoice_number,'customer-name':invoice.customer_name,'address':invoice.address,'phone':invoice.phone,'username':invoice.username,'month':new Date(invoice.billing_month+'-01T00:00:00Z').toLocaleDateString('en-PK',{timeZone:'UTC',month:'long',year:'numeric'}),'issued':formatDate(invoice.issue_date),'due':formatDate(invoice.due_date),'customer-id':invoice.customer_id,'package':invoice.package_name,'charge':currency(invoice.amount),'total':currency(invoice.amount),'paid':currency(result.paid),'balance':currency(result.balance),'credit':currency(result.credit)};
  values['service-total']=currency(result.services?.amount??0);
  const lines=byId('service-lines');lines.replaceChildren();for(const service of result.services?.items??[]){const row=document.createElement('tr');for(const value of [service.description,formatDate(service.service_date),currency(service.amount)]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}lines.append(row);}
  values['payment-id']=invoice.payment_id;values['previous-balance']=currency(result.previous_balance??0);values['bill-total']=currency(result.total??invoice.amount);
  for(const[id,value]of Object.entries(values))byId(id).textContent=value;
  const [year,month]=invoice.billing_month.split('-').map(Number),last=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
  byId('period').textContent=formatDate(invoice.billing_month+'-01')+' – '+formatDate(last);
  byId('payment-status').textContent=result.balance===0?'PAID':result.paid>0?'PARTIALLY PAID':'UNPAID';
  byId('credit-label').hidden=byId('credit').hidden=result.credit<=0;
  byId('receipt-note').textContent='Payments shown are receipts recorded for '+values.month+'.';
  byId('snapshot-note').textContent='Subscription details are preserved from the first issue. Extra service charges are listed by service month. Previous unpaid balance and payments reflect the current ledger; carried balances are not charged twice.';
  document.title=invoice.invoice_number+' | '+invoice.customer_name;
  history.replaceState(null,'','/invoice?id='+invoice.id);
  byId('invoice').hidden=false;byId('message').hidden=true;byId('print').disabled=false;
 }catch(error){byId('message').textContent=error.message;}
 finally{byId('load-invoice').disabled=false;}
}
byId('month-form').onsubmit=event=>{event.preventDefault();loadInvoice();};
byId('print').onclick=()=>window.print();
loadInvoice(params.get('id'));
