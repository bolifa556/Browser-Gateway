import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),root=process.env.DATA_ROOT||'/app/data';
const browser=await chromium.launch({channel:'chrome',headless:false,args:['--no-sandbox']});
const report={ok:false,devices:[],errors:[],inputTrace:[]};
const state=async id=>Object.values(await(await fetch('http://127.0.0.1:9314/state')).json()).find(s=>s.id===`gptw:${id}`);
async function waitState(id,predicate,label){
  for(let i=0;i<100;i++){const value=await state(id);if(value&&predicate(value))return value;await sleep(100);}
  throw Error(`${label}: ${JSON.stringify(await state(id))}`);
}
async function open(viewport,dpr){
  const context=await browser.newContext({viewport,deviceScaleFactor:dpr,isMobile:true,hasTouch:true,acceptDownloads:true});
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  page.on('websocket',ws=>ws.on('framesent',({payload})=>{try{const value=JSON.parse(String(payload));if(['text','key','touch','composition'].includes(value.type)){report.inputTrace.push(value);if(report.inputTrace.length>30)report.inputTrace.shift();}}catch{}}));
  await page.goto('http://127.0.0.1:3003/');
  await page.waitForFunction(({width,height,dpr})=>__gptWebStats?.connectionState==='connected'&&document.querySelector('canvas').width===width*dpr&&document.querySelector('canvas').height===height*dpr,{...viewport,dpr},{timeout:30000});
  const id=await page.evaluate(()=>__gptWebSessionId);await waitState(id,s=>s.viewport[0]===viewport.width&&s.viewport[1]===viewport.height&&s.touchCapable,'touch viewport');
  return {context,page,id,cdp:await context.newCDPSession(page)};
}
async function tap(device,name){const s=await state(device.id),r=s.rects[name];await device.page.touchscreen.tap(r.x+Math.min(r.width/2,80),r.y+r.height/2);}
async function swipe(device,from,to,steps=10){
  await device.cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:from.x,y:from.y}]});
  for(let i=1;i<=steps;i++){await device.cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:from.x+(to.x-from.x)*i/steps,y:from.y+(to.y-from.y)*i/steps}]});await sleep(16);}
  await device.cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
