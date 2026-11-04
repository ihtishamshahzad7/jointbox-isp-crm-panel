const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {dashboardData,expenseTotals} = require('../web/dashboard.js');
const records = {
 Customers:[{id:1,status:'Active',monthly_fee:2500,package:'Home',package_id:1},{id:2,status:'Suspended',monthly_fee:3500,package:'Pro',package_id:2}],
 Payments:[{payment_date:'2026-10-02',amount:1000},{payment_date:'2026-10-02',amount:1500},{payment_date:'2026-09-01',amount:800},{payment_date:'2026-04-30',amount:900}],
 Jobs:[{id:1,title:'Install',status:'Open',due_date:'2026-10-20',staff_id:1},{id:2,title:'Repair',status:'In progress',due_date:'2026-10-18',staff_id:1},{id:3,status:'Completed',due_date:'2026-10-10'}],
 Staff:[{id:1,name:'Tech',status:'Available'},{id:2,status:'On leave'}],
 Inventory:[{item:'Fiber',category:'Cable',quantity:5,minimum_stock:5},{item:'ONT',category:'ONT',quantity:8,minimum_stock:2}], Packages:[],Categories:[],
 Tickets:[{id:1,subject:'No connection',status:'Open',priority:'Urgent',assigned_to:null,due_date:'2026-10-18'},{id:2,subject:'Billing issue',status:'In progress',priority:'Normal',assigned_to:1,due_date:'2026-10-20'},{id:3,subject:'Fixed',status:'Resolved',priority:'High',assigned_to:1,due_date:'2026-10-10'}]
};
const data=dashboardData(records,'2026-10-19');
assert.equal(data.expected,2500);assert.equal(data.collected,2500);
assert.equal(data.buckets.length,31);assert.equal(data.buckets[1].value,2500);
assert.deepEqual(data.statuses.map(s=>s.value),[1,1,0,0]);
assert.equal(data.available,1);assert.equal(data.lowStock.length,1);
assert.deepEqual(data.openJobs.map(j=>j.id),[2,1]);
assert.equal(data.packages.length,1);assert.equal(data.packages[0].value,2500);
const six=dashboardData(records,'2026-10-19','six');
assert.equal(six.buckets[0].key,'2026-05');assert.equal(six.buckets.at(-1).key,'2026-10');
assert.equal(six.buckets.reduce((sum,b)=>sum+b.value,0),3300);
assert.equal(dashboardData(records,'2026-01-05','six').buckets[0].key,'2025-08');
assert.equal(dashboardData(records,'2024-02-15').buckets.length,29);
const empty=Object.fromEntries(Object.keys(records).map(k=>[k,[]]));
assert.equal(dashboardData(empty,'2026-10-19').expected,0);
const expenses=[
 {amount:100.25,expense_date:'2026-09-30',status:'Paid',payment_date:'2026-10-01'},
 {amount:200,expense_date:'2026-10-02',status:'Paid',payment_date:'2026-11-01'},
 {amount:50,expense_date:'2026-10-03',status:'Pending',payment_date:null},
 {amount:25,expense_date:'2026-09-15',status:'Pending',payment_date:null},
 {amount:900,expense_date:'2026-10-04',status:'Cancelled',payment_date:null}
];
assert.deepEqual(expenseTotals(expenses,'2026-10'),{recorded:250,paid:100.25,pending:75});
assert.deepEqual(expenseTotals([],'2026-10'),{recorded:0,paid:0,pending:0});

// Exercise all chart builders without requiring a browser installation.
class Node {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.classList={add:()=>{}};}
 append(...children){this.children.push(...children);}
 setAttribute(key,value){this.attributes[key]=value;}
 addEventListener(){}
 replaceChildren(...children){this.children=children;}
}
const root=new Node('section');
const context={document:{documentElement:{dataset:{layout:'standard'}},createElementNS:(_ns,tag)=>new Node(tag)},dashboardMetricIcon:()=>new Node('svg'),
 el:(tag,text,cls)=>{const n=new Node(tag);n.textContent=text;n.className=cls;return n;},
 $:()=>root,money:n=>Number(n).toLocaleString('en-PK'),navigate:()=>{},openEditor:()=>{},load:async()=>{},showError:()=>{}};
vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../web/dashboard.js'),'utf8'),context);
context.buildDashboard(records,'2026-10-19');assert.equal(root.children.length,4);
context.buildDashboard(empty,'2026-10-19');assert.equal(root.children.length,4);
vm.runInContext("collectionPeriod='six'",context);
context.buildDashboard(records,'2026-10-19');assert.equal(root.children.length,4);
console.log('PASS: chart totals, receipt grouping, month boundaries, leap year, stock thresholds, job sorting, and populated/empty chart rendering.');

const split=dashboardData({...records,Payments:[{payment_date:'2026-10-02',amount:2000,revenue_type:'MRC'},{payment_date:'2026-10-03',amount:4500,revenue_type:'OTC'},{payment_date:'2026-10-04',amount:1000},{payment_date:'2026-09-04',amount:5000,revenue_type:'OTC'}]},'2026-10-19');
assert.equal(split.mrc,3000);assert.equal(split.otc,4500);assert.equal(split.collected,7500);
console.log('PASS: MRC/OTC monthly collections remain separate, including legacy MRC records.');
