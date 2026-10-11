// Compare transported RGB to Chrome's own screenshot at the same physical DPI.
// Runs only against the disposable localhost fixture, never a logged-in profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {BrowserManager} from '../src/browser-manager.js';
import {config} from '../src/config.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const logger={info(){},warn(){},error(){},prune(){}};
const store={get(){return null;},update(){},flush(){}};
const manager=new BrowserManager({...config,profileDir:'/app/data/pixel-check-profile'},store,logger);
const client=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
const page=await client.newPage();
const results=[];
try{
 await fs.mkdir('/app/data/pixel-check-profile',{recursive:true});
 await manager.startControlledBrowser();
 const session=await manager.getOrCreateSession('fixture-pixel-fidelity');
 await session.page.waitForURL('http://127.0.0.1:9436/',{waitUntil:'load'});
 for(const dpr of [1,1.5,2]){
  const width=Math.round(3840/dpr),height=Math.round(2160/dpr),w=Math.round(width*dpr),h=Math.round(height*dpr);
  const wasm=(await WebAssembly.instantiate(await fs.readFile('/app/public/qoi.wasm'),{})).instance.exports;
  let rasterBytes,frames=0;
  const socket={readyState:1,bufferedAmount:0,close(){this.readyState=3;},send(raw,options){
   if(!options?.binary)return;
   const packet=Buffer.from(raw),raster=(wasm.heap_base()+15)&~15,scratch=raster+w*h*4,input=scratch+32768;
   if(packet.readUInt16LE(8)!==w||packet.readUInt16LE(10)!==h)return;
   const needed=input+packet.length;if(needed>wasm.memory.buffer.byteLength)wasm.memory.grow(Math.ceil((needed-wasm.memory.buffer.byteLength)/65536));
   new Uint8Array(wasm.memory.buffer,input,packet.length).set(packet);
   assert.ok(wasm.decode_packet(input,packet.length,raster,scratch,w,h));
   rasterBytes=Buffer.from(new Uint8Array(wasm.memory.buffer,raster,w*h*4));frames++;
   queueMicrotask(()=>session.frameFlow?.ack(socket,packet.readUInt32LE(4)));
  }};
  await session.resize({width,height,deviceScaleFactor:dpr});session.addClient(socket);
  for(let n=0;n<100&&!frames;n++)await pause(50);assert.ok(frames);await pause(800);
  // Playwright caches the startup viewport (1280x800); CDP sees the actual
  // native/emulated surface. Do not compare a clipped startup-size screenshot.
  const screenshot=Buffer.from((await session.cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false})).data,'base64');
  const comparison=await page.evaluate(async({source,pixels,w,h,dpr})=>{
   const img=new Image();img.src='data:image/png;base64,'+source;await img.decode();
   const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
   const ctx=canvas.getContext('2d',{alpha:false,colorSpace:'srgb'});ctx.drawImage(img,0,0);
   const expected=ctx.getImageData(0,0,img.width,img.height).data,actual=Uint8Array.from(atob(pixels),c=>c.charCodeAt(0));
   // The native browser toolbar casts a shadow over the first few content rows;
   // DevTools screenshots omit that UI overlay. Report it, don't mistake it for
   // codec loss or silently count it as a font/scaling difference.
   const shadowRows=8;
   let different=0,contentDifferent=0,maxError=0,left=w,top=h,right=0,bottom=0;const examples=[];
   for(let i=0;i<Math.min(expected.length,actual.length);i++){
    if(expected[i]!==actual[i]){
     different++;const pixel=Math.floor(i/4),x=pixel%w,y=Math.floor(pixel/w);if(y>=shadowRows)contentDifferent++;left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
     if(examples.length<12&&i%4===0)examples.push({x,y,expected:[...expected.slice(i,i+4)],actual:[...actual.slice(i,i+4)]});
    }
    maxError=Math.max(maxError,Math.abs(expected[i]-actual[i]));
   }
   const transported=document.createElement('canvas');transported.width=w;transported.height=h;transported.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(actual),w,h),0,0);
   return {source:[img.width,img.height],transport:[w,h],differentBytes:different,nativeToolbarShadowRows:shadowRows,contentDifferentBytes:contentDifferent,maxChannelError:maxError,bounds:[left,top,right,bottom],examples,transportPng:transported.toDataURL('image/png').split(',')[1]};
  },{source:screenshot.toString('base64'),pixels:rasterBytes.toString('base64'),w,h,dpr});
  await fs.mkdir('/app/data/test-results',{recursive:true});
  await fs.writeFile(`/app/data/test-results/fidelity-source-${dpr}.png`,screenshot);
  await fs.writeFile(`/app/data/test-results/fidelity-transport-${dpr}.png`,Buffer.from(comparison.transportPng,'base64'));
  delete comparison.transportPng;results.push({dpr,...comparison});console.log(JSON.stringify({comparison:results.at(-1)}));
  assert.deepEqual(comparison.source,[w,h]);assert.equal(comparison.contentDifferentBytes,0);
  session.removeClient(socket);await pause(1100);
 }
 const report={ok:true,results,method:'Chrome screenshot vs transported RGBA; static text, edges and 1px grid; report native toolbar overlay separately'};
 console.log(JSON.stringify(report));await fs.writeFile('/app/data/test-results/stream-pixel-fidelity.json',JSON.stringify(report,null,2));
}finally{await manager.stop();await client.close();}
