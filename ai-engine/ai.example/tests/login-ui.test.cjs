'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require.resolve('../web/auth.js'),'utf8'),nodes={};
for(const id of ['auth-password','auth-password-toggle','auth-caps-lock'])nodes[id]={type:'password',hidden:true,attributes:{},events:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,v){this.events[k]=v;}};
const context={$:id=>nodes[id],setupRecoveryControls:()=>{}};vm.createContext(context);const start=source.indexOf('function setupAuthControls(){'),end=source.indexOf(" $('auth-form').onsubmit",start);vm.runInContext(source.slice(start,end)+'}',context);context.setupAuthControls();
nodes['auth-password-toggle'].onclick();assert.equal(nodes['auth-password'].type,'text');assert.equal(nodes['auth-password-toggle'].attributes['aria-pressed'],'true');assert.equal(nodes['auth-password-toggle'].attributes['aria-label'],'Hide password');nodes['auth-password-toggle'].onclick();assert.equal(nodes['auth-password'].type,'password');nodes['auth-password'].events.keydown({getModifierState:()=>true});assert.equal(nodes['auth-caps-lock'].hidden,false);nodes['auth-password'].events.blur();assert.equal(nodes['auth-caps-lock'].hidden,true);
console.log('PASS: password visibility, accessible labels and Caps Lock notice.');
