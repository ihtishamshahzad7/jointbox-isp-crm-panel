'use strict';
// City picker in the top bar: the whole CRM reloads with only that city's customers and their records.
function selectedCity(){try{return localStorage.getItem('crm-city')||'';}catch{return '';}}
function cityQuery(){const city=selectedCity();return city?'?city='+encodeURIComponent(city):'';}
function renderCityPicker(){const select=document.getElementById('city-filter');if(!select||!state)return;const cities=state.cities||[];if(selectedCity()&&!state.city){try{localStorage.removeItem('crm-city');}catch{}}select.replaceChildren(new Option('All cities',''),...cities.map(c=>new Option(c,c)));select.value=state.city||'';select.closest('.city-picker').hidden=!cities.length;document.body.classList.toggle('city-filtered',Boolean(state.city));}
// Customer form: City is required once cities exist, and the Area list shows only that city's areas.
function setupCustomerCity(row){
 const form=$('form'),city=form.elements.namedItem('city'),area=form.elements.namedItem('area');if(!city||!area)return;
 city.required=(state.city_list??[]).length>0;
 const all=[...area.options].map(o=>[o.value,o.textContent]),cityOf=v=>(state.area_cities??{})[v]||'';
 const fill=()=>{const keep=area.value;area.replaceChildren(...all.filter(([v])=>!v||!city.value||!cityOf(v)||cityOf(v).toLowerCase()===city.value.toLowerCase()).map(([v,t])=>new Option(t,v)));area.value=[...area.options].some(o=>o.value===keep)?keep:'';};
 city.addEventListener('change',fill);
 area.addEventListener('change',()=>{const c=cityOf(area.value);if(c&&c.toLowerCase()!==city.value.toLowerCase()){city.value=[...city.options].find(o=>o.value.toLowerCase()===c.toLowerCase())?.value||city.value;fill();}});
 fill();
}
document.getElementById('city-filter')?.addEventListener('change',async e=>{const select=e.target;try{if(select.value)localStorage.setItem('crm-city',select.value);else localStorage.removeItem('crm-city');}catch{}select.disabled=true;try{await load();}catch(error){showError(error);}finally{select.disabled=false;}});
