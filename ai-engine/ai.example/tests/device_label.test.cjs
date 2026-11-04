const assert=require('node:assert/strict');
const {parseDeviceLabel,cleanDeviceMac}=require('../web/device-label.js');

// Typical Huawei ONT label text, with an OCR slip (letter O for zero) in the MAC.
let label=parseDeviceLabel('HUAWEI\nOptical Network Terminal\nModel: HG8145V5\nPower: 12V 1A\nMAC: OO:1A:2B:3C:4D:5E\nGPON SN: 485754431A2B3C4D\nS/N: 2150083968FMK9000123',[]);
assert.deepEqual(label,{device_make:'Huawei',device_model:'HG8145V5',device_mac:'00:1A:2B:3C:4D:5E',device_serial:'485754431A2B3C4D'});

// ZTE label without the brand printed: make comes from the model; barcodes win for MAC and serial.
label=parseDeviceLabel('ZXHN F670L\nMAC ADDR 9C-63-5B-11-22-33\nSN ZTEGC1234567',['9C635B112233','ZTEGC1234567']);
assert.equal(label.device_make,'ZTE');assert.equal(label.device_model,'ZXHN F670L');assert.equal(label.device_mac,'9C:63:5B:11:22:33');assert.equal(label.device_serial,'ZTEGC1234567');

// Only a GPON serial is readable: make comes from its vendor code.
assert.equal(parseDeviceLabel('xxxx\nSN: HWTC12345678',[]).device_make,'Huawei');
// TP-Link router label.
label=parseDeviceLabel('tp-link\nModel: Archer C6\nMAC: 50-C7-BF-01-02-03\nS/N: 22113J5000123',[]);
assert.equal(label.device_make,'TP-Link');assert.equal(label.device_mac,'50:C7:BF:01:02:03');assert.equal(label.device_serial,'22113J5000123');
// Nothing readable stays empty rather than guessed.
assert.deepEqual(parseDeviceLabel('Made in China\nCE FC',[]),{device_make:'',device_model:'',device_mac:'',device_serial:''});
assert.equal(cleanDeviceMac('001a2b3c4d'),'');
console.log('PASS: device label parsing (Huawei, ZTE, TP-Link, GPON vendor codes, OCR slips, barcodes, nothing guessed).');
