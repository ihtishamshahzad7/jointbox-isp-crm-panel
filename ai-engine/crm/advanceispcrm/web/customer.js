'use strict';
function customerExpiry(joined){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(joined))return '';
 const day=new Date(joined+'T00:00:00Z');if(Number.isNaN(day.getTime())||day.toISOString().slice(0,10)!==joined)return '';
 day.setUTCDate(day.getUTCDate()+30);return day.toISOString().slice(0,10);
}
function setupCustomerEditor(row){
 const fields=$('form').elements,joined=fields.namedItem('joined'),expiry=fields.namedItem('expiry_date');
 const installation=fields.namedItem('installation_charge');if(installation)installation.addEventListener('input',()=>{installation.dataset.manual='yes';});
 let automatic=customerExpiry(joined.value);if(!row)expiry.value=automatic;
 expiry.min=joined.value;
 joined.onchange=()=>{const next=customerExpiry(joined.value);if(!expiry.value||expiry.value===automatic)expiry.value=next;automatic=next;expiry.min=joined.value;};
 const note=el('p','Expiry defaults to 30 days after the creation date. You can choose a different date; manually adjusted expiry dates are preserved.','expense-note full-field');$('fields').append(note);
 if(typeof setupCustomerLocation==='function')setupCustomerLocation();
 if(typeof attachCustomerUploads==='function')attachCustomerUploads();
}
function printCustomerInvoice(customer){window.open('/invoice?customer='+encodeURIComponent(customer.id),'_blank','noopener');}
if(typeof module!=='undefined')module.exports={customerExpiry};

