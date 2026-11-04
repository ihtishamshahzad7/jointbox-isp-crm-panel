(function(){
 'use strict';
 // Three themes: Light, Dark and Glossy (stored as 'digital'). Retired choices move to their closest theme.
 const storageKey='ispcrm-theme',choices=['light','dark','digital'],retired={system:'light',ember:'digital',obsidian:'dark'};
 const pick=value=>choices.includes(value)?value:retired[value]??'digital';
 let preference='digital';
 try{document.documentElement.dataset.layout=localStorage.getItem('ispcrm-layout')==='standard'?'standard':'studio';}catch{document.documentElement.dataset.layout='studio';}
 try{const saved=localStorage.getItem(storageKey);if(saved){preference=pick(saved);if(preference!==saved)localStorage.setItem(storageKey,preference);}}catch{}
 function apply(){
  document.documentElement.dataset.theme=preference==='digital'?'light':preference;
  document.documentElement.dataset.skin=preference==='digital'?'digital':'default';
  for(const button of document.querySelectorAll('[data-theme-choice]'))button.setAttribute('aria-pressed',String(button.dataset.themeChoice===preference));
 }
 apply();
 window.addEventListener('storage',event=>{if(event.key!==storageKey)return;preference=pick(event.newValue);apply();});
 document.addEventListener('DOMContentLoaded',()=>{
  for(const button of document.querySelectorAll('[data-theme-choice]'))button.addEventListener('click',()=>{
   preference=button.dataset.themeChoice;
   try{localStorage.setItem(storageKey,preference);}catch{}
   apply();
  });
  apply();
 });
})();