async function interactions(device,label){
  const {page,id}=device;await tap(device,'tap');await waitState(id,s=>s.taps===1,'tap without duplicate click');
  await tap(device,'editor');await page.waitForFunction(()=>document.activeElement?.id==='ime');
  await page.keyboard.insertText('手机A');await waitState(id,s=>s.editor==='手机A','mobile insertText');
  await page.keyboard.press('Backspace');await waitState(id,s=>s.editor==='手机','mobile backspace');
  await page.evaluate(()=>{
    const ime=document.querySelector('#ime');ime.dispatchEvent(new CompositionEvent('compositionstart'));
    ime.dispatchEvent(new CompositionEvent('compositionupdate',{data:'中文'}));
    ime.dispatchEvent(new CompositionEvent('compositionend',{data:'中文'}));
    ime.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'中文',cancelable:true}));
  });await waitState(id,s=>s.editor==='手机中文','mobile composition deduplication');
  await tap(device,'multiline');await page.keyboard.insertText('line1');await page.keyboard.press('Enter');await page.keyboard.insertText('line2');
  await waitState(id,s=>s.multiline==='line1\nline2','mobile multiline Enter');
  const filechooser=page.waitForEvent('filechooser',{timeout:8000});await tap(device,'upload');
  await(await filechooser).setFiles({name:'touch-test.txt',mimeType:'text/plain',buffer:Buffer.from('touch fixture')});
  await waitState(id,s=>s.files.includes('touch-test.txt'),'touch file chooser');
  const download=page.waitForEvent('download',{timeout:8000});await tap(device,'download');const file=await download;
  assert.equal(await fs.readFile(await file.path(),'utf8'),'touch-download-ok');
  let s=await state(id),r=s.rects.scroller;await swipe(device,{x:r.x+100,y:r.y+r.height-24},{x:r.x+100,y:r.y+24});
  s=await waitState(id,s=>s.scroll>60,'native finger scroll');assert.equal(s.taps,1);
  assert.equal(await page.evaluate(()=>document.activeElement?.id==='ime'),false,'scroll must not open keyboard');
  const before=s.scroll;await swipe(device,{x:r.x+100,y:r.y+24},{x:r.x+100,y:r.y+r.height-24});
  await waitState(id,s=>s.scroll<before,'reverse finger scroll');
  await tap(device,'language');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await waitState(id,s=>s.language==='zh','dropdown after touch');
  const target=(await state(id)).selectionPoint;assert.ok(target,'visible selectable text');
  await device.cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,...target}]});await sleep(750);
  await device.cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const selected=await waitState(id,s=>s.selection.length>0,'long press text selection');
  const copied=await page.evaluate(()=>{const data=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain');});
  assert.equal(copied,selected.selection,'mobile selection copy');
  const geometry=await page.evaluate(()=>{
    const canvas=document.querySelector('canvas'),stage=document.querySelector('#stage'),visual=visualViewport;
    const data=canvas.getContext('2d').getImageData(0,0,canvas.width,Math.min(700,canvas.height)).data;let ink=0;
    for(let n=0;n<data.length;n+=16)if(data[n]<220||data[n+1]<220||data[n+2]<220)ink++;
    return {canvas:[canvas.width,canvas.height],stage:[stage.clientWidth,stage.clientHeight],stageRect:stage.getBoundingClientRect().toJSON(),
      visual:[visual.width,visual.height,visual.offsetLeft,visual.offsetTop,visual.scale],scroll:[scrollX,scrollY],ink};
  });
  assert.ok(geometry.ink>500,'decoded canvas must contain the fixture');
  await fs.mkdir(`${root}/check-results`,{recursive:true});const screenshot=await page.screenshot({path:`${root}/check-results/${label}.png`});
  const presentedInk=await page.evaluate(async data=>{
    const img=new Image();img.src=data;await img.decode();const surface=document.createElement('canvas');surface.width=img.width;surface.height=Math.min(700,img.height);
    const ctx=surface.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,surface.width,surface.height).data;let ink=0;
    for(let n=0;n<pixels.length;n+=16)if(pixels[n]<220||pixels[n+1]<220||pixels[n+2]<220)ink++;return ink;
  },`data:image/png;base64,${screenshot.toString('base64')}`);
  assert.ok(presentedInk>500,'composited mobile screenshot must contain the rendered page');geometry.presentedInk=presentedInk;
  await fs.writeFile(`${root}/check-results/${label}-canvas.png`,Buffer.from(await page.evaluate(()=>document.querySelector('canvas').toDataURL().split(',')[1]),'base64'));
  return {geometry,functions:['tap','software-text','delete','Chinese-IME','multiline','filechooser','download','scroll','reverse-scroll','dropdown','long-press-selection','selection-copy']};
}
try{
  const phone=await open({width:390,height:844},3);const phoneResult=await interactions(phone,'phone-390');
  report.devices.push({name:'phone',viewport:[390,844,3],...phoneResult});console.log('Phone interaction tests passed');
  await phone.page.setViewportSize({width:844,height:390});
  await phone.page.waitForFunction(()=>document.querySelector('canvas').width===2532&&document.querySelector('canvas').height===1170);
  await waitState(phone.id,s=>s.viewport[0]===844&&s.viewport[1]===390,'phone landscape');
  await phone.page.setViewportSize({width:390,height:460});
  await phone.page.waitForFunction(()=>document.querySelector('canvas').width===1170&&document.querySelector('canvas').height===1380);
  await waitState(phone.id,s=>s.viewport[1]===460,'keyboard-sized visible viewport');
  await phone.page.setViewportSize({width:390,height:844});await waitState(phone.id,s=>s.viewport[1]===844,'keyboard dismissed viewport');
  report.orientation=true;report.keyboardViewport=true;
  await phone.context.close();
  const tablet=await open({width:768,height:1024},2);report.devices.push({name:'tablet',viewport:[768,1024,2],...await interactions(tablet,'tablet-768')});
  await tablet.page.setViewportSize({width:1024,height:768});await tablet.page.waitForFunction(()=>document.querySelector('canvas').width===2048&&document.querySelector('canvas').height===1536);
  await waitState(tablet.id,s=>s.viewport[0]===1024&&s.viewport[1]===768,'tablet landscape');await tablet.context.close();
  const small=await open({width:360,height:800},2);report.devices.push({name:'small-phone',viewport:[360,800,2]});await small.context.close();
  assert.deepEqual(report.errors,[]);report.ok=true;
}catch(error){report.failure=error.stack;process.exitCode=1;}finally{
  await fs.mkdir(`${root}/check-results`,{recursive:true});await fs.writeFile(`${root}/check-results/mobile-e2e.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));await browser.close();
}
