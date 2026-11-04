'use strict';
function parseDeploymentCoordinates(value){
 const parts=String(value).trim().split(/[,;\s]+/);
 if(parts.length!==2||parts.some(p=>p===''))throw Error('Paste latitude, longitude, for example 34.1200000, 72.4700000.');
 const [latitude,longitude]=parts.map(Number);
 if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude< -90||latitude>90||longitude< -180||longitude>180)throw Error('Latitude must be -90 to 90; longitude must be -180 to 180.');
 return {latitude,longitude};
}
function customerMapUrl(customer){
 if(customer.latitude===null||customer.latitude===undefined||customer.latitude===''||customer.longitude===null||customer.longitude===undefined||customer.longitude==='')return null;
 try{const {latitude,longitude}=parseDeploymentCoordinates(`${customer.latitude},${customer.longitude}`);return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(latitude+','+longitude);}catch{return null;}
}
function setupCustomerLocation(){
 const fields=$('form').elements,latitude=fields.namedItem('latitude'),longitude=fields.namedItem('longitude');
 latitude.required=longitude.required=true;latitude.placeholder='Latitude (-90 to 90)';longitude.placeholder='Longitude (-180 to 180)';
 const section=el('section',undefined,'customer-location-tools full-field');section.append(el('strong','Connection deployment pin'),el('p','Enter the installation location. Use current location only when you are at the customer installation site.','expense-note'));
 const controls=el('div',undefined,'profile-actions'),paste=el('input');paste.type='text';paste.placeholder='Paste latitude, longitude';paste.setAttribute('aria-label','Paste deployment coordinates');
 const feedback=el('p',undefined,'expense-note');feedback.setAttribute('role','status');
 const set=(point)=>{if(!latitude.isConnected||!$('editor').open)return;latitude.value=point.latitude.toFixed(7);longitude.value=point.longitude.toFixed(7);feedback.textContent='Deployment coordinates entered. Save the customer to keep this pin.';};
 const apply=profileAction('Apply coordinates',()=>{try{set(parseDeploymentCoordinates(paste.value));}catch(error){feedback.textContent=error.message;}});
 const locate=profileAction('Use current location',()=>{if(!navigator.geolocation){feedback.textContent='Location is unavailable in this browser. Enter coordinates manually.';return;}locate.disabled=true;feedback.textContent='Requesting your location...';navigator.geolocation.getCurrentPosition(position=>{set({latitude:position.coords.latitude,longitude:position.coords.longitude});locate.disabled=false;},()=>{feedback.textContent='Could not obtain location. Allow browser location access or enter coordinates manually.';locate.disabled=false;},{enableHighAccuracy:true,maximumAge:0,timeout:10000});});
 apply.disabled=locate.disabled=paste.disabled=!can('write','Customers');controls.append(paste,apply,locate);section.append(controls,feedback);$('fields').append(section);
}
if(typeof module!=='undefined')module.exports={parseDeploymentCoordinates,customerMapUrl};
