'use strict';
// Month-end reminder: from the last 3 days of a month until the 7th of the next, finance roles are asked to enter
// the peak and price per Mbps of every bandwidth provider in use that has none for that month yet.
function bandwidthReminderMonth(day=today()){
 const d=new Date(day+'T00:00:00Z'),last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
 if(d.getUTCDate()>=last-2)return day.slice(0,7);
 if(d.getUTCDate()<=7)return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()-1,1)).toISOString().slice(0,7);
 return null;
}
function missingBandwidthPeaks(records,month){
 const packages=records.Packages??[],providers=['Transworld Bandwidth','Nayatel bandwidth'];
 const used=new Set((records.Customers??[]).filter(c=>c.status!=='Terminated').map(c=>packages.find(p=>p.id===c.package_id)?.service_provider).filter(p=>providers.includes(p)));
 return [...used].filter(p=>!(records['Bandwidth peaks']??[]).some(r=>r.month===month&&r.provider===p)).sort();
}
function renderBandwidthReminder(){
 document.getElementById('bandwidth-reminder')?.remove();
 if(!state?.user||!['Administrator','Manager','Accountant'].includes(state.user.role))return;
 const month=bandwidthReminderMonth(),missing=month?missingBandwidthPeaks(state.records,month):[];
 let snoozed=false;try{snoozed=sessionStorage.getItem('bandwidth-reminder')===month+missing.join();}catch{}
 if(!missing.length||snoozed)return;
 const label=new Date(month+'-01T00:00:00Z').toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'});
 const box=el('div',undefined,'bandwidth-reminder');box.id='bandwidth-reminder';box.setAttribute('role','alert');
 const text=el('p');text.append(el('strong',`Month end: enter ${label} bandwidth peaks. `),document.createTextNode(`Still missing for ${missing.join(' and ')}. Package costs and profit for these providers use the peak and price per Mbps.`));
 const enter=el('button','Enter now'),later=el('button','Remind me later','secondary');
 enter.type=later.type='button';
 enter.onclick=async()=>{operationsModule='Bandwidth peaks';await openOperations();opsEditor(null,{provider:missing[0],month},'Bandwidth peaks');};
 later.onclick=()=>{try{sessionStorage.setItem('bandwidth-reminder',month+missing.join());}catch{}box.remove();};
 const actions=el('div');actions.append(enter,later);box.append(text,actions);
 document.querySelector('main>header')?.after(box);
}
// Packages list: a bandwidth package's cost from the latest peak entered for its provider.
function packagePeakCostLabel(row){
 if(typeof billCostModel!=='function'||!['Transworld Bandwidth','Nayatel bandwidth'].includes(row.service_provider))return null;
 const peak=(state.records['Bandwidth peaks']??[]).filter(r=>r.provider===row.service_provider).sort((a,b)=>b.month.localeCompare(a.month))[0];
 if(!peak||!Number(peak.sold_mbps))return null;
 const cost=Number(peak.peak_mbps)*Number(row.speed_mbps||0)/Number(peak.sold_mbps)*Number(peak.price_per_mbps);
 return `Rs ${money(cost)} per customer (${peak.month} peak)`;
}
if(typeof module!=='undefined')module.exports={bandwidthReminderMonth,missingBandwidthPeaks};
