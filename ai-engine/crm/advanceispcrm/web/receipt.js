'use strict';
const byId=id=>document.getElementById(id);
byId('print').onclick=()=>window.print();
(async()=>{
 try{
  const id=new URLSearchParams(location.search).get('id');
  if(!/^[1-9][0-9]*$/.test(id??''))throw Error('Open a receipt from Payments or the customer Finance tab.');
  const response=await fetch('/api/receipts/'+encodeURIComponent(id));const data=await response.json();
  if(!response.ok)throw Error(data.error||'Could not load receipt.');
  const r=data.receipt;
  const fields={'receipt-number':r.receipt_number,'customer-name':r.customer_name,address:r.address,phone:r.phone,username:r.username,'payment-id':r.payment_id,'payment-record':'PAY-'+r.payment_record_id,'payment-date':r.payment_date,'billing-month':r.billing_month,'revenue-type':r.revenue_type==='OTC'?'OTC - '+(r.otc_type||'Other'):'MRC - Monthly bill',method:r.method,reference:r.reference||'Not provided','recorded-by':r.recorded_by,package:r.package_name,amount:Number(r.amount).toLocaleString('en-PK',{minimumFractionDigits:2,maximumFractionDigits:2}),'customer-status':r.customer_status,expiry:r.expiry_date,activation:r.imported?'':r.partial_activation?`Staff approved partial activation. Unpaid PKR ${Number(r.outstanding_amount).toLocaleString('en-PK')} carries forward to the next bill.`:r.activated?'This payment completed the monthly recharge and activated the CRM account.':'Payment recorded. This receipt did not trigger a new account renewal.','saved-at':'Receipt saved: '+new Date(r.saved_at).toLocaleString('en-PK',{timeZone:'Asia/Karachi'})+' PKT','snapshot-note':r.imported?'Historical payment receipt. Customer details and account status were captured when receipts were added to the system.':'Permanent receipt. Customer and payment details were captured when this payment was saved.'};
  for(const [id,value]of Object.entries(fields))byId(id).textContent=value;
  document.title=r.receipt_number+' | ISP CRM';byId('receipt').hidden=false;byId('message').hidden=true;byId('print').disabled=false;
 }catch(error){byId('message').textContent=error.message;}
})();
