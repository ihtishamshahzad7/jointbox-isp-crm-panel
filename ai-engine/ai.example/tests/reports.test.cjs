const assert=require('node:assert/strict');
const {reportData,reportNames}=require('../web/reports.js');
const records={Customers:[{id:1,payment_id:'123456789',name:'Test',package:'Home',status:'Active',monthly_fee:1000,installation_charge:2000,expiry_date:'2026-10-25',promise_date:'2026-10-22'}],Invoices:[{customer_id:1,amount:1000,billing_month:'2026-10',issue_date:'2026-10-01'}],Payments:[{id:1,customer_id:1,amount:400,revenue_type:'MRC',billing_month:'2026-10',payment_date:'2026-10-19',method:'Cash',recorded_by:'Collector'},{id:2,customer_id:1,amount:500,revenue_type:'OTC',otc_type:'Installation',payment_date:'2026-10-19',method:'Card'}],Recharges:[{customer_id:1,billing_month:'2026-10',activated_at:'2026-10-18T21:00:00Z',partial_activation:true}]};
records.Inventory=[{id:1,item:'ONT',quantity:2,unit_cost:1000}];records['Inventory units']=[{inventory_id:1,state:'Available',condition:'Damaged'}];
records.Packages=[{id:7,name:'Home',monthly_cost:600}];records.Customers[0].package_id=7;records.Invoices[0].package_name='Home';
records.Expenses=[{amount:100,status:'Paid',expense_date:'2026-10-05',payment_date:'2026-10-05'},{amount:999,status:'Cancelled',expense_date:'2026-10-05'}];
records['Stock issues']=[{quantity:1,unit_cost_at_issue:1000,status:'Issued',issue_date:'2026-10-10'},{quantity:5,unit_cost_at_issue:1000,status:'Returned',issue_date:'2026-10-10'}];
const report=name=>reportData(records,name,'2026-10-01','2026-10-31');
for(const name of reportNames){const data=report(name);assert.ok(data.headers.length);assert.ok(data.rows.length,name);for(const row of data.rows)assert.equal(row.length,data.headers.length,name);}
assert.deepEqual(report('Monthwise Collection').rows[0],['2026-10',2,400,500,900]);
assert.deepEqual(report('Accounts Report').rows[0],['123456789','Test',1000,400,600,2000,500,1500]);
assert.equal(report('Daily Sales Report').rows.reduce((n,r)=>n+r[3],0),1500);
assert.equal(reportData(records,'Transaction Wise Report','2026-10-20','2026-10-31').rows.length,0);
assert.equal(reportData(records,'Transaction Wise Report','2026-10-01','2026-10-31','Card').rows.length,1);
const health=report('Business Health (Net Profit)');
// Stock issued (1000) is shown but not deducted: 900 − 600 package − 100 expenses = 200.
assert.deepEqual(health.rows.at(-1),['Total',900,600,100,700,200,'22.2%',1000]);
assert.equal(health.summary.find(s=>s[0]==='Net profit')[3],'good');assert.equal(health.summary.find(s=>s[0]==='Stock issued')[1],1000);
const pl=report('Profit & Loss Statement'),amount=label=>pl.rows.find(r=>r[0]===label)[1];
assert.equal(amount('Monthly subscriptions (MRC)'),400);assert.equal(amount('Installation charges'),500);assert.equal(amount('Total income'),900);
assert.equal(amount('Package / bandwidth cost'),600);assert.equal(amount('Total cost of service'),600);assert.equal(amount('Gross profit'),300);
assert.equal(amount('Other'),100);assert.equal(amount('Total operating expenses'),100);assert.equal(amount('Net profit'),200);
assert.equal(amount('Equipment & stock issued (at cost)'),1000);
assert.ok(pl.rows.findIndex(r=>r[0]==='Equipment & stock issued (at cost)')>pl.rows.findIndex(r=>r[0]==='Net profit'));
assert.equal(pl.rowKinds.get('Net profit'),'result good');assert.equal(pl.rows.find(r=>r[0]==='Total income')[2],'100.0%');
console.log('PASS: all 14 reports, profit & loss statement, net profit, dates, search, MRC/OTC separation, invoice balances and installation outstanding.');
