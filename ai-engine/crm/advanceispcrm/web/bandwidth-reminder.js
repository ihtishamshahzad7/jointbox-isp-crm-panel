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

// Operations > Bandwidth peaks: graph of the peak taken each month per provider, with cost and month-on-month change.
let bandwidthChartMetric='peak';
function bandwidthPeakChart(rows){
 const peaks=rows.map(r=>({provider:r.data.provider,month:r.data.month,peak:Number(r.data.peak_mbps||0),price:Number(r.data.price_per_mbps||0)})).filter(p=>p.provider&&/^\d{4}-\d{2}$/.test(p.month||''));
 const panel=el('section',undefined,'bandwidth-chart');panel.append(el('h3','Bandwidth peak by month'));
 if(!peaks.length){panel.append(el('p','No peaks entered yet. Add the peak Mbps and price per Mbps for each provider every month to see the graph.','ops-note'));return panel;}
 const months=[...new Set(peaks.map(p=>p.month))].sort().slice(-12),providers=[...new Set(peaks.map(p=>p.provider))].sort(),colors=['#2563b5','#14a37f','#c2563f','#8a5cd1','#d18b1f'];
 const metrics={peak:['Peak Mbps',p=>p.peak,v=>money(v)+' Mbps'],cost:['Monthly cost',p=>p.peak*p.price,v=>'Rs '+money(v)],price:['Price per Mbps',p=>p.price,v=>'Rs '+money(v)]};
 const find=(m,provider)=>peaks.find(p=>p.month===m&&p.provider===provider),label=m=>new Date(m+'-01T00:00:00Z').toLocaleDateString('en-GB',{month:'short',year:'2-digit',timeZone:'UTC'});
 const toggles=el('div',undefined,'bandwidth-chart-toggles'),chart=el('div',undefined,'bandwidth-chart-svg');
 const draw=()=>{const [title,value,format]=metrics[bandwidthChartMetric];
  for(const b of toggles.children){b.className=b.dataset.metric===bandwidthChartMetric?'admin-tab selected':'admin-tab';b.setAttribute('aria-pressed',String(b.dataset.metric===bandwidthChartMetric));}
  const W=760,H=280,left=70,right=16,top=24,bottom=44,plotW=W-left-right,plotH=H-top-bottom,max=Math.max(1,...peaks.filter(p=>months.includes(p.month)).map(value))*1.15;
  const svg=svgElement('svg',{viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':`${title} per provider by month`,class:'bandwidth-svg'});
  for(let i=0;i<=4;i++){const y=top+plotH-i*plotH/4;svg.append(svgElement('line',{x1:left,y1:y,x2:W-right,y2:y,class:'daily-chart-grid'}));svg.append(svgElement('text',{x:left-8,y:y+4,'text-anchor':'end',class:'daily-axis-label'},money(Math.round(max*i/4))));}
  const group=plotW/months.length,bar=Math.min(46,(group-14)/providers.length);
  months.forEach((m,i)=>{const x0=left+i*group+(group-bar*providers.length)/2;
   providers.forEach((provider,j)=>{const p=find(m,provider);if(!p)return;const v=value(p),h=v/max*plotH,x=x0+j*bar,y=top+plotH-h;
    const rect=svgElement('rect',{x:x+1,y,width:Math.max(2,bar-2),height:Math.max(v>0?2:0,h),rx:3,fill:colors[j%colors.length]});rect.append(svgElement('title',{},`${provider} · ${label(m)}\nPeak ${money(p.peak)} Mbps × Rs ${money(p.price)} = Rs ${money(p.peak*p.price)}`));svg.append(rect);
    if(bar>=18)svg.append(svgElement('text',{x:x+bar/2,y:y-5,'text-anchor':'middle',class:'bandwidth-bar-label'},bandwidthChartMetric==='peak'?money(v):money(Math.round(v))));});
   svg.append(svgElement('text',{x:left+i*group+group/2,y:H-bottom+18,'text-anchor':'middle',class:'daily-axis-label'},label(m)));});
  const legend=el('div',undefined,'bandwidth-legend');providers.forEach((provider,j)=>{const item=el('span');const dot=el('i');dot.style.background=colors[j%colors.length];item.append(dot,document.createTextNode(provider));legend.append(item);});
  chart.replaceChildren(svg,legend);};
 for(const [key,[title]] of Object.entries(metrics)){const b=el('button',title);b.type='button';b.dataset.metric=key;b.onclick=()=>{bandwidthChartMetric=key;draw();};toggles.append(b);}
 // Month-by-month table, newest first, with the change in peak from the provider's previous month.
 const details=el('details',undefined,'bandwidth-chart-table'),wrap=el('div',undefined,'table-wrap'),table=el('table'),head=el('tr');
 for(const h of ['Month','Provider','Peak (Mbps)','Price per Mbps (Rs)','Monthly cost (Rs)','Change in peak'])head.append(el('th',h));table.append(el('thead'),el('tbody'));table.tHead.append(head);
 for(const p of [...peaks].sort((a,b)=>b.month.localeCompare(a.month)||a.provider.localeCompare(b.provider))){const previous=peaks.filter(q=>q.provider===p.provider&&q.month<p.month).sort((a,b)=>b.month.localeCompare(a.month))[0];
  const change=previous?(p.peak-previous.peak):null,row=el('tr');
  for(const v of [label(p.month),p.provider,money(p.peak),money(p.price),money(p.peak*p.price),change===null?'First entry':`${change>0?'+':''}${money(change)} Mbps (${previous.peak?(change/previous.peak*100).toFixed(1)+'%':'—'})`])row.append(el('td',v));table.tBodies[0].append(row);}
 wrap.append(table);details.append(el('summary','Peak history by month'),wrap);details.open=true;
 panel.append(toggles,chart,details,el('p','Monthly cost = peak Mbps × price per Mbps. Hover over a bar for its details. The graph shows the latest 12 months entered.','ops-note'));draw();return panel;
}