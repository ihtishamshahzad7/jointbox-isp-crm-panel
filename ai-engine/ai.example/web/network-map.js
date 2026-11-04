'use strict';
// City map for placing POPs, devices and fiber routes. Tiles load from OpenStreetMap and Esri; records stay local.
const NETWORK_STATUS_COLORS={Planned:'#2f80ed',Active:'#3cae1f',Damaged:'#e53935',Retired:'#888888'};
const NETWORK_TYPE_COLORS={'POP':'#7b3fe4','Data center (DC)':'#1d2b3a','Router':'#c2185b','OLT':'#f2994a','Switch':'#8d6e63','FDT':'#00897b','FAT':'#26c6da','Distribution box':'#fbc02d','Splitter':'#5c6bc0','Joint closure':'#6d4c41','Other':'#78909c'};
const NETWORK_TYPE_RADIUS={'POP':10,'Data center (DC)':11,'Router':8,'OLT':8,'Switch':7,'FDT':7,'FAT':6,'Distribution box':6,'Splitter':5,'Joint closure':5,'Other':6};
const NETWORK_CUSTOMER_STYLES={active:{color:'#1e7d32',fillColor:'#43a047'},other:{color:'#666',fillColor:'#bbb'}};
function networkPoints(text){return String(text||'').replaceAll(';','\n').split('\n').map(l=>l.trim()).filter(Boolean).map(l=>l.replaceAll(',',' ').split(/\s+/).map(Number)).filter(p=>p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=90&&Math.abs(p[1])<=180);}
function networkLength(points){let total=0;for(let i=1;i<points.length;i++){const [a,b]=points[i-1].map(v=>v*Math.PI/180),[c,d]=points[i].map(v=>v*Math.PI/180);total+=2*6371008.8*Math.asin(Math.sqrt(Math.sin((c-a)/2)**2+Math.cos(a)*Math.cos(c)*Math.sin((d-b)/2)**2));}return total>=1000?(total/1000).toFixed(2)+' km':total.toFixed(1)+' m';}
function networkTooltip(title,lines){const box=opsElement('div');box.append(opsElement('strong',title));for(const line of lines.filter(Boolean))box.append(document.createElement('br'),document.createTextNode(line));return box;}
function networkTiles(map){
 const imagery='https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/';
 const streets=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:20,maxNativeZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
 const satellite=L.tileLayer(imagery+'tile/{z}/{y}/{x}',{maxZoom:20,maxNativeZoom:19,attribution:'Imagery © Esri'});
 map.setMaxZoom(20);
 // Past the deepest real imagery Esri serves "Map data not yet available" tiles. Ask its tile map which
 // level exists at the map centre and enlarge that level instead.
 const known=new Map();let check=0;
 const exists=async(level,lat,lng)=>{
  const n=2**level,x=Math.floor((lng+180)/360*n),r=lat*Math.PI/180,y=Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*n),key=level+'/'+y+'/'+x;
  if(!known.has(key)){try{const result=await (await fetch(imagery+'tilemap/'+key+'/1/1')).json();known.set(key,!result.valid||result.data?.[0]!==0);}catch{known.set(key,true);}}
  return known.get(key);
 };
 const fit=async()=>{
  if(!map.hasLayer(satellite))return;
  const id=++check,zoom=Math.round(map.getZoom()),{lat,lng}=map.getCenter();
  let level=Math.min(zoom,19);
  if(zoom>=16)while(level>15&&!await exists(level,lat,lng))level--;
  if(id!==check||level===satellite.options.maxNativeZoom||zoom<16&&satellite.options.maxNativeZoom===19)return;
  // The layer must recompute its tile level too; redraw alone keeps the old level and fetches tiles from the wrong place.
  satellite.options.maxNativeZoom=zoom<16?19:level;satellite._resetView();satellite.redraw();
 };
 map.on('zoomend moveend baselayerchange',fit);
 return {Streets:streets,Satellite:satellite};
}
function networkBaseMap(container,options={}){
 const map=L.map(container),bounds=L.latLngBounds([]),base=networkTiles(map);
 // Focusing a marker can scroll the map's clipped container, which misaligns every layer.
 container.addEventListener('scroll',()=>{container.scrollTop=0;container.scrollLeft=0;});
 const layers={fiber:L.layerGroup().addTo(map),pops:L.layerGroup().addTo(map),devices:L.layerGroup().addTo(map),customers:L.layerGroup().addTo(map)};
 const records=operationsState.records.filter(r=>r.state!=='Archived'),names=new Map(records.map(r=>[r.id,opsRecordName(r)]));
 const dot=(lat,lng,color,radius,tooltip,layer,row)=>{const p=[Number(lat),Number(lng)];bounds.extend(p);const m=L.circleMarker(p,{color:'#fff',fillColor:color,radius,weight:2,fillOpacity:.95,bubblingMouseEvents:!(row&&options.onRecord)}).bindTooltip(tooltip);if(row&&options.onRecord)m.on('click',e=>options.onRecord(row,e.latlng));layer.addLayer(m);return m;};
 for(const r of records.filter(r=>r.module==='Fiber segments'&&r.id!==options.exclude)){
  const points=networkPoints(r.data.route);points.forEach(p=>bounds.extend(p));
  const line=L.polyline(points,{color:NETWORK_STATUS_COLORS[r.data.status]||'#555',weight:5,opacity:.85,bubblingMouseEvents:!options.onRecord}).bindTooltip(networkTooltip(opsRecordName(r),[r.data.status+' · '+r.data.cable_type+' · '+r.data.core_count+' cores',networkLength(points),[names.get(r.data.from_device),names.get(r.data.to_device)].filter(Boolean).join(' → ')]),{sticky:true});
  if(options.onRecord)line.on('click',e=>options.onRecord(r,e.latlng));layers.fiber.addLayer(line);
 }
 for(const r of records.filter(r=>r.module==='POPs'&&r.data.latitude!=null&&r.id!==options.exclude))dot(r.data.latitude,r.data.longitude,NETWORK_TYPE_COLORS.POP,NETWORK_TYPE_RADIUS.POP,networkTooltip(opsRecordName(r),[r.data.address]),layers.pops,r);
 for(const r of records.filter(r=>r.module==='Network devices'&&r.data.latitude!=null&&r.id!==options.exclude))dot(r.data.latitude,r.data.longitude,NETWORK_TYPE_COLORS[r.data.type]||NETWORK_TYPE_COLORS.Other,NETWORK_TYPE_RADIUS[r.data.type]||6,networkTooltip(opsRecordName(r),[r.data.type,r.data.host,names.get(r.data.pop)]),layers.devices,r);
 for(const c of (state.records.Customers||[]).filter(c=>c.latitude!=null&&c.latitude!==''))dot(c.latitude,c.longitude,NETWORK_CUSTOMER_STYLES[c.status==='Active'?'active':'other'].fillColor,4,networkTooltip((c.payment_id?c.payment_id+' · ':'')+c.name,[c.username,c.status,c.area]),layers.customers);
 L.control.layers(base,{'Fiber routes':layers.fiber,POPs:layers.pops,'Network devices':layers.devices,Customers:layers.customers},{collapsed:false}).addTo(map);
 if(bounds.isValid())map.fitBounds(bounds,{padding:[30,30],maxZoom:16});else map.setView([31.5204,74.3587],12);
 setTimeout(()=>map.invalidateSize(),60);
 return {map,layers};
}
function networkLegend(){
 const box=opsElement('div',undefined,'network-legend'),item=(label,color,cls)=>{const span=opsElement('span'),swatch=opsElement('i',undefined,cls);swatch.style.background=color;span.append(swatch,document.createTextNode(label));box.append(span);};
 for(const [label,color]of Object.entries(NETWORK_STATUS_COLORS))item(label+' cable',color,'network-swatch');
 for(const [label,color]of Object.entries(NETWORK_TYPE_COLORS))item(label,color,'network-dot');
 item('Customer',NETWORK_CUSTOMER_STYLES.active.fillColor,'network-dot');
 return box;
}
// Maps inside forms use the browser's own full screen, which shows the map above the open form.
function networkFormFullscreen(map,wrap){
 const toggle=()=>{if(document.fullscreenElement===wrap)document.exitFullscreen();else wrap.requestFullscreen?.().catch(()=>{});};
 const control=L.control({position:'topleft'});control.onAdd=()=>{const b=L.DomUtil.create('a','network-fullscreen-control');b.href='#';b.title='Full screen';b.setAttribute('role','button');b.setAttribute('aria-label','Full screen');b.textContent='⛶';L.DomEvent.on(b,'click',e=>{L.DomEvent.stop(e);toggle();});const bar=L.DomUtil.create('div','leaflet-bar');bar.append(b);return bar;};control.addTo(map);
 wrap.addEventListener('fullscreenchange',()=>{const on=document.fullscreenElement===wrap;for(const b of wrap.querySelectorAll('.network-fullscreen-control,.network-fullscreen-button')){const text=b.classList.contains('network-fullscreen-control')?(on?'✕':'⛶'):(on?'✕ Exit full screen':'⛶ Full screen');b.textContent=text;b.title=on?'Exit full screen':'Full screen';}setTimeout(()=>map.invalidateSize(),80);});
 return toggle;
}
function networkRouteEditor(textarea,row){
 const wrap=opsElement('div',undefined,'network-route-editor ops-full'),box=opsElement('div',undefined,'network-map'),tools=opsElement('div',undefined,'ops-toolbar'),info=opsElement('strong',undefined,'network-route-length');
 let points=networkPoints(textarea.value);
 const save=()=>{textarea.value=points.map(([a,b])=>a.toFixed(7)+', '+b.toFixed(7)).join('\n');draw();};
 tools.append(opsButton('Undo last point',()=>{points.pop();save();}),opsButton('Clear route',()=>{points=[];save();}),info);
 wrap.append(opsElement('p','Click along the street where the cable is laid. Click a POP or device to start or end exactly on it, and drag a point to adjust it. Switch to Satellite to follow the actual path.','ops-note'),box,tools,networkLegend());
 textarea.closest('label').before(wrap);
 const {map,layers}=networkBaseMap(box,{exclude:row?.id}),line=L.polyline([],{color:'#0b7da3',weight:5,dashArray:'8 6'}).addTo(map),handles=L.layerGroup().addTo(map);
 const full=opsButton('⛶ Full screen',networkFormFullscreen(map,wrap));full.classList.add('network-fullscreen-button');info.before(full);
 function draw(){
  line.setLatLngs(points);handles.clearLayers();
  points.forEach((p,i)=>{const handle=L.marker(p,{draggable:true,keyboard:false,icon:L.divIcon({className:'network-route-handle'+(i===0||i===points.length-1?' network-route-end':''),iconSize:[14,14]})});handle.on('drag',e=>{const ll=e.target.getLatLng();points[i]=[ll.lat,ll.lng];line.setLatLngs(points);});handle.on('dragend',save);handles.addLayer(handle);});
  info.textContent=points.length+' points · '+networkLength(points);
 }
 const add=latlng=>{points.push([latlng.lat,latlng.lng]);save();};
 map.on('click',e=>add(e.latlng));
 for(const group of [layers.pops,layers.devices,layers.customers])group.eachLayer(marker=>marker.on('click',()=>add(marker.getLatLng())));
 textarea.addEventListener('input',()=>{points=networkPoints(textarea.value);draw();});
 draw();if(points.length>1)map.fitBounds(line.getBounds(),{padding:[40,40]});
}
function networkLocationPicker(form,row){
 const lat=form.elements.namedItem('latitude'),lng=form.elements.namedItem('longitude'),type=form.elements.namedItem('type');
 const wrap=opsElement('div',undefined,'network-route-editor ops-full'),box=opsElement('div',undefined,'network-map network-map-small'),info=opsElement('p',undefined,'ops-note');
 wrap.append(opsElement('p','Click the map to pin the exact location, or drag the pin. Switch to Satellite to see the building.','ops-note'),box,info);
 lat.closest('label').before(wrap);
 const {map}=networkBaseMap(box,{exclude:row?.id});let pin=null;
 networkFormFullscreen(map,wrap);
 const color=()=>type?NETWORK_TYPE_COLORS[type.value]||NETWORK_TYPE_COLORS.Other:NETWORK_TYPE_COLORS.POP;
 // The teardrop is rotated on an inner element; rotating the icon itself would also rotate Leaflet's positioning.
 const icon=()=>L.divIcon({className:'network-pin',html:'<span class="network-pin-shape"></span>',iconSize:[24,24],iconAnchor:[12,24]});
 const paint=()=>{pin.getElement().firstChild.style.background=color();};
 const show=(point,center)=>{if(!pin){pin=L.marker(point,{draggable:true,keyboard:false,icon:icon()}).addTo(map);pin.on('dragend',()=>write(pin.getLatLng()));}else pin.setLatLng(point);paint();info.textContent='Location: '+point[0].toFixed(7)+', '+point[1].toFixed(7);if(center)map.setView(point,Math.max(map.getZoom(),16));};
 const write=ll=>{lat.value=ll.lat.toFixed(7);lng.value=ll.lng.toFixed(7);show([ll.lat,ll.lng]);};
 const read=center=>{const a=Number(lat.value),b=Number(lng.value);if(lat.value!==''&&lng.value!==''&&Number.isFinite(a)&&Number.isFinite(b))show([a,b],center);};
 map.on('click',e=>write(e.latlng));lat.addEventListener('change',()=>read(true));lng.addEventListener('change',()=>read(true));type?.addEventListener('change',()=>pin&&paint());
 setTimeout(()=>read(true),80);
}
function networkMapView(content){
 const can=module=>operationsState.modules[module]?.write,tools=opsElement('div',undefined,'ops-toolbar network-map-tools'),box=opsElement('div',undefined,'network-map network-map-large'),banner=opsElement('p',undefined,'network-pick-banner');
 content.replaceChildren(opsElement('h2','Network map'),opsElement('p','Your POPs, data centers, FATs, devices, fiber cables and customers on the city map. Use the buttons to pin a new point, or click anything on the map to open it.','ops-note'));
 banner.hidden=true;let picking=null;
 const pick=(label,module,preset)=>()=>{picking={module,preset};banner.hidden=false;banner.replaceChildren(document.createTextNode('Click the map where the new '+label+' is located. '),opsButton('Cancel',()=>{picking=null;banner.hidden=true;box.classList.remove('network-picking');}));box.classList.add('network-picking');};
 if(can('POPs'))tools.append(opsButton('+ POP',pick('POP','POPs',{}),true));
 if(can('Network devices'))for(const [label,type]of [['DC','Data center (DC)'],['FAT','FAT'],['FDT','FDT'],['OLT','OLT'],['Device','Other']])tools.append(opsButton('+ '+label,pick(label,'Network devices',{type}),true));
 if(can('Fiber segments'))tools.append(opsButton('+ Fiber cable',()=>opsEditor(null,{},'Fiber segments'),true));
 tools.append(opsButton('Download KMZ',opsDownloadKmz));
 if(can('Fiber segments')||can('Network devices'))tools.append(opsButton('Upload KMZ',networkUploadKmz));
 // Full screen takes the buttons, map and legend together so pins can still be added.
 const shell=opsElement('div',undefined,'network-map-shell'),full=opsButton('⛶ Full screen',()=>networkToggleFullscreen(shell));full.classList.add('network-fullscreen-button');tools.append(full);
 shell.append(tools,banner,box,networkLegend());content.append(shell);
 // While placing a pin, a click on an existing cable or marker still means "here".
 const place=latlng=>{const {module,preset}=picking;picking=null;banner.hidden=true;box.classList.remove('network-picking');opsEditor(null,{...preset,latitude:latlng.lat.toFixed(7),longitude:latlng.lng.toFixed(7)},module);};
 const {map}=networkBaseMap(box,{onRecord:(r,latlng)=>picking?place(latlng):operationsState.modules[r.module]?.write&&['Open','Pending'].includes(r.state)?opsEditor(r,{},r.module):opsHistory(r)});
 map.on('click',e=>{if(picking)place(e.latlng);});
 const control=L.control({position:'topleft'});control.onAdd=()=>{const b=L.DomUtil.create('a','network-fullscreen-control');b.href='#';b.title='Full screen';b.setAttribute('role','button');b.setAttribute('aria-label','Full screen');b.textContent='⛶';L.DomEvent.on(b,'click',e=>{L.DomEvent.stop(e);networkToggleFullscreen(shell);});const bar=L.DomUtil.create('div','leaflet-bar');bar.append(b);return bar;};control.addTo(map);
 shell.networkMap=map;
 if(networkFullscreen)networkSetFullscreen(shell,true);
}
// Full screen fills the browser window and stays on while records are added (the map redraws after each save).
let networkFullscreen=false;
function networkSetFullscreen(shell,on){networkFullscreen=on;shell.classList.toggle('network-fullscreen',on);const b=shell.querySelector('.network-fullscreen-button');if(b)b.textContent=on?'✕ Exit full screen':'⛶ Full screen';const c=shell.querySelector('.network-fullscreen-control');if(c){c.textContent=on?'✕':'⛶';c.title=on?'Exit full screen':'Full screen';c.setAttribute('aria-label',c.title);}setTimeout(()=>shell.networkMap?.invalidateSize(),80);}
function networkToggleFullscreen(shell){networkSetFullscreen(shell,!shell.classList.contains('network-fullscreen'));}
document.addEventListener('keydown',e=>{const shell=document.querySelector('.network-map-shell.network-fullscreen');if(e.key==='Escape'&&shell&&!document.querySelector('dialog[open]'))networkSetFullscreen(shell,false);});
