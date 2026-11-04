'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function element(tag='input',text=''){
 return {tag,textContent:text,children:[],value:'',isConnected:true,listeners:{},options:[],
  append(...nodes){this.children.push(...nodes);},prepend(...nodes){this.children.unshift(...nodes);},
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);},
  dispatch(type){for(const fn of this.listeners[type]??[])fn();},
  closest(){return this.label??=(element('label'));},setAttribute(){},setCustomValidity(){},remove(){}};
}
const inputs=Object.fromEntries(['otc_type','reference','revenue_type','customer_id','billing_month','amount','method','payment_date'].map(name=>[name,element()]));
inputs.otc_type.value='Other';inputs.revenue_type.value='MRC';inputs.method.options=[{value:'Cash'}];inputs.billing_month.value='2026-10';
const nodes={form:{elements:{namedItem:name=>inputs[name]}},fields:element('section'),save:element('button'),editor:{open:true}};
const pending=[];
const context={$:id=>nodes[id],el:element,state:{user:{role:'Administrator'},records:{Customers:[{id:1,payment_id:'123456789'},{id:2,payment_id:'987654321'}]}},today:()=> '2026-10-19',money:String,queueMicrotask,fetch:url=>new Promise(resolve=>pending.push({url,resolve}))};
vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../web/customer.js'),'utf8'),context);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const respond=(request,due)=>request.resolve({ok:true,json:async()=>({charge:2000,previous_balance:1200,paid:0,due})});
(async()=>{
 // Programmatic selection before the queued initialization must also fill the due.
 context.setupPaymentEditor(null);inputs.customer_id.value='1';await flush();assert.equal(pending.length,1);
 respond(pending.shift(),3200);await flush();assert.equal(inputs.amount.value,'3200.00');
 inputs.amount.value='1000';inputs.amount.dispatch('input');assert.equal(inputs.amount.value,'1000');
 // A different billing month loads fresh due, while typing during the request is preserved.
 inputs.billing_month.value='2026-11';inputs.billing_month.dispatch('change');
 inputs.amount.value='500';inputs.amount.dispatch('input');respond(pending.shift(),4500);await flush();assert.equal(inputs.amount.value,'500');
 const reset=inputs.amount.closest().children.find(n=>n.textContent==='Use amount due');reset.onclick();assert.equal(inputs.amount.value,'4500.00');
 // An old response must not fill the next customer's field.
 inputs.customer_id.value='2';inputs.customer_id.dispatch('change');const stale=pending.shift();
 inputs.billing_month.value='2026-12';inputs.billing_month.dispatch('change');const latest=pending.shift();
 respond(latest,2000);await flush();respond(stale,9999);await flush();assert.equal(inputs.amount.value,'2000.00');
 inputs.revenue_type.value='OTC';inputs.revenue_type.dispatch('change');assert.equal(pending.length,0);
 inputs.otc_type.value='Installation';inputs.otc_type.dispatch('change');pending.shift().resolve({ok:true,json:async()=>({installation_charge:2000,installation_paid:500,installation_due:1500})});await flush();assert.equal(inputs.amount.value,'1500.00');assert.equal(inputs.reference.required,true);
 console.log('PASS: automatic selection/arrears amount, editable partial amount, reset to due and stale-response protection.');
})().catch(error=>{console.error(error);process.exitCode=1;});
