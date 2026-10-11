import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:3003';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const report={origin,errors:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const state=async id=>Object.values(await(await fetch('http://127.0.0.1:9314/state')).json()).find(v=>v.id===`gptw:${id}`);
async function waitState(id,predicate){for(let i=0;i<60;i++){const s=await state(id);if(s&&predicate(s))return s;await sleep(100);}throw Error('Fixture state timeout '+JSON.stringify(await state(id)));}
async function open(viewport,dpr=1){
  const c=await browser.newContext({viewport,deviceScaleFactor:dpr,acceptDownloads:true});const p=await c.newPage();
  p.on('pageerror',e=>report.errors.push(e.message));await p.goto(origin);
  await p.waitForFunction(({w,h})=>__gptWebStats.frames>0&&document.querySelector('canvas').width===w&&document.querySelector('canvas').height===h,{w:viewport.width*dpr,h:viewport.height*dpr},{timeout:30000});
  await sleep(900);const id=await p.evaluate(()=>globalThis.__gptWebSessionId);return {c,p,id};
}
const sendKey=(p,key,code,keyCode)=>p.evaluate(({key,code,keyCode})=>{__gptWebSend({type:'key',eventType:'keyDown',key,code,keyCode});__gptWebSend({type:'key',eventType:'keyUp',key,code,keyCode});},{key,code,keyCode});
try{
  const a=await open({width:3840,height:2160});
  report.pixels=await a.p.evaluate(()=>[...document.querySelector('canvas').getContext('2d').getImageData(40,350,4,1).data]);
  assert.deepEqual(report.pixels,[255,0,0,255,0,0,255,255,255,0,0,255,0,0,255,255]);
  await a.p.mouse.click(240,120);await a.p.keyboard.type('ABC first');await waitState(a.id,s=>s.text==='ABC first');
  await a.p.evaluate(()=>{const e=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:new DataTransfer()});e.clipboardData.setData('text/plain',' 中文粘贴');document.dispatchEvent(e);});
  await waitState(a.id,s=>s.text==='ABC first 中文粘贴');
  await a.p.evaluate(()=>{const d=new DataTransfer();d.items.add(new File(['drop test'],'drop.txt',{type:'text/plain'}));document.querySelector('canvas').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d,clientX:240,clientY:250}));});
  await waitState(a.id,s=>s.drops.includes('drop.txt'));
  await a.p.mouse.click(240,120);
  await a.p.evaluate(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6wQAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'paste.png',{type:'image/png'}));document.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));});
  await waitState(a.id,s=>s.pastes.includes('paste.png'));
  const chooser=a.p.waitForEvent('filechooser');await a.p.mouse.click(240,520);await(await chooser).setFiles({name:'choose.txt',mimeType:'text/plain',buffer:Buffer.from('chooser test')});
  await waitState(a.id,s=>s.files.includes('choose.txt'));
  const dl=a.p.waitForEvent('download');await a.p.mouse.click(230,580);const download=await dl;assert.equal(await fs.readFile(await download.path(),'utf8'),'download-ok-中文');
  await a.p.mouse.click(230,460);await a.p.keyboard.press('ArrowDown');await a.p.keyboard.press('Enter');await waitState(a.id,s=>s.language==='zh');
  await sendKey(a.p,'F9','F9',120);await waitState(a.id,s=>s.cookie.includes('shared=profile-ok'));
  const b=await open({width:1920,height:1080},2);await waitState(b.id,s=>s.cookie.includes('shared=profile-ok'));
  await b.p.mouse.click(240,120);await b.p.keyboard.type('SECOND');await waitState(b.id,s=>s.text==='SECOND');
  assert.equal((await state(a.id)).text,'ABC first 中文粘贴');
  report.dpr2=(await state(b.id)).viewport;assert.deepEqual(report.dpr2,[1920,1080,2]);
  report.dpr2Pixels=await b.p.evaluate(()=>[...document.querySelector('canvas').getContext('2d').getImageData(80,700,4,1).data]);
  assert.deepEqual(report.dpr2Pixels,[255,0,0,255,255,0,0,255,0,0,255,255,0,0,255,255]);
  const [clientWidth,clientHeight]=(await state(b.id)).clientViewport;
  assert.deepEqual(await b.p.evaluate(({x,y})=>[...document.querySelector('canvas').getContext('2d').getImageData(x,y,1,1).data],{x:(clientWidth-10)*2,y:(clientHeight-10)*2}),[0,255,255,255]);
  assert.deepEqual(await b.p.evaluate(()=>[...document.querySelector('canvas').getContext('2d').getImageData(40,2120,1,1).data]),[0,0,0,255]);
  await a.p.mouse.click(80,40);await waitState(a.id,s=>s.color==='rgb(0, 255, 0)');assert.equal((await state(b.id)).color,'');
  await b.c.close();await sleep(1300);
  report.preLatency=await a.p.evaluate(()=>({pixel:[...document.querySelector('canvas').getContext('2d').getImageData(40,40,1,1).data],stats:{...__gptWebStats,samples:undefined}}));
  report.fixtureBeforeLatency=await state(a.id);
  await a.p.waitForFunction(()=>{const p=document.querySelector('canvas').getContext('2d').getImageData(40,40,1,1).data;return p[0]===0&&p[1]===255&&p[2]===0;},null,{timeout:5000});
  report.latency=await a.p.evaluate(async()=>{
    const samples=[],canvas=document.querySelector('canvas'),context=canvas.getContext('2d');let expected=context.getImageData(40,40,1,1).data[0];
    for(let i=0;i<40;i++){
      const start=performance.now();expected=expected?0:255;
      const done=new Promise((resolve,reject)=>{let timer;const inspect=()=>{if(context.getImageData(40,40,1,1).data[0]===expected){clearTimeout(timer);window.removeEventListener('gpt-frame',inspect);resolve(performance.now()-start);}};window.addEventListener('gpt-frame',inspect);timer=setTimeout(()=>{window.removeEventListener('gpt-frame',inspect);reject(Error('Latency frame timeout'));},3000);});
      for(const eventType of ['mousePressed','mouseReleased'])__gptWebSend({type:'mouse',eventType,x:80,y:40,button:'left',buttons:eventType==='mousePressed'?1:0,clickCount:1});
      samples.push(await done);await new Promise(r=>setTimeout(r,30));
    }
    samples.sort((a,b)=>a-b);return {median:samples[20],p95:samples[38],min:samples[0],max:samples[39],method:'input-to-decoded-canvas; not physical display latency'};
  });
  await sendKey(a.p,'F8','F8',119);await sleep(1000);
  const before=await a.p.evaluate(()=>({frames:__gptWebStats.frames,at:performance.now()}));await sleep(6000);
  report.motion=await a.p.evaluate(before=>({fps:(__gptWebStats.frames-before.frames)*1000/(performance.now()-before.at),decodeSamples:__gptWebStats.samples.slice(-120),stats:{...__gptWebStats,samples:undefined}}),before);
  await sendKey(a.p,'F8','F8',119);
  await a.p.setViewportSize({width:1653,height:917});await a.p.waitForFunction(()=>document.querySelector('canvas').width===1653&&document.querySelector('canvas').height===917);
  await waitState(a.id,s=>s.viewport[0]===1653&&s.viewport[1]===917);report.resize=true;
  report.functions=['text','paste-text','paste-image','file-drop','local-filechooser','local-download','select-dropdown','shared-cookie','independent-input','4K','DPR2','resize'];
  assert.equal(report.errors.length,0);report.ok=true;
}catch(error){report.ok=false;report.failure=error.stack;process.exitCode=1;}finally{console.log(JSON.stringify(report));await fs.mkdir('/app/data/check-results',{recursive:true});await fs.writeFile('/app/data/check-results/full-e2e.json',JSON.stringify(report,null,2));await browser.close();}
