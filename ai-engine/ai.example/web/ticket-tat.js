'use strict';
function ticketTiming(ticket,now=Date.now()){
 const start=Date.parse(ticket.created_at),due=Date.parse(ticket.due_at),closed=['Resolved','Closed'].includes(ticket.status);
 const end=closed?Date.parse(ticket.resolved_at):now;
 if(!Number.isFinite(due)||!Number.isFinite(end))return {label:'No precise target',elapsed:'Not available',tone:''};
 const minutes=Math.max(0,Math.ceil(Math.abs(due-end)/60000));
 const duration=`${Math.floor(minutes/60)}h ${minutes%60}m`;
 const elapsed=Number.isFinite(start)?Math.max(0,Math.floor((end-start)/60000)):null;
 return {label:closed?(end<=due?'Resolved within TAT':'TAT breached by '+duration):(end>due?'Overdue by '+duration:duration+' remaining'),tone:end>due?'danger':closed?'good':'',elapsed:elapsed===null?'Not available':`${Math.floor(elapsed/60)}h ${elapsed%60}m`};
}
function ticketTatCell(ticket){
 const timing=ticketTiming(ticket),node=el('div',undefined,'ticket-tat');node.dataset.ticketId=ticket.id;
 node.append(el('strong',timing.label,'tat-'+timing.tone),el('small','Due: '+(ticket.due_at?new Date(ticket.due_at).toLocaleString('en-PK',{timeZone:'Asia/Karachi',dateStyle:'medium',timeStyle:'short'})+' PKT':ticket.due_date)),el('small',`Target: ${ticket.tat_hours??24}h | Elapsed: ${timing.elapsed}`));return node;
}
function setupTicketTat(row){
 const wrapper=el('label','Turnaround target (hours)'),input=el('input');input.type='number';input.name='tat_hours';input.min='1';input.max='720';input.step='1';input.required=true;
 const defaults={Urgent:2,High:4,Normal:24,Low:48};const priority=$('form').elements.namedItem('priority');const type=$('form').elements.namedItem('type');const configured=()=>state.tat_settings?.find(r=>r.ticket_type===type.value&&r.priority===priority.value)?.hours??defaults[priority.value]??24;input.value=row?.tat_hours??configured();
 const preview=el('small',undefined,'tat-preview');wrapper.append(input,preview);$('fields').append(wrapper);
 let touched=false;
 const update=()=>{const hours=Number(input.value),start=row?Date.parse(row.created_at):Date.now();const due=row&&hours===Number(row.tat_hours)&&row.due_at?new Date(row.due_at):new Date(start+hours*3600000);if(!Number.isFinite(due.getTime()))return;
 preview.textContent='Due: '+due.toLocaleString('en-PK',{timeZone:'Asia/Karachi',dateStyle:'medium',timeStyle:'short'})+' PKT';
 const date=$('form').elements.namedItem('due_date');date.closest('label').hidden=true;if(!row||hours!==Number(row.tat_hours))date.value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(due);};
 input.oninput=()=>{touched=true;update();};for(const field of [priority,type])field.addEventListener('change',()=>{if(!row&&!touched){input.value=configured();update();}});update();
 $('fields').append(el('p','TAT runs continuously from ticket creation, including nights, weekends and time awaiting the customer. Defaults follow Admin > Ticket TAT for the selected type and priority. You can override this ticket target. Reopening keeps the original deadline.','expense-note full-field'));
 if(row){const panel=el('div',undefined,'full-field');panel.append(ticketTatCell(row));$('fields').append(panel);}
}
if(typeof module!=='undefined')module.exports={ticketTiming};

if(typeof document!=='undefined')setInterval(()=>{
 if(typeof state==='undefined'||!state)return;
 for(const node of document.querySelectorAll('.ticket-tat[data-ticket-id]')){const ticket=state.records.Tickets.find(t=>String(t.id)===node.dataset.ticketId);if(ticket)node.replaceWith(ticketTatCell(ticket));}
},60000);
