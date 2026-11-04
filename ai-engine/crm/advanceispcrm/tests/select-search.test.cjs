const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {matchSelectOptions}=require('../web/select-search.js');
const options=[{textContent:'Ali Technician (#21)'},{textContent:'Sara Support (#22)'},{textContent:'José Engineer (#23)'}];
assert.deepEqual(matchSelectOptions(options,'TECH ali'),[options[0]]);
assert.deepEqual(matchSelectOptions(options,'22'),[options[1]]);
assert.deepEqual(matchSelectOptions(options,'jose'),[options[2]]);
assert.equal(matchSelectOptions(options,'missing').length,0);
assert.equal(matchSelectOptions(options,'  ').length,3);

// A minimal DOM harness exercises native-select values and enhancement events.
class Node {
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.nodeType=tag==='#text'?3:1;this.children=[];this.attributes={};this.listeners={};this.disabled=false;this.name='';this._value='';this.id='';}
 get childNodes(){return this.children;}
 get options(){return this.children.filter(n=>n.tag==='option');}
 get value(){if(this.tag==='select')return this.options.some(o=>o.value===this._value)?this._value:(this.options[0]?.value??'');return this._value;}
 set value(value){this._value=String(value);}
 append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
 before(node){const index=this.parent.children.indexOf(this);this.parent.children.splice(index,0,node);node.parent=this.parent;}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 closest(tag){let n=this.parent;while(n){if(n.tag===tag)return n;n=n.parent;}return null;}
 setAttribute(name,value){this.attributes[name]=value;}
 getAttribute(name){return this.attributes[name]??null;}
 addEventListener(name,handler){this.listeners[name]=handler;}
 dispatchEvent(event){this.listeners[event.type]?.(event);}
 cloneNode(){const n=new Node(this.tag,this.textContent);n.value=this.value;n.disabled=this.disabled;return n;}
 focus(){this.focused=true;}
 querySelectorAll(tag){return this.children.flatMap(n=>[...(n.tag===tag?[n]:[]),...n.querySelectorAll(tag)]);}
}
const watchers=[];
class Observer{constructor(callback){this.callback=callback;watchers.push(this);}observe(node){this.node=node;}disconnect(){}}
const body=new Node('body'),label=new Node('label'),select=new Node('select');select.name='employee_id';
function option(value,text,disabled=false){const n=new Node('option',text);n.value=value;n.disabled=disabled;return n;}
select.append(option('','Select employee'),option('1','Ali Technician'),option('2','Sara Support'),option('3','Omar On leave',true));select.value='2';label.append(new Node('#text','Employee name'),select);body.append(label);
const document={body,readyState:'loading',addEventListener:()=>{},createElement:tag=>new Node(tag),querySelectorAll:tag=>body.querySelectorAll(tag)};
const context={document,MutationObserver:Observer,Event:class{constructor(type){this.type=type;}}};
vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../web/select-search.js'),'utf8'),context);context.installSelectSearch(document);
const wrapper=label.children.find(n=>n.className==='select-search'),search=wrapper.children[0].children[0],clear=wrapper.children[0].children[1],count=wrapper.children[2];
assert.equal(search.name,'');assert.equal(select.name,'employee_id');assert.equal(select.value,'2');
search.value='Ali';search.dispatchEvent({type:'input'});
assert.equal(select.value,'2');assert.equal(select.options.length,3);assert.equal(count.textContent,'1 matching option');
let changed=0;select.addEventListener('change',()=>changed++);
search.listeners.keydown({key:'Enter',preventDefault:()=>{}});
assert.equal(select.value,'1');assert.equal(changed,1);assert.equal(select.options.length,4);
search.value='missing';search.dispatchEvent({type:'input'});assert.equal(select.value,'1');assert.match(count.textContent,/No matches/);
clear.listeners.click();assert.equal(select.options.length,4);assert.equal(select.value,'1');
select.disabled=true;const observer=watchers.find(o=>o.node===select);observer.callback([{type:'attributes'}]);assert.equal(search.disabled,true);assert.equal(clear.disabled,true);
select.disabled=false;select.replaceChildren(option('','Select employee'),option('4','Raza Network'));select.value='4';observer.callback([{type:'childList'}]);
search.value='Raza';search.dispatchEvent({type:'input'});assert.equal(select.value,'4');assert.equal(count.textContent,'1 matching option');
search.value='Ali';search.dispatchEvent({type:'input'});assert.match(count.textContent,/No matches/);assert.equal(select.value,'4');
console.log('PASS: name/ID/accent search, selected-value preservation, keyboard selection, disabled fields, and refreshed options.');
