'use strict';
// Admin > System & activity: database size, who is online, sign-in history and the full activity log.
let systemTab='Overview';
const systemFmt={
 bytes(n){if(n==null)return '—';const units=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<units.length-1){n/=1024;i++;}return `${n.toFixed(i?1:0)} ${units[i]}`;},
 time(v){if(!v)return '—';const d=typeof v==='number'?new Date(v*1000):new Date(v);return d.toLocaleString('en-PK',{timeZone:'Asia/Karachi',dateStyle:'medium',timeStyle:'short'});},
 ago(v){if(!v)return 'Never';const s=Math.max(0,(Date.now()-new Date(v))/1000);return s<60?'Just now':s<3600?`${Math.floor(s/60)} min ago`:s<86400?`${Math.floor(s/3600)} h ago`:`${Math.floor(s/86400)} days ago`;},
 device(agent){if(!agent)return '—';const os=/Android/.test(agent)?'Android':/iPhone|iPad/.test(agent)?'iPhone/iPad':/Windows/.test(agent)?'Windows':/Mac OS/.test(agent)?'Mac':/Linux/.test(agent)?'Linux':'Other';const browser=/Edg\//.test(agent)?'Edge':/Chrome\//.test(agent)?'Chrome':/Firefox\//.test(agent)?'Firefox':/Safari\//.test(agent)?'Safari':'Browser';return `${browser} · ${os}`;}
};
async function systemRequest(params){const response=await fetch('/api/admin/system?'+new URLSearchParams(params));const result=await response.json();if(!response.ok)throw Error(result.error||'Could not load system activity.');return result;}
function systemTable(headers,rows){const wrap=el('div',undefined,'table-wrap system-table'),table=el('table'),head=el('tr');head.append(...headers.map(h=>el('th',h)));table.append(el('thead'),el('tbody'));table.tHead.append(head);for(const cells of rows){const tr=el('tr');tr.append(...cells.map(c=>c instanceof Node?(()=>{const td=el('td');td.append(c);return td;})():el('td',c==null||c===''?'—':String(c))));table.tBodies[0].append(tr);}if(!rows.length){const tr=el('tr'),td=el('td','Nothing recorded yet.');td.colSpan=headers.length;tr.append(td);table.tBodies[0].append(tr);}wrap.append(table);return wrap;}
function systemCard(label,value,note){const card=el('div',undefined,'system-card');card.append(el('span',label),el('strong',value),...(note?[el('small',note)]:[]));return card;}
function openSystemPanel(){
 let dialog=$('system-dialog');
 if(!dialog){dialog=el('dialog',undefined,'system-dialog');dialog.id='system-dialog';const head=el('div',undefined,'system-head'),title=el('h2','System & activity'),close=el('button','Close','secondary');close.type='button';close.onclick=()=>dialog.close();const tabs=el('div',undefined,'system-tabs');tabs.id='system-tabs';const body=el('div',undefined,'system-body');body.id='system-body';head.append(title,close);dialog.append(head,tabs,body);document.body.append(dialog);}
 dialog.showModal();systemRender();
}
function systemRender(){
 const tabs=$('system-tabs');tabs.replaceChildren();
 for(const name of ['Overview','Login history','Activity log']){const b=el('button',name,name===systemTab?'admin-tab selected':'admin-tab');b.type='button';b.setAttribute('aria-pressed',String(name===systemTab));b.onclick=()=>{systemTab=name;systemRender();};tabs.append(b);}
 const body=$('system-body');body.replaceChildren(el('p','Loading…','expense-note'));
 (systemTab==='Overview'?systemOverview(body):systemActivity(body,systemTab==='Login history'?'logins':'')).catch(error=>body.replaceChildren(el('p',error.message,'error')));
}
async function systemOverview(body){
 const d=await systemRequest({part:'overview'});body.replaceChildren();
 const cards=el('div',undefined,'system-cards');
 cards.append(systemCard('Database size',systemFmt.bytes(d.database_bytes),d.last_backup?`Last backup ${systemFmt.time(d.last_backup.at)} (${systemFmt.bytes(d.last_backup.bytes)})`:'No backups found'),
  systemCard('Online now',String(d.online.length),`Active in the last ${d.online_minutes} minutes · ${d.active_sessions} signed-in sessions`),
  systemCard('Signed in today',String(d.today.people??0),`${d.today.sign_ins??0} sign-ins · ${d.today.failed??0} failed attempts`),
  systemCard('Changes today',String(d.today.changes??0),'Records created, edited or deleted'));
 body.append(cards);
 body.append(el('h3','Online now'),systemTable(['Name','Username','Role','Signed in','Last active','Device','IP address'],d.online.map(o=>[o.name,o.username,o.role,systemFmt.time(o.signed_in),systemFmt.ago(o.last_seen),systemFmt.device(o.user_agent),o.ip])));
 body.append(el('h3','Users'),systemTable(['Name','Username','Role','Rights','Status','Last sign-in','Total sign-ins','Last active',''],d.users.map(u=>{const b=el('button','Activity','secondary');b.type='button';b.onclick=()=>{systemTab='Activity log';systemFilters.user=String(u.id);systemRender();};return [u.name,u.username,u.role,u.custom_rights?'Custom':'Role default',u.status,systemFmt.time(u.last_sign_in),u.sign_ins,systemFmt.ago(u.last_seen),b];})));
 body.append(el('h3','Records'),systemTable(['What','Count'],Object.entries(d.counts).map(([k,v])=>[k,Number(v).toLocaleString('en-PK')])));
 body.append(el('h3','Largest tables'),systemTable(['Table','Size','Approx. rows'],d.tables.map(t=>[t.name,systemFmt.bytes(t.bytes),Math.max(0,t.rows).toLocaleString('en-PK')])));
}
const systemFilters={user:'',q:'',from:'',to:''};
async function systemActivity(body,kind){
 const users=(await systemRequest({part:'overview'})).users;
 const form=el('form',undefined,'system-filters'),user=el('select'),q=el('input'),from=el('input'),to=el('input'),go=el('button','Apply'),exp=el('button','Export CSV','secondary');
 user.append(new Option('All users',''),...users.map(u=>new Option(`${u.name} (${u.username})`,String(u.id))));user.value=systemFilters.user;user.setAttribute('aria-label','User');
 q.type='search';q.placeholder='Search action, page, record, details or IP';q.value=systemFilters.q;q.setAttribute('aria-label','Search');
 from.type=to.type='date';from.value=systemFilters.from;to.value=systemFilters.to;from.setAttribute('aria-label','From date');to.setAttribute('aria-label','To date');
 exp.type='button';form.append(user,q,from,to,go,exp);
 const out=el('div');body.replaceChildren(form,out);
 let rows=[];
 const load=async()=>{Object.assign(systemFilters,{user:user.value,q:q.value.trim(),from:from.value,to:to.value});out.replaceChildren(el('p','Loading…','expense-note'));
  rows=(await systemRequest({part:'activity',kind,limit:kind==='logins'?1000:500,...Object.fromEntries(Object.entries(systemFilters).filter(([,v])=>v))})).activity;
  const headers=kind==='logins'?['Time','User','Event','Result','Device','IP address']:['Time','User','Action','Page','Record','Details','Result','IP address'];
  const result=r=>r.status==null?'—':r.status<300?'OK':r.status===403?'Denied':`Error ${r.status}`;
  out.replaceChildren(el('p',`${rows.length} entries${rows.length>=(kind==='logins'?1000:500)?' (newest shown; narrow the filters to see older ones)':''}`,'expense-note'),
   systemTable(headers,rows.map(r=>kind==='logins'?[systemFmt.time(r.at),r.username,r.action,result(r),systemFmt.device(r.user_agent),r.ip]:[systemFmt.time(r.at),r.username||'—',r.action,r.section,r.record_id,r.detail,result(r),r.ip])));};
 form.onsubmit=event=>{event.preventDefault();load().catch(error=>out.replaceChildren(el('p',error.message,'error')));};
 exp.onclick=()=>{const cols=['at','username','action','section','record_id','detail','status','ip','user_agent','path'];const csv=[cols.join(','),...rows.map(r=>cols.map(c=>`"${String(r[c]??'').replaceAll('"','""')}"`).join(','))].join('\r\n');const a=el('a');a.href=URL.createObjectURL(new Blob(['﻿'+csv],{type:'text/csv'}));a.download=`activity-log-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(a.href);};
 await load();
}
