'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const elements=[];
function el(tag,text){const node={tag,textContent:text,value:'',isConnected:true,children:[],events:{},append(...nodes){this.children.push(...nodes);},addEventListener(name,fn){this.events[name]=fn;},setCustomValidity(value){this.validation=value;}};elements.push(node);return node;}
const fields={inventory_id:{value:'',dispatchEvent(){this.changed=true;}},quantity:{value:0}},container={prepend(){}};
let next={ok:true,unit:{inventory_id:12,state:'Available',item:'ONT',serial_number:'SERIAL-1'}};
const context={el,$:id=>id==='fields'?container:{elements:{namedItem:name=>fields[name]}},Event:class{},fetch:async()=>({ok:next.ok,json:async()=>next})};
vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../web/inventory-qr.js'),'utf8'),context);
(async()=>{context.attachStockQrInput();const input=elements.find(n=>n.name==='qr_code');input.value='ISPCRM:123';await input.events.change();assert.equal(fields.inventory_id.value,12);assert.equal(fields.quantity.value,1);assert.ok(fields.inventory_id.changed);next={ok:true,unit:{state:'Issued'}};await input.events.change();assert.match(input.validation,/already issued/);let prevented=false;input.events.keydown({key:'Enter',preventDefault(){prevented=true;}});assert.ok(prevented);console.log('PASS: scanned device fills stock form, issued devices rejected and scanner Enter prevents premature submission.');})().catch(e=>{console.error(e);process.exitCode=1;});
