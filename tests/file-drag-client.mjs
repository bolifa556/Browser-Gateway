// Full client -> WebSocket preview -> HTTP upload -> native browser acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
assert.equal(process.env.DRAG_TEST_ISOLATED,'true');
const root=process.env.DATA_ROOT||'/app/data',report={ok:false,checks:[],errors:[]};
await fs.mkdir(path.join(root,'tmp'),{recursive:true});
const temporary=await fs.mkdtemp(path.join(root,'tmp/client-file-drag-'));
const file=path.join(temporary,'client-drop.txt');await fs.writeFile(file,'upload-test');
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
let page;const wire=[];
const state=async id=>Object.values(await(await fetch('http://127.0.0.1:9314/state')).json()).find(s=>s.id===`gptw:${id}`);
async function wait(id,predicate){for(let i=0;i<120;i++){const s=await state(id);if(s&&predicate(s))return s;await new Promise(r=>setTimeout(r,100));}throw Error(`Fixture state timeout: ${JSON.stringify(await state(id))}`);}
try{
  const context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:2});
  page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  page.on('websocket',socket=>socket.on('framesent',({payload})=>{try{const m=JSON.parse(String(payload));if(m.type==='file-drag')wire.push(m);}catch{}}));
  await page.addInitScript(()=>{window.dragTrace=[];for(const type of ['dragenter','dragover','dragleave','drop'])window.addEventListener(type,e=>dragTrace.push({type,target:e.target.id,types:[...e.dataTransfer.types],x:e.clientX,y:e.clientY,prevented:e.defaultPrevented}));});
  await page.goto('http://127.0.0.1:3003/');await page.waitForFunction(()=>__gptWebStats?.connectionState==='connected'&&document.querySelector('canvas').width===3840);
  const id=await page.evaluate(()=>__gptWebSessionId);await wait(id,s=>s.viewport[0]===1920);
  const cdp=await context.newCDPSession(page),data={items:[],files:[file],dragOperationsMask:1};
  const drag=(type,x=240,y=260)=>cdp.send('Input.dispatchDragEvent',{type,x,y,data});
  await drag('dragEnter');await drag('dragOver');
  await wait(id,s=>s.dragEvents?.includes('dragenter'));
  assert.deepEqual((await state(id)).drops,[]);
  assert.equal(await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/upload')).length),0);
  await page.screenshot({path:path.join(temporary,'client-preview.png')});
  await drag('dragOver',-1,-1);await drag('dragCancel',-1,-1);await cdp.send('Input.cancelDragging');
  await wait(id,s=>s.dragEvents?.includes('dragleave'));
  assert.deepEqual((await state(id)).drops,[]);
  report.checks.push('client-drag-enter-over-leave-triggers-website-ui-without-upload');
  await drag('dragEnter');await drag('dragOver');await drag('drop');await cdp.send('Input.cancelDragging');
  await wait(id,s=>s.drops.includes('client-drop.txt'));
  await page.waitForFunction(()=>performance.getEntriesByType('resource').some(e=>e.name.includes('/api/upload')&&e.responseStatus===200));
  await page.mouse.click(80,40);await wait(id,s=>s.color==='rgb(0, 255, 0)');
  report.checks.push('drop-uploads-real-file-and-following-mouse-click-is-not-blocked');
  assert.deepEqual(report.errors,[]);report.ok=true;
  const results=path.join(root,'check-results/1.4.4');await fs.mkdir(results,{recursive:true});
  await fs.copyFile(path.join(temporary,'client-preview.png'),path.join(results,'client-native-drag-preview.png'));
}catch(error){report.error=error.stack;report.wire=wire;report.client=await page?.evaluate(()=>({trace:window.dragTrace,state:__gptWebStats.connectionState,hidden:document.hidden})).catch(()=>null);process.exitCode=1;}
finally{
  await browser.close();const results=path.join(root,'check-results/1.4.4');await fs.mkdir(results,{recursive:true});
  await fs.writeFile(path.join(results,'file-drag-client.json'),JSON.stringify(report,null,2));
  await fs.rm(temporary,{recursive:true,force:true});console.log(JSON.stringify(report,null,2));
}
