const assert=require('node:assert/strict');
const {businessFigures}=require('../web/business-dashboard.js');
const records={
 Invoices:[{customer_id:1,billing_month:'2026-09',issue_date:'2026-09-01',amount:2000},{customer_id:1,billing_month:'2026-10',issue_date:'2026-10-19',amount:2000},{customer_id:2,billing_month:'2026-10',issue_date:'2026-10-01',amount:1000}],
 Payments:[{customer_id:1,billing_month:'2026-09',payment_date:'2026-09-03',amount:800,method:'Cash',revenue_type:'MRC'},{customer_id:1,billing_month:'2026-10',payment_date:'2026-10-19',amount:3200,method:'Card',revenue_type:'MRC'},{customer_id:2,billing_month:'2026-10',payment_date:'2026-10-19',amount:5000,method:'Cash',revenue_type:'OTC'},{customer_id:2,billing_month:'2026-10',payment_date:'2026-10-01',amount:400,method:'Cash'}],
 Expenses:[{status:'Paid',payment_date:'2026-10-19',amount:700},{status:'Pending',expense_date:'2026-10-19',amount:900},{status:'Cancelled',payment_date:'2026-10-19',amount:2000}],
 Customers:[{joined:'2026-10-19'}],Recharges:[{activated_at:'2026-10-18T20:00:00Z'},{activated_at:'2026-10-19T20:00:00Z'}]
};
const data=businessFigures(records,'2026-10-19','2026-10');
assert.equal(data.daily.billed,2000);assert.equal(data.daily.sales,7000);assert.equal(data.daily.mrc,3200);assert.equal(data.daily.otc,5000);assert.equal(data.daily.collected,8200);assert.equal(data.daily.netCash,7500);assert.equal(data.daily.activations,1);
assert.equal(data.monthly.billed,3000);assert.equal(data.monthly.sales,8000);assert.equal(data.monthly.collected,8600);assert.equal(data.monthly.netCash,7900);
assert.equal(data.outstanding,600);assert.equal(data.owing,1);assert.equal(data.breakdown.length,31);
assert.equal(data.breakdown.reduce((n,r)=>n+r.collected,0),data.monthly.collected);
assert.equal(data.methods.reduce((n,r)=>n+r.total,0),data.monthly.collected);
assert.equal(businessFigures(records,'2026-09-02','2026-09').outstanding,2000);
assert.equal(businessFigures({},'2024-02-29','2024-02').breakdown.length,29);
const empty=businessFigures({},'2026-10-19','2026-10');assert.equal(empty.daily.sales,0);assert.equal(empty.monthly.collected,0);assert.equal(empty.outstanding,0);
console.log('PASS: daily/monthly sales and collections, OTC isolation, paid expenses, PKT dates, arrears settlement, breakdown totals and leap years.');

const lost=businessFigures({...records,'Equipment recovery':[{terminated_on:'2026-10-19',monthly_revenue_loss:2000},{terminated_on:'2026-10-02',monthly_revenue_loss:1500},{terminated_on:'2026-09-01',monthly_revenue_loss:900}]},'2026-10-19','2026-10');
assert.equal(lost.daily.terminations,1);assert.equal(lost.daily.revenueLost,2000);assert.equal(lost.monthly.terminations,2);assert.equal(lost.monthly.revenueLost,3500);assert.equal(lost.monthly.collected,data.monthly.collected);
console.log('PASS: daily/monthly termination events and lost monthly MRC do not alter cash collection totals.');
