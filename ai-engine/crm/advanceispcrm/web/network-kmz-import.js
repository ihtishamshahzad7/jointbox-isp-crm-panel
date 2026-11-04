'use strict';
// Upload KMZ/KML: the server reads the pins and lines, you choose what each one is, then they are added to the network map.
async function networkKmzRequest(body){const response=await fetch('/api/network-kmz',{method:'POST',headers:{'Content-Type':'application/json','X-CRM-Token':state.token},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error||'The KMZ request failed.');return result;}
function networkFileBase64(file){return new Promise((done,fail)=>{const reader=new FileReader();reader.onload=()=>done(String(reader.result).split(',')[1]||'');reader.onerror=()=>fail(Error('The file could not be read.'));reader.readAsDataURL(file);});}
function networkUploadKmz(){
 const d=opsDialog('Upload KMZ'),body=opsElement('div'),file=opsElement('input'),error=opsElement('p',undefined,'ops-error');
 d.classList.add('ops-dialog-wide');file.type='file';file.accept='.kmz,.kml,application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml';file.setAttribute('aria-label','KMZ or KML file');
 body.append(opsElement('p','Choose a KMZ or KML file, for example one exported from Google Earth. You will see every pin and line first, choose what each one is, and only then add them to the map. Nothing is taken from stock.','ops-note'),file,error);
 d.append(body);d.showModal();
 file.onchange=async()=>{error.textContent='';const f=file.files[0];if(!f)return;if(f.size>15*1024*1024){error.textContent='Use a file smaller than 15 MB.';return;}
  file.disabled=true;const reading=opsElement('p','Reading '+f.name+'…','ops-note');body.append(reading);
  try{const result=await networkKmzRequest({action:'preview',file:await networkFileBase64(f)});reading.remove();networkKmzReview(d,body,f.name,result);}
  catch(e){reading.remove();error.textContent=e.message;file.disabled=false;}};
}
function networkKmzReview(d,body,fileName,result){
 const requestKey=crypto.randomUUID(),items=result.items,points=items.filter(i=>i.kind==='point'),lines=items.filter(i=>i.kind==='line');
 const select=(options,value,label)=>{const s=opsElement('select');s.setAttribute('aria-label',label);s.dataset.noSearch='';for(const [v,t]of options)s.append(new Option(t,v));s.value=value;return s;};
 const pointTypes=[['POP','POP'],...result.device_types.map(t=>[t,t==='Other'?'Other device':t]),['Skip','Skip (do not import)']];
 const cableTypes=[['','Choose'],...result.cable_types.map(t=>[t,t])],statuses=[['','Choose'],...result.statuses.map(t=>[t,t])];
 const summary=`${fileName}: ${points.length} pins and ${lines.length} lines found`+(result.polygons_skipped?`, ${result.polygons_skipped} shapes (areas) ignored`:'')+(items.some(i=>i.duplicate)?'. Items already on your map are set to Skip.':'.');
 // Defaults: the zone for POPs, and cable details applied to every line.
 const zones=operationsState.records.filter(r=>r.module==='Zones'&&r.state!=='Archived'),zone=select([['','Choose zone'],...zones.map(z=>[z.id,opsRecordName(z)]),['new','+ New zone…']],zones.length===1?String(zones[0].id):zones.length?'':'new','Zone for imported POPs');
 const newZone=opsElement('input');newZone.placeholder='New zone name, e.g. Topi';newZone.maxLength=150;newZone.setAttribute('aria-label','New zone name');newZone.hidden=zone.value!=='new';zone.addEventListener('change',()=>{newZone.hidden=zone.value!=='new';if(!newZone.hidden)newZone.focus();});
 const cableDefault=select(cableTypes,'Distribution','Default cable type'),statusDefault=select(statuses,'Active','Default cable status'),coresDefault=opsElement('input');
 coresDefault.type='number';coresDefault.min='1';coresDefault.step='1';coresDefault.placeholder='e.g. 12';coresDefault.setAttribute('aria-label','Default core count');
 const label=(text,input)=>{const l=opsElement('label',text);l.append(input);return l;},defaults=opsElement('div',undefined,'ops-form');
 if(points.length){const z=label('Zone for imported POPs',zone);z.append(newZone);defaults.append(z);}
 if(lines.length)defaults.append(label('Cable type',cableDefault),label('Cable status',statusDefault),label('Core count',coresDefault));
 const rows=[],table=opsElement('table'),head=opsElement('tr'),tbody=opsElement('tbody'),thead=opsElement('thead');
 for(const h of ['Name','Folder','What it is','Cable type','Status','Cores','Note'])head.append(opsElement('th',h));thead.append(head);table.append(thead,tbody);
 for(const item of items){
  const tr=opsElement('tr'),type=select(item.kind==='point'?pointTypes:[['Fiber cable','Fiber cable'],['Skip','Skip (do not import)']],item.type,'What '+item.name+' is');
  const cable=item.kind==='line'?select(cableTypes,item.cable_type||'Distribution','Cable type for '+item.name):null,status=item.kind==='line'?select(statuses,item.status||'Active','Status for '+item.name):null;
  const cores=item.kind==='line'?opsElement('input'):null;if(cores){cores.type='number';cores.min='1';cores.step='1';cores.value=item.cores??'';cores.setAttribute('aria-label','Cores for '+item.name);}
  const cell=node=>{const td=opsElement('td');if(node)td.append(node);return td;};
  const note=[item.kind==='line'?(item.length_m>=1000?(item.length_m/1000).toFixed(2)+' km':item.length_m+' m')+' line':'Pin',item.duplicate?'Already on map':'',item.simplified?'Long line thinned to 1000 points':''].filter(Boolean).join(' · ');
  tr.append(opsElement('td',item.name),opsElement('td',item.folder||'—'),cell(type),cell(cable),cell(status),cell(cores),opsElement('td',note));tbody.append(tr);rows.push({item,type,cable,status,cores});
 }
 const apply=opsButton('Apply cable details to all lines',()=>{for(const r of rows)if(r.cable){r.cable.value=cableDefault.value;r.status.value=statusDefault.value;if(coresDefault.value)r.cores.value=coresDefault.value;}});
 const error=opsElement('p',undefined,'ops-error'),save=opsButton('',async()=>{error.textContent='';
  const chosen=rows.filter(r=>r.type.value!=='Skip');if(!chosen.length){error.textContent='Every item is set to Skip. Choose what to import.';return;}
  if(chosen.some(r=>r.type.value==='POP')&&(!zone.value||zone.value==='new'&&!newZone.value.trim())){error.textContent='Choose the zone for imported POPs, or type a new zone name.';return;}
  const missing=chosen.filter(r=>r.cable&&(!r.cable.value||!r.status.value||!(Number(r.cores.value)>0)));if(missing.length){error.textContent=`${missing.length} line(s) need a cable type, status and core count, for example ${missing[0].item.name}. Fill them in, or use "Apply cable details to all lines".`;return;}
  save.disabled=true;save.textContent='Importing…';
  try{const out=await networkKmzRequest({action:'import',request_key:requestKey,zone:zone.value&&zone.value!=='new'?Number(zone.value):null,new_zone:zone.value==='new'?newZone.value.trim():'',items:chosen.map(r=>({...r.item,type:r.type.value,cable_type:r.cable?.value,status:r.status?.value,cores:r.cores?Number(r.cores.value):null}))});
   d.close();await openOperations();$('notice').textContent=`Imported from ${fileName}: ${out.created.POPs} POPs, ${out.created.devices} devices and ${out.created.cables} fiber cables.`;$('notice').hidden=false;}
  catch(e){error.textContent=e.message;save.disabled=false;count();}},true);
 const count=()=>{const n=rows.filter(r=>r.type.value!=='Skip').length;save.textContent=`Add ${n} item${n===1?'':'s'} to the map`;};
 for(const r of rows)r.type.addEventListener('change',count);count();
 const wrap=opsElement('div',undefined,'table-wrap network-kmz-table');wrap.append(table);
 body.replaceChildren(opsElement('p',summary,'ops-note'),defaults,...(lines.length?[apply]:[]),wrap,error,save);
}
