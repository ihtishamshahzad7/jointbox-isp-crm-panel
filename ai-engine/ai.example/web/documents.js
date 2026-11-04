'use strict';
const CUSTOMER_DOCUMENT_TYPES=['Identity - front','Identity - back','Application form','Installation photo','Agreement','Other'];
let documentCustomer=null;
function canManageCustomerDocuments(){return ['Administrator','Manager','Support'].includes(state?.user?.role);}
function documentTypeOptions(select){for(const value of CUSTOMER_DOCUMENT_TYPES){const option=el('option',value);option.value=value;select.append(option);}select.value='Other';}
function attachCustomerUploads(){
 if(!canManageCustomerDocuments())return;
 const section=el('section',undefined,'customer-upload full-field');section.append(el('h3','Add customer documents (optional)'));
 const typeLabel=el('label','Document type'),type=el('select');type.id='customer-document-type';documentTypeOptions(type);typeLabel.append(type);
 const fileLabel=el('label','Select documents'),files=el('input');files.id='customer-document-files';files.type='file';files.multiple=true;files.accept='.pdf,.jpg,.jpeg,.png,.webp';fileLabel.append(files);
 const selected=el('p','No files selected','expense-note');files.onchange=()=>{selected.textContent=Array.from(files.files).map(f=>`${f.name} (${(f.size/1024).toFixed(0)} KB)`).join(' · ')||'No files selected';};
 section.append(typeLabel,fileLabel,selected,el('p','PDF, JPG, PNG, or WebP · up to 5 files · 5 MB each · 20 MB total. Documents are saved with this customer.','expense-note'));$('fields').append(section);
}
async function prepareDocuments(files,type){
 const selected=Array.from(files??[]);if(selected.length>5)throw Error('Choose up to 5 documents.');
 if(selected.some(f=>f.size===0||f.size>5*1024*1024))throw Error('Each document must contain data and be at most 5 MB.');
 if(selected.reduce((n,f)=>n+f.size,0)>20*1024*1024)throw Error('Documents must total at most 20 MB.');
 const result=[];
 for(const file of selected){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));result.push({name:file.name,document_type:type,content:btoa(binary)});}return result;
}
async function customerFormDocuments(){const input=$('customer-document-files');return input?prepareDocuments(input.files,$('customer-document-type').value):[];}
async function documentRequest(path,options){const response=await fetch(path,options);const result=await response.json();if(response.status===401)await startAuth();if(!response.ok)throw Error(result.error||'Document operation failed.');return result;}
async function refreshCustomerDocuments(){
 $('document-list').replaceChildren(el('p','Loading documents...','expense-note'));
 const result=await documentRequest(`/api/customers/${documentCustomer.id}/documents`);
 $('document-list').replaceChildren();
 if(!result.documents.length)$('document-list').append(el('p','No documents uploaded for this customer yet.','expense-note'));
 for(const record of result.documents){const row=el('div',undefined,'document-row'),copy=el('div');copy.append(el('strong',record.original_name),el('small',`${record.document_type} · ${(record.byte_size/1024).toFixed(0)} KB · ${new Date(record.uploaded_at).toLocaleDateString('en-PK',{timeZone:'Asia/Karachi'})}`));
  const actions=el('div',undefined,'document-actions'),download=el('a','Download','document-download');download.href='/api/customer-documents/'+record.id;download.download=record.original_name;
  const remove=el('button','Delete','danger');remove.type='button';remove.onclick=async()=>{if(!confirm(`Delete ${record.original_name}?`))return;remove.disabled=true;try{await documentRequest('/api/customer-documents',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify({action:'delete',id:record.id})});await refreshCustomerDocuments();if(typeof refreshCustomerProfile==='function')await refreshCustomerProfile();}catch(error){$('document-error').textContent=error.message;remove.disabled=false;}};actions.append(download,remove);row.append(copy,actions);$('document-list').append(row);
 }
}
async function openCustomerDocuments(customer){
 documentCustomer=customer;$('document-title').textContent='Documents · '+customer.name;$('document-customer').textContent=`${customer.username} · Payment ID ${customer.payment_id}`;$('document-error').textContent='';$('document-form').reset();$('documents-dialog').showModal();try{await refreshCustomerDocuments();if(typeof refreshCustomerProfile==='function')await refreshCustomerProfile();}catch(error){$('document-list').replaceChildren();$('document-error').textContent=error.message;}
}
function setupDocumentControls(){
 documentTypeOptions($('manage-document-type'));
 $('documents-close').onclick=()=>$('documents-dialog').close();
 $('document-form').onsubmit=async event=>{event.preventDefault();$('document-save').disabled=true;$('document-error').textContent='';try{
  const files=await prepareDocuments($('manage-document-files').files,$('manage-document-type').value);if(!files.length)throw Error('Choose at least one document.');
  await documentRequest('/api/customer-documents',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify({customer_id:documentCustomer.id,documents:files})});$('document-form').reset();await refreshCustomerDocuments();if(typeof refreshCustomerProfile==='function')await refreshCustomerProfile();
 }catch(error){$('document-error').textContent=error.message;}finally{$('document-save').disabled=false;}};
}
