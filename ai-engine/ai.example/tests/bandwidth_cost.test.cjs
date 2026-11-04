const assert=require('node:assert/strict');
const {billCostModel,reportData}=require('../web/reports.js');
const {bandwidthReminderMonth,missingBandwidthPeaks}=require('../web/bandwidth-reminder.js');
global.today=()=>'2026-10-30';
const records={
 Packages:[{id:1,name:'15 Nayatel',service_provider:'Nayatel bandwidth',speed_mbps:15,monthly_cost:999},{id:2,name:'45 Nayatel',service_provider:'Nayatel bandwidth',speed_mbps:45,monthly_cost:999},{id:3,name:'Panel 20',service_provider:'Transworld Panel',speed_mbps:20,monthly_cost:1200},{id:4,name:'TW 30',service_provider:'Transworld Bandwidth',speed_mbps:30,monthly_cost:700}],
 Customers:[{id:1,package_id:1,status:'Active'},{id:2,package_id:2,status:'Active'},{id:3,package_id:3,status:'Active'},{id:4,package_id:4,status:'Active'}],
 Invoices:[{customer_id:1,package_name:'15 Nayatel',billing_month:'2026-10',amount:2500},{customer_id:2,package_name:'45 Nayatel',billing_month:'2026-10',amount:4500},{customer_id:3,package_name:'Panel 20',billing_month:'2026-10',amount:3000},{customer_id:4,package_name:'TW 30',billing_month:'2026-10',amount:3000}],
 'Bandwidth peaks':[{provider:'Nayatel bandwidth',month:'2026-10',peak_mbps:30,price_per_mbps:200}],
 Payments:[],Expenses:[],'Stock issues':[]};
const cost=billCostModel(records);
// Nayatel: 30 Mbps peak shared by speed over 60 Mbps sold, Rs 200 per Mbps.
assert.equal(cost(records.Invoices[0]),30*15/60*200);
assert.equal(cost(records.Invoices[1]),30*45/60*200);
assert.equal(cost(records.Invoices[0])+cost(records.Invoices[1]),30*200,'provider total equals peak × price');
assert.equal(cost(records.Invoices[2]),1200,'Transworld Panel keeps its own cost');
assert.equal(cost(records.Invoices[3]),700,'no peak yet: package monthly cost');
assert.deepEqual(cost.missing(new Set(['2026-10'])),['2026-10 · Transworld Bandwidth']);
// A city view sees fewer bills; the company-wide speed from the server keeps each bill's share fair.
const city={...records,Invoices:[records.Invoices[0]],'Bandwidth peaks':[{...records['Bandwidth peaks'][0],sold_mbps:60}]};
assert.equal(billCostModel(city)(city.Invoices[0]),30*15/60*200);
const health=reportData(records,'Business Health (Net Profit)','2026-10-01','2026-10-31');
assert.equal(health.rows[0][2],6000+1200+700);assert.match(health.note,/No peak entered yet for 2026-10 · Transworld Bandwidth/);
// Reminder: last 3 days of the month and the first 7 days of the next ask for the closing month.
assert.equal(bandwidthReminderMonth('2026-10-29'),'2026-10');assert.equal(bandwidthReminderMonth('2026-10-28'),null);
assert.equal(bandwidthReminderMonth('2026-11-07'),'2026-10');assert.equal(bandwidthReminderMonth('2026-11-08'),null);
assert.equal(bandwidthReminderMonth('2026-02-26'),'2026-02');assert.equal(bandwidthReminderMonth('2027-01-03'),'2026-12');
assert.deepEqual(missingBandwidthPeaks(records,'2026-10'),['Transworld Bandwidth']);
assert.deepEqual(missingBandwidthPeaks(records,'2026-11'),['Nayatel bandwidth','Transworld Bandwidth']);
console.log('PASS: bandwidth package cost by peak and speed share, Panel cost, fallbacks, city share and month-end reminder.');
