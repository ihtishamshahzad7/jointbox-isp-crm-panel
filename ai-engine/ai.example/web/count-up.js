'use strict';
// Bold figures count up from zero whenever a page or panel renders them.
(function(){
 const NUMBER=/^(-?)((?:PKR|Rs\.?)\s?)?(\d[\d,]*(?:\.\d+)?)(\s?(?:%|km|m|Mbps|GB|MB))?$/;
 const SELECTOR='strong,b,.nav-count';
 const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
 const finished=new WeakMap(),running=new WeakSet();
 function animate(el){
  if(reduceMotion.matches||running.has(el)||el.children.length)return;
  const text=el.textContent.trim();
  if(finished.get(el)===text)return;
  const match=text.match(NUMBER);
  if(!match)return;
  const [,sign,prefix='',raw,suffix='']=match,target=Number(raw.replaceAll(',',''));
  if(!target)return;
  const decimals=(raw.split('.')[1]||'').length,grouped=raw.includes(',');
  const format=value=>sign+prefix+(grouped?value.toLocaleString('en-US',{minimumFractionDigits:decimals,maximumFractionDigits:decimals}):value.toFixed(decimals))+suffix;
  const duration=Math.min(1400,600+Math.log10(target+1)*160),start=performance.now();
  let shown=format(0);el.textContent=shown;running.add(el);
  const step=now=>{
   // Stop if the page replaced the text meanwhile; its new value is shown as is.
   if(el.textContent!==shown){running.delete(el);return;}
   const progress=Math.min(1,(now-start)/duration),eased=1-Math.pow(1-progress,3);
   shown=progress<1?format(decimals?target*eased:Math.round(target*eased)):text;
   el.textContent=shown;
   if(progress<1)requestAnimationFrame(step);else{running.delete(el);finished.set(el,text);}
  };
  requestAnimationFrame(step);
 }
 function scan(node){
  if(node.nodeType!==1)return;
  if(node.matches(SELECTOR))animate(node);
  for(const el of node.querySelectorAll(SELECTOR))animate(el);
 }
 function start(){
  scan(document.body);
  new MutationObserver(mutations=>{
   for(const m of mutations){
    const target=m.target.nodeType===1?m.target:m.target.parentElement;
    if(target&&!running.has(target)&&target.matches?.(SELECTOR))animate(target);
    for(const node of m.addedNodes)scan(node);
   }
  }).observe(document.body,{childList:true,subtree:true,characterData:true});
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
