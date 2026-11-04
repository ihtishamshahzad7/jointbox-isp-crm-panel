'use strict';

// Keep the real select for form validation, permissions, and existing change handlers.
function matchSelectOptions(options,query){
 const normalize=value=>String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase();
 const terms=normalize(query).trim().split(/\s+/).filter(Boolean);
 return options.filter(option=>terms.every(term=>normalize(option.textContent||option.label||'').includes(term)));
}

function installSelectSearch(root=document){
 const enhanced=new WeakSet();let sequence=0;
 function enhance(select){
  if(enhanced.has(select)||select.multiple||select.size>1||select.dataset?.noSearch!==undefined)return;
  enhanced.add(select);
  const label=select.closest('label');
  const text=select.getAttribute('aria-label')||(label?Array.from(label.childNodes).filter(node=>node.nodeType===3).map(node=>node.textContent).join(' ').trim():'')||select.name?.replaceAll('_',' ')||'options';
  if(!select.id)select.id='searchable-select-'+(++sequence);
  if(label)label.htmlFor=select.id;
  const wrapper=document.createElement('div');wrapper.className='select-search';
  const bar=document.createElement('div');bar.className='select-search-bar';
  const search=document.createElement('input');search.type='search';search.autocomplete='off';search.spellcheck=false;search.placeholder='Search '+text.toLowerCase()+'...';search.setAttribute('aria-label','Search '+text+' options');search.setAttribute('aria-controls',select.id);
  const clear=document.createElement('button');clear.type='button';clear.className='select-search-clear';clear.textContent='×';clear.setAttribute('aria-label','Clear '+text+' search');clear.hidden=true;
  const count=document.createElement('small');count.className='select-search-count';count.setAttribute('role','status');count.setAttribute('aria-live','polite');count.hidden=true;
  select.before(wrapper);bar.append(search,clear);wrapper.append(bar,select,count);
  let options=Array.from(select.options).map(option=>option.cloneNode(true));
  const observer=new MutationObserver(changes=>{
   if(changes.some(change=>change.type==='childList'||change.type==='characterData'))options=Array.from(select.options).map(option=>option.cloneNode(true));
   render();
  });
  function watch(){observer.observe(select,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled']});}
  function render(){
   const selected=select.value,query=search.value.trim();
   const matches=matchSelectOptions(options,query);
   // Preserve a selected value even when it doesn't match the search.
   const keep=new Set(matches);for(const option of options)if(option.value===''||option.value===selected)keep.add(option);
   observer.disconnect();select.replaceChildren(...options.filter(option=>keep.has(option)).map(option=>option.cloneNode(true)));select.value=selected;watch();
   search.disabled=select.disabled;clear.disabled=select.disabled;clear.hidden=!query;
   count.hidden=!query;const total=matches.filter(option=>option.value!=='').length;
   count.textContent=total?`${total} matching ${total===1?'option':'options'}`:'No matches. Your current selection is kept.';
  }
  search.addEventListener('input',render);
  clear.addEventListener('click',()=>{search.value='';render();search.focus();});
  search.addEventListener('keydown',event=>{
   if(event.key==='ArrowDown'){event.preventDefault();select.focus();}
   if(event.key==='Enter'){
    event.preventDefault();const matches=matchSelectOptions(options,search.value).filter(option=>option.value!==''&&!option.disabled);
    if(matches.length===1){select.value=matches[0].value;search.value='';render();select.dispatchEvent(new Event('change',{bubbles:true}));}select.focus();
   }
   if(event.key==='Escape'&&search.value){event.preventDefault();event.stopPropagation();search.value='';render();}
  });
  watch();render();
 }
 function scan(){for(const select of root.querySelectorAll('select'))enhance(select);}
 scan();new MutationObserver(scan).observe(root===document?document.body:root,{childList:true,subtree:true});
}
if(typeof module!=='undefined')module.exports={matchSelectOptions};
if(typeof document!=='undefined'){
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>installSelectSearch());else installSelectSearch();
}
