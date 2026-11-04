const assert=require('node:assert/strict');
const {parseDeploymentCoordinates:parse,customerMapUrl:map}=require('../web/customer-location.js');
assert.deepEqual(parse('0,0'),{latitude:0,longitude:0});assert.deepEqual(parse('-33.1234567, 151.7654321'),{latitude:-33.1234567,longitude:151.7654321});assert.deepEqual(parse('90 180'),{latitude:90,longitude:180});
for(const bad of ['91,0','0,-181','NaN,0','0,Infinity','one,two','33','1,2,3',''])assert.throws(()=>parse(bad));
assert.equal(map({latitude:null,longitude:null}),null);assert.equal(map({latitude:0,longitude:0}),'https://www.google.com/maps/search/?api=1&query=0%2C0');assert.equal(map({latitude:'bad',longitude:5}),null);
console.log('PASS: coordinate parsing, negative/zero/boundary values, invalid pairs and safe saved-map links.');
