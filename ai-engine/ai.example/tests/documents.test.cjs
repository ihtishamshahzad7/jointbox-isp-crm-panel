const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={btoa};vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../web/documents.js'),'utf8'),context);
(async()=>{
 const bytes=Uint8Array.from({length:70000},(_,i)=>i%256);
 const files=[{name:'sample.png',size:bytes.length,arrayBuffer:async()=>bytes.buffer}];
 const result=await context.prepareDocuments(files,'Installation photo');
 assert.equal(result.length,1);assert.equal(result[0].name,'sample.png');assert.equal(result[0].document_type,'Installation photo');
 assert.deepEqual(Buffer.from(result[0].content,'base64'),Buffer.from(bytes));
 assert.equal((await context.prepareDocuments([],'Other')).length,0);
 await assert.rejects(context.prepareDocuments(Array(6).fill(files[0]),'Other'),/up to 5/);
 await assert.rejects(context.prepareDocuments([{size:0}],'Other'),/contain data/);
 await assert.rejects(context.prepareDocuments([{size:6*1024*1024}],'Other'),/at most 5 MB/);
 await assert.rejects(context.prepareDocuments(Array(5).fill({size:5*1024*1024}),'Other'),/20 MB/);
 console.log('PASS: document encoding preserves bytes, file metadata, and count/size limits.');
})().catch(error=>{console.error(error);process.exitCode=1;});
