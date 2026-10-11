import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1653,height:917},deviceScaleFactor:1.25});
await context.addInitScript(()=>sessionStorage.setItem('gptw_tab','duplicate-original-tab'));
const state=async id=>Object.values(await(await fetch('http://127.0.0.1:9314/state')).json()).find(v=>v.id===`gptw:${id}`);
async function waitState(id,test){for(let i=0;i<50;i++){const s=await state(id);if(s&&test(s))return s;await new Promise(r=>setTimeout(r,100));}throw Error('Fixture state timeout');}
async function open(){const p=await context.newPage();await p.goto('http://127.0.0.1:3003/');await p.waitForFunction(()=>__gptWebStats.frames>0&&document.querySelector('canvas').width===2066&&document.querySelector('canvas').height===1146);return {p,id:await p.evaluate(()=>__gptWebSessionId)};}
try{
  const a=await open(),b=await open();assert.notEqual(a.id,b.id);
  assert.deepEqual(await a.p.evaluate(()=>[...document.querySelector('canvas').getContext('2d').getImageData(180,50,1,1).data]),[255,0,0,255]);
  assert.deepEqual(await a.p.evaluate(()=>[...document.querySelector('canvas').getContext('2d').getImageData(2046,1126,1,1).data]),[0,255,255,255]);
  await a.p.mouse.click(240,120);await a.p.keyboard.type('ONE');await waitState(a.id,s=>s.text==='ONE');
  await b.p.mouse.click(240,120);await b.p.keyboard.type('TWO');await waitState(b.id,s=>s.text==='TWO');
  assert.equal((await state(a.id)).text,'ONE');
  await a.p.evaluate(()=>{const d=new DataTransfer();d.items.add(new File(['test'],'文件-拖放.txt',{type:'text/plain'}));document.querySelector('canvas').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d,clientX:240,clientY:250}));});
  await waitState(a.id,s=>s.drops.includes('文件-拖放.txt'));
  await a.p.mouse.click(240,120);await a.p.evaluate(()=>{const d=new DataTransfer();d.items.add(new File(['png-test'],'图片-粘贴.png',{type:'image/png'}));document.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));});
  await waitState(a.id,s=>s.pastes.includes('图片-粘贴.png'));
  await a.p.reload();await a.p.waitForFunction(()=>__gptWebStats.frames>0);assert.equal(await a.p.evaluate(()=>__gptWebSessionId),a.id);
  await waitState(a.id,s=>s.text==='');assert.equal((await state(b.id)).text,'TWO');
  console.log(JSON.stringify({ok:true,duplicateTabsIndependent:true,reloadKeepsOwnWindow:true,fractionalDpr:1.25,physicalSize:[2066,1146],chineseFilenames:true}));
}finally{await browser.close();}
