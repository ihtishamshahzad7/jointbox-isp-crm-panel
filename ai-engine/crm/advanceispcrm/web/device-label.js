'use strict';
// Reads make, model, MAC and serial number from a device label photo, entirely in the browser:
// Tesseract.js for the printed text and ZXing for the barcodes. Engine files are served from /ocr/.
const DEVICE_BRANDS=[['huawei','Huawei'],['zte','ZTE'],['tp-link','TP-Link'],['tplink','TP-Link'],['nokia','Nokia'],['alcatel','Nokia'],['fiberhome','FiberHome'],['v-sol','V-SOL'],['vsol','V-SOL'],['mikrotik','MikroTik'],['tenda','Tenda'],['transworld','Transworld'],['syrotech','Syrotech'],['netlink','Netlink'],['ubiquiti','Ubiquiti'],['cisco','Cisco'],['d-link','D-Link'],['xiaomi','Xiaomi'],['bdcom','BDCOM'],['c-data','C-Data'],['optilink','Optilink'],['nag','NAG'],['litech','Litech'],['mercusys','Mercusys'],['totolink','TOTOLINK'],['huawai','Huawei']];
// GPON serial vendor codes, as letters or as their hex form.
const GPON_VENDORS={HWTC:'Huawei','48575443':'Huawei',ZTEG:'ZTE','5A544547':'ZTE',ALCL:'Nokia','414C434C':'Nokia',FHTT:'FiberHome','46485454':'FiberHome',VSOL:'V-SOL','56534F4C':'V-SOL',GPON:'',TPLG:'TP-Link','54504C47':'TP-Link'};
const MODEL_PATTERNS=[[/\b((?:HG|EG|HS|EN)8\d{3}[A-Z0-9]*)\b/i,'Huawei'],[/\b(ZXHN\s?[A-Z]?\d{3,4}[A-Z0-9]*)\b/i,'ZTE'],[/\b(F6\d{2}[A-Z]?\d?)\b/,'ZTE'],[/\b(XC\d{3}-G\d\w*|XZ\d{3}-G\d\w*)\b/i,'TP-Link'],[/\b(Archer\s?[A-Z]?\d+\w*)\b/i,'TP-Link'],[/\b(TL-[A-Z0-9-]+)\b/i,'TP-Link'],[/\b(V\d{4}[A-Z]{1,3}\w*)\b/,'V-SOL'],[/\b(G-\d{3}[A-Z]-[A-Z])\b/,'Nokia'],[/\b(AN5506-\w+|HG6\d{3}\w*)\b/i,'FiberHome']];
let deviceOcrWorker=null;
function loadDeviceScript(src,check){return check()?Promise.resolve():new Promise((done,fail)=>{const s=document.createElement('script');s.src=src;s.onload=()=>done();s.onerror=()=>fail(Error('Could not load the label reader.'));document.head.append(s);});}
async function deviceOcr(){
 await loadDeviceScript('/ocr/tesseract.min.js',()=>window.Tesseract);
 // Page segmentation 11 (sparse text) suits stickers, where text is scattered rather than in paragraphs.
 deviceOcrWorker??=Tesseract.createWorker('eng',1,{workerPath:'/ocr/worker.min.js',corePath:'/ocr/',langPath:'/ocr',workerBlobURL:false,gzip:true}).then(async worker=>{await worker.setParameters({tessedit_pageseg_mode:'11',preserve_interword_spaces:'1'});return worker;}).catch(error=>{deviceOcrWorker=null;throw error;});
 return deviceOcrWorker;
}
// Upscale small photos, rotate, and stretch the contrast of the greyscale image: faded and glossy labels read far better.
function prepareDeviceImage(image,turns=0){
 const scale=Math.min(3,Math.max(1,1600/Math.max(image.width,image.height))),w=Math.round(image.width*scale),h=Math.round(image.height*scale),canvas=document.createElement('canvas'),g=canvas.getContext('2d',{willReadFrequently:true});
 [canvas.width,canvas.height]=turns%2?[h,w]:[w,h];g.fillStyle='#fff';g.fillRect(0,0,canvas.width,canvas.height);g.translate(canvas.width/2,canvas.height/2);g.rotate(turns*Math.PI/2);g.drawImage(image,-w/2,-h/2,w,h);
 const pixels=g.getImageData(0,0,canvas.width,canvas.height),d=pixels.data,grey=new Uint8ClampedArray(d.length/4);
 for(let i=0;i<grey.length;i++)grey[i]=0.299*d[i*4]+0.587*d[i*4+1]+0.114*d[i*4+2];
 const sorted=Float32Array.from(grey).sort(),low=sorted[Math.floor(sorted.length*0.02)],high=sorted[Math.floor(sorted.length*0.98)],span=Math.max(1,high-low);
 for(let i=0;i<grey.length;i++){const v=(grey[i]-low)*255/span;d[i*4]=d[i*4+1]=d[i*4+2]=v;}
 g.setTransform(1,0,0,1,0,0);g.putImageData(pixels,0,0);return canvas;
}
const filledDeviceFields=result=>Object.values(result).filter(Boolean).length;
function loadDeviceImage(src){return new Promise((done,fail)=>{const img=new Image();img.onload=()=>done(img);img.onerror=()=>fail(Error('This photo could not be opened.'));img.src=src;});}
function deviceBarcodes(image){
 if(!window.ZXing)return [];
 const formats=['CODE_128','CODE_39','CODE_93','QR_CODE','DATA_MATRIX','EAN_13','ITF'].map(name=>ZXing.BarcodeFormat[name]).filter(v=>v!==undefined);
 const hints=new Map([[ZXing.DecodeHintType.TRY_HARDER,true],[ZXing.DecodeHintType.POSSIBLE_FORMATS,formats]]),reader=new ZXing.MultiFormatReader(),found=new Set();reader.setHints(hints);
 // ZXing reads one barcode per pass, so scan the whole label and then overlapping horizontal strips.
 const bands=[[0,1]];for(let top=0;top<0.9;top+=0.15)bands.push([top,Math.min(1,top+0.3)]);
 for(const [from,to]of bands){const canvas=document.createElement('canvas'),y=Math.round(image.height*from),h=Math.max(1,Math.round(image.height*(to-from)));canvas.width=image.width;canvas.height=h;canvas.getContext('2d').drawImage(image,0,y,image.width,h,0,0,image.width,h);
  try{const bitmap=new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas)));found.add(reader.decodeWithState(bitmap).getText().trim());}catch{}finally{reader.reset();}}
 return [...found].filter(Boolean);
}
function cleanDeviceMac(value){const hex=String(value).toUpperCase().replace(/O/g,'0').replace(/[IL]/g,'1').replace(/[^0-9A-F]/g,'');return hex.length===12?hex.match(/../g).join(':'):'';}
function parseDeviceLabel(text,codes){
 const out={device_make:'',device_model:'',device_mac:'',device_serial:''},lines=text.split('\n').map(l=>l.trim()).filter(Boolean),lower=text.toLowerCase();
 // Barcodes are exact, so prefer them for MAC and serial.
 for(const code of codes){const mac=/^(?:[0-9A-F]{2}[:-]?){5}[0-9A-F]{2}$/i.test(code)?cleanDeviceMac(code):'';if(mac&&!out.device_mac)out.device_mac=mac;else if(!mac&&/^[A-Z0-9-]{8,24}$/i.test(code)&&!out.device_serial)out.device_serial=code.toUpperCase();}
 for(const line of lines){
  if(!out.device_mac&&/MAC/i.test(line)){const m=line.replace(/^.*?MAC[^:：]*[:：]?/i,'').match(/(?:[0-9A-FOIL]{2}[:\-. ]?){5}[0-9A-FOIL]{2}/i);if(m)out.device_mac=cleanDeviceMac(m[0]);}
  if(!out.device_serial){const m=line.match(/(?:GPON\s*SN|PON\s*SN|S\/N|\bSN|Serial(?:\s*(?:No|Number))?\.?)\s*[:：#.]?\s*([A-Z0-9][A-Z0-9-]{5,})/i);if(m&&!/^(?:[0-9A-F]{2}[:-]?){5}[0-9A-F]{2}$/i.test(m[1]))out.device_serial=m[1].toUpperCase();}
  if(!out.device_model){const m=line.match(/(?:Product\s*)?(?:Model(?:\s*(?:No|Name|Number))?|Type)\.?\s*[:：#]?\s*([A-Z0-9][A-Z0-9\-\/.]{2,30})/i);if(m)out.device_model=m[1];}
 }
 for(const [pattern,brand]of MODEL_PATTERNS){const m=text.match(pattern);if(m){if(!out.device_model)out.device_model=m[1].replace(/\s+/g,' ');if(!out.device_make)out.device_make=brand;}}
 for(const [needle,brand]of DEVICE_BRANDS)if(!out.device_make&&new RegExp('\\b'+needle.replace('-','[- ]?')+'\\b','i').test(lower))out.device_make=brand;
 if(!out.device_make&&out.device_serial){for(const [code,brand]of Object.entries(GPON_VENDORS))if(brand&&out.device_serial.startsWith(code)){out.device_make=brand;break;}}
 return out;
}
async function readDeviceLabel(src,progress=()=>{}){
 const image=await loadDeviceImage(src);
 progress('Looking for barcodes…');await loadDeviceScript('/ocr/zxing.min.js',()=>window.ZXing).catch(()=>{});
 const codes=[...new Set([0,1,2,3].flatMap(turns=>deviceBarcodes(prepareDeviceImage(image,turns))))];
 progress('Reading the label text… (the first photo takes longer while the reader loads)');const worker=await deviceOcr();
 // Try the photo as taken, then turned, and keep the reading that fills the most fields.
 let best=null;
 for(const turns of [0,1,3,2]){
  if(turns)progress(`Trying the photo turned ${turns*90}°…`);
  const {data}=await worker.recognize(prepareDeviceImage(image,turns)),text=(data.text||'').trim(),fields=parseDeviceLabel(text,codes),score=filledDeviceFields(fields)*100+Number(data.confidence||0);
  if(!best||score>best.score)best={fields,text,codes,score};
  if(filledDeviceFields(fields)>=3)break;
 }
 return best;
}
if(typeof module!=='undefined')module.exports={parseDeviceLabel,cleanDeviceMac};
