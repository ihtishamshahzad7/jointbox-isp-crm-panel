'use strict';
// Invoice files attached to inventory batches and expenses.
let editorInvoiceInput=null;
function invoiceFilesToPayload(files){
 return Promise.all([...files].map(file=>new Promise((done,fail)=>{
  if(file.size>5*1024*1024){fail(Error(file.name+' is larger than 5 MB.'));return;}
  const reader=new FileReader();reader.onload=()=>done({name:file.name,content:String(reader.result).split(',')[1]});reader.onerror=()=>fail(Error('Could not read '+file.name+'.'));reader.readAsDataURL(file);
 })));
}
async function invoiceRequest(body){
 const response=await fetch('/api/attachments',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify(body)}),result=await response.json();
 if(!response.ok)throw Error(result.error||'Could not save the invoice.');return result;
}
async function uploadInvoices(section,recordId,files,wholeBatch=false){
 if(!files?.length)return 0;if(files.length>5)throw Error('Attach up to 5 invoice files at a time.');
 return (await invoiceRequest({section,record_id:recordId,files:await invoiceFilesToPayload(files),whole_batch:wholeBatch})).uploaded;
}
function invoiceFileInput(){const input=el('input');input.type='file';input.multiple=true;input.accept='.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';return input;}
// Optional "Attach invoice" box in the inventory and expense forms; files upload right after the record saves.
function setupInvoiceField(){
 const label=el('label','Attach invoice (optional)','full-field');editorInvoiceInput=invoiceFileInput();editorInvoiceInput.setAttribute('aria-label','Invoice files');
 label.append(editorInvoiceInput,el('small','PDF, JPG, PNG or WebP · up to 5 files · 5 MB each','grid-username'));$('fields').append(label);
}
async function uploadEditorInvoices(section,recordId){
 if(!['Inventory','Expenses'].includes(section)||!editorInvoiceInput?.isConnected||!editorInvoiceInput.files.length||!recordId)return;
 const files=[...editorInvoiceInput.files];editorInvoiceInput=null;
 try{await uploadInvoices(section,recordId,files);}catch(error){showError(Error('Saved, but the invoice was not uploaded: '+error.message));}
}
async function openInvoices(section,row){
 const dialog=el('dialog',undefined,'invoice-dialog'),head=el('div',undefined,'dialog-heading'),list=el('div',undefined,'invoice-list'),error=el('p',undefined,'form-error'),canWrite=can('write',section);
 error.setAttribute('role','alert');head.append(el('h2','Invoices'),profileAction('Close',()=>dialog.close()));
 // Assets are Operations records: their fields sit in row.data.
 const asset=section==='Assets'?row.data:null,batchNo=asset?asset.batch:row.batch;
 dialog.append(head,el('p',asset?`${asset.name}${asset.serial?' · Serial '+asset.serial:''}${asset.batch?' · Batch '+asset.batch:''}`:section==='Inventory'?`${row.item}${row.batch?' · Batch '+row.batch:''}`:`${row.title} · Rs ${money(row.amount)}`,'expense-note'),list);
 const refresh=async()=>{
  list.replaceChildren(el('p','Loading…','expense-note'));
  try{const response=await fetch(`/api/attachments/${encodeURIComponent(section)}/${row.id}`),data=await response.json();if(!response.ok)throw Error(data.error||'Could not load invoices.');
   list.replaceChildren();if(!data.invoices.length)list.append(el('p','No invoices attached yet.','expense-note'));
   for(const invoice of data.invoices){const line=el('div',undefined,'document-row'),link=el('a',invoice.original_name);link.href='/api/attachment-files/'+invoice.id;link.target='_blank';link.rel='noopener';
    line.append(link,el('small',`${Math.max(1,Math.round(invoice.byte_size/1024))} KB · ${new Date(invoice.uploaded_at).toLocaleDateString('en-PK')} · ${invoice.uploaded_by_name}`));
    if(canWrite&&state.user.role==='Administrator'){const remove=el('button','Delete','danger');remove.type='button';remove.onclick=async()=>{if(!confirm('Delete '+invoice.original_name+'?'))return;try{await invoiceRequest({action:'delete',id:invoice.id});row.invoice_count=Math.max(0,(row.invoice_count||1)-1);await refresh();}catch(e){error.textContent=e.message;}};line.append(remove);}
    list.append(line);}
  }catch(e){list.replaceChildren();error.textContent=e.message;}
 };
 if(canWrite){const form=el('form',undefined,'invoice-upload'),input=invoiceFileInput(),button=el('button','Upload invoice');input.required=true;input.setAttribute('aria-label','Invoice files');form.append(input,button);
  // An inventory or asset invoice can go on every record of the same batch at once.
  const batchItems=!batchNo?[]:section==='Inventory'?(state.records.Inventory??[]).filter(i=>i.batch===row.batch):section==='Assets'&&typeof operationsState!=='undefined'?operationsState.records.filter(r=>r.module==='Assets'&&r.data.batch===batchNo):[],whole=el('input');whole.type='checkbox';
  if(batchItems.length>1){const label=el('label',undefined,'invoice-whole-batch');label.append(whole,document.createTextNode(` Attach to all ${batchItems.length} ${asset?'assets':'items'} in batch ${batchNo}`));form.append(label);}
  form.onsubmit=async event=>{event.preventDefault();button.disabled=true;error.textContent='';try{const added=await uploadInvoices(section,row.id,input.files,whole.checked);if(whole.checked)for(const i of batchItems)i.invoice_count=(i.invoice_count||0)+added;else row.invoice_count=(row.invoice_count||0)+added;input.value='';await refresh();}catch(e){error.textContent=e.message;}finally{button.disabled=false;}};
  dialog.append(el('p','PDF, JPG, PNG or WebP · up to 5 files · 5 MB each.','expense-note'),form);}
 dialog.append(error);dialog.addEventListener('close',()=>{dialog.remove();render();},{once:true});document.body.append(dialog);dialog.showModal();await refresh();
}