function rechargeCustomer(customer){
 if(!canCreate('Payments'))return;
 const month=today().slice(0,7);
 const paid=state.records.Payments.filter(p=>p.revenue_type!=='OTC'&&p.customer_id===customer.id&&p.billing_month===month).reduce((n,p)=>n+Number(p.amount),0);
 openEditor(null,'Payments');
 const fields=$('form').elements;fields.namedItem('customer_id').value=customer.id;fields.namedItem('customer_id').dispatchEvent(new Event('change',{bubbles:true}));
 fields.namedItem('billing_month').value=month;
 fields.namedItem('amount').value=Math.max(0,Number(customer.monthly_fee)-paid).toFixed(2);
 $('form-title').textContent='Recharge customer - '+customer.name;
 const context=el('div',undefined,'customer-ticket-context full-field');
 const updateContext=()=>{const selected=state.records.Customers.find(c=>String(c.id)===fields.namedItem('customer_id').value);context.replaceChildren();if(!selected)return;$('form-title').textContent='Recharge customer - '+selected.name;const received=state.records.Payments.filter(p=>p.revenue_type!=='OTC'&&p.customer_id===selected.id&&p.billing_month===fields.namedItem('billing_month').value).reduce((n,p)=>n+Number(p.amount),0);context.append(el('strong',selected.name),el('p',`Username: ${selected.username} | Payment ID: ${selected.payment_id}`),el('p',`Monthly fee: Rs ${money(selected.monthly_fee)} | Received for selected month: Rs ${money(received)}`));};
 fields.namedItem('customer_id').addEventListener('change',updateContext);fields.namedItem('billing_month').addEventListener('change',updateContext);updateContext();
 $('fields').prepend(context);fields.namedItem('amount').focus();
}
function setupPaymentEditor(row){
 const fields=$('form').elements;
 const revenue=fields.namedItem('revenue_type');for(const option of revenue.options)option.textContent=option.value==='OTC'?'OTC - One-time charges (router, inventory, installation)':'MRC - Monthly bill';
 const purpose=fields.namedItem('otc_type');if(purpose)purpose.closest('label').hidden=revenue.value!=='OTC';
 const online=['1LINK','Easypaisa','JazzCash'];
 const method=fields.namedItem('method');
 if(!row||!online.includes(row.method))for(const option of [...method.options])if(online.includes(option.value))option.remove();
 const lookup=el('input');lookup.type='text';lookup.inputMode='numeric';lookup.maxLength=9;lookup.placeholder='Enter the 9-digit customer payment ID';lookup.setAttribute('aria-label','Customer payment ID');
 const label=el('label','Customer payment ID lookup');label.append(lookup);$('fields').prepend(label);
 const customerSelect=fields.namedItem('customer_id');
 customerSelect.addEventListener('change',()=>{const customer=state.records.Customers.find(c=>String(c.id)===customerSelect.value);lookup.value=customer?.payment_id??'';lookup.setCustomValidity('');});
 lookup.oninput=()=>{const customer=state.records.Customers.find(c=>c.payment_id===lookup.value.trim());if(customer){customerSelect.value=String(customer.id);lookup.setCustomValidity('');}else{customerSelect.value='';lookup.setCustomValidity(lookup.value?'No customer matches this 9-digit payment ID.':'');}const typed=lookup.value;customerSelect.dispatchEvent(new Event('change',{bubbles:true}));if(!customer)lookup.value=typed;lookup.setCustomValidity(!customer&&typed?'No customer matches this 9-digit payment ID.':'');};
 if(row)lookup.value=state.records.Customers.find(c=>c.id===row.customer_id)?.payment_id??'';
 fields.namedItem('amount').min='0.01';fields.namedItem('payment_date').max=today();
 const quote=el('p','Select a customer to see the amount due.','expense-note full-field');$('fields').append(quote);
 if(!row&&['Administrator','Manager','Accountant'].includes(state.user.role)){
  const label=el('label','If payment is less than the full amount due','full-field');const choice=el('select');choice.id='partial-activation-choice';
  for(const [value,text]of [['no','Keep account unchanged until fully paid'],['yes','Activate now and carry unpaid amount to next bill']]){const option=el('option',text);option.value=value;choice.append(option);}label.append(choice);$('fields').append(label);
 }
 let quoteVersion=0,amountTouched=false,quoteContext='',lastDue=null;
 const amountInput=fields.namedItem('amount');amountInput.placeholder='Automatically filled from amount due';
 const useDue=el('button','Use amount due','secondary');useDue.type='button';useDue.disabled=true;useDue.hidden=Boolean(row);
 useDue.onclick=()=>{if(lastDue!==null){amountInput.value=Number(lastDue).toFixed(2);amountTouched=false;}};
 amountInput.closest('label').append(useDue);
 amountInput.addEventListener('input',()=>{amountTouched=true;});
 const updateQuote=async()=>{const id=customerSelect.value,month=fields.namedItem('billing_month').value,version=++quoteVersion,context=id+'|'+month+'|'+revenue.value+'|'+(purpose?.value??'Other');if(context!==quoteContext){quoteContext=context;amountTouched=false;lastDue=null;useDue.disabled=true;if(!row)amountInput.value='';}if(revenue.value==='OTC'&&purpose?.value!=='Installation'){quote.textContent='OTC: enter the one-time amount and describe the router, inventory, installation or other charge in Reference. This does not pay the monthly bill or activate the connection.';return;}if(!id||!month){quote.textContent='Select a customer to see the amount due.';return;}quote.textContent='Loading amount due...';try{const response=await fetch(`/api/customers/${id}/billing?month=${encodeURIComponent(month)}`);const data=await response.json();if(version!==quoteVersion||!quote.isConnected||!$('editor').open)return;if(!response.ok)throw Error(data.error||'Could not load billing.');if(revenue.value==='OTC'){quote.textContent=`Installation charge: Rs ${money(data.installation_charge)} | Received: Rs ${money(data.installation_paid)} | Installation due: Rs ${money(data.installation_due)}. This payment is separate from the monthly bill.`;lastDue=Number(data.installation_due);}else{quote.textContent=`Monthly charge: Rs ${money(data.charge)} | Previous unpaid balance: Rs ${money(data.previous_balance)} | Already received: Rs ${money(data.paid)} | Amount due: Rs ${money(data.due)}. Full payment activates automatically; partial activation carries the unpaid amount to the next bill.`;if(Number(data.service_due)>0)quote.textContent+=` Extra services due: Rs ${money(data.service_due)}. Collect these separately from the service rows in customer Finance.`;lastDue=Number(data.due);}useDue.disabled=false;if(!row&&!amountTouched)amountInput.value=lastDue.toFixed(2);}catch(error){if(version===quoteVersion)quote.textContent=error.message;}};
 const updateRevenue=()=>{const otc=revenue.value==='OTC',choice=$('partial-activation-choice');if(choice){choice.closest('label').hidden=otc;choice.disabled=otc;if(otc)choice.value='no';}if(purpose){purpose.closest('label').hidden=!otc;if(!otc)purpose.value='Other';}fields.namedItem('reference').required=otc;fields.namedItem('reference').placeholder=otc?'Router / inventory / installation description':'Optional transaction reference';updateQuote();};revenue.addEventListener('change',updateRevenue);
 if(purpose)purpose.addEventListener('change',updateQuote);customerSelect.addEventListener('change',updateQuote);fields.namedItem('billing_month').addEventListener('change',updateQuote);queueMicrotask(()=>{if(customerSelect.value&&quoteVersion===0)updateQuote();});
 const note=el('p','Record only money you have confirmed receiving. For the current billing month, receipts covering the monthly charge plus previous unpaid balance automatically activate the customer and renew expiry by 30 days from today or the existing expiry, whichever is later. One renewal per billing month. Earlier/later billing months are recorded without activation. Saved payment receipts cannot be edited or deleted.','expense-note full-field');
 $('fields').append(note);$('save').textContent=row?'Save payment':'Save confirmed payment';
 const gatewayNote=el('p','Cash and card payments are confirmed manually here. 1LINK, Easypaisa and JazzCash receipts use the customer payment ID through a configured, verified payment integration. The receipt bridge alone does not connect a merchant account.','expense-note full-field');$('fields').append(gatewayNote);
 if(row){for(const input of $('fields').querySelectorAll('input,select,textarea'))input.disabled=true;$('save').hidden=true;}

}

function recordInstallationPayment(customer){
 if(!canCreate('Payments'))return;
 openEditor(null,'Payments');const fields=$('form').elements;for(const [name,value]of [['customer_id',customer.id],['revenue_type','OTC'],['otc_type','Installation']]){const input=fields.namedItem(name);input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));}fields.namedItem('reference').value='Installation charges';$('form-title').textContent='Installation payment - '+customer.name;
}
