import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const baseline=process.env.TEST_BASELINE==='true';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
const report={baseline,tests:[],errors:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const state=async id=>(await(await fetch('http://127.0.0.1:9314/state')).json())[`gptw:${id}`];
const copy=p=>p.evaluate(()=>{const d=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:d,bubbles:true,cancelable:true}));return d.getData('text/plain')});
try{
  for(const dpr of [1,1.5,2]){
    const c=await browser.newContext({viewport:{width:1600,height:900},deviceScaleFactor:dpr});const p=await c.newPage();p.on('pageerror',e=>report.errors.push(e.message));
    await p.goto('http://127.0.0.1:3003/');await p.waitForFunction(dpr=>__gptWebStats.frames>0&&document.querySelector('canvas').width===1600*dpr,dpr);const id=await p.evaluate(()=>__gptWebSessionId);
    for(let n=0;n<50&&!(await state(id))?.child;n++)await sleep(100);
    const test={dpr,hover:[],drags:[]};report.tests.push(test);
    for(const [name,expected,offset]of [['plain','text',32],['link','pointer',30],['button','default',40],['blocked','default',30],['explicit','crosshair',30],['input','text',40],['editable','text',40]]){
      const r=(await state(id)).rects[name];await p.mouse.move(r.x+offset,r.y+16);await sleep(80);const cursor=await p.locator('canvas').evaluate(e=>e.style.cursor);test.hover.push({name,cursor,expected});if(!baseline)assert.equal(cursor,expected,name+' hover at DPR '+dpr);
    }
    const r=(await state(id)).rects.plain;
    for(const mode of ['frontend','wire-none','wire-left','fast']){
      await p.mouse.click(750,600);await sleep(50);
      if(mode==='frontend'){await p.mouse.move(r.x+2,r.y+16);await p.mouse.down();await p.mouse.move(r.x+240,r.y+16,{steps:12});await p.mouse.up()}
      else if(mode==='fast'){const cdp=await c.newCDPSession(p);await Promise.all([cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:r.x+2,y:r.y+16,button:'left',buttons:1,clickCount:1}),cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x+242,y:r.y+16,button:'left',buttons:1}),cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:r.x+242,y:r.y+16,button:'left',buttons:0,clickCount:1})]);await cdp.detach()}
      else await p.evaluate(({x,y,mode})=>{__gptWebSend({type:'mouse',eventType:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});__gptWebSend({type:'mouse',eventType:'mouseMoved',x:x+240,y,button:mode==='wire-left'?'left':'none',buttons:1});__gptWebSend({type:'mouse',eventType:'mouseReleased',x:x+240,y,button:'left',buttons:0,clickCount:1})},{x:r.x+2,y:r.y+16,mode});
      await sleep(200);const s=await state(id),copied=await copy(p);test.drags.push({mode,selected:s.selected,copied,events:s.events.slice(-6)});if(!baseline&&mode!=='wire-none'){assert.ok(s.selected.length>5,mode+' selection');assert.equal(copied,s.selected,mode+' copy')}
    }
    const multi=(await state(id)).rects.multiline;await p.mouse.move(multi.x+2,multi.y+16);await p.mouse.down();await p.mouse.move(multi.x+150,multi.y+80,{steps:15});await p.mouse.up();await sleep(150);test.multiline={selected:(await state(id)).selected,copied:await copy(p)};if(!baseline){assert.match(test.multiline.selected,/Second line/);assert.equal(test.multiline.copied,test.multiline.selected)}
    await p.mouse.dblclick(r.x+30,r.y+16);await sleep(150);test.doubleClick=(await state(id)).selected;if(!baseline)assert.equal(test.doubleClick,'Alpha');
    await p.mouse.click(r.x+30,r.y+16,{clickCount:3});await sleep(150);test.tripleClick=(await state(id)).selected;if(!baseline)assert.match(test.tripleClick,/鼠标拖动选择/);
    const input=(await state(id)).rects.input;await p.mouse.move(input.x+5,input.y+20);await p.mouse.down();await p.mouse.move(input.x+140,input.y+20,{steps:10});await p.mouse.up();await sleep(150);test.inputSelection={selected:(await state(id)).inputSelected,copied:await copy(p)};if(!baseline){assert.ok(test.inputSelection.selected.length>5);assert.equal(test.inputSelection.copied,test.inputSelection.selected)}
    const child=(await state(id)).child.rects.plain;await p.mouse.move(800+child.x+32,24+child.y+16);await sleep(80);test.childCursor=await p.locator('canvas').evaluate(e=>e.style.cursor);await p.mouse.move(800+child.x+2,24+child.y+16);await p.mouse.down();await p.mouse.move(800+child.x+240,24+child.y+16,{steps:12});await p.mouse.up();await sleep(200);test.childSelection={selected:(await state(id)).child.selected,copied:await copy(p)};if(!baseline){assert.equal(test.childCursor,'text');assert.ok(test.childSelection.selected.length>5);assert.equal(test.childSelection.copied,test.childSelection.selected)}
    await c.close();
  }
  assert.deepEqual(report.errors,[]);report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1}
finally{await browser.close();await fs.mkdir('/app/data/test-results',{recursive:true});await fs.writeFile('/app/data/test-results/pointer-selection'+(baseline?'-baseline':'')+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))}
