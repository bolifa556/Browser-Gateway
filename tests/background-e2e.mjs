import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const root=process.env.DATA_ROOT||'/app/data',sleep=ms=>new Promise(r=>setTimeout(r,ms));
const frozen=process.env.TEST_FROZEN_CLIENT==='true';
const report={ok:false,method:`native Chrome tabs, no forced visibility; ${frozen?'frozen':'normal'} background client`,errors:[]};
const profile=await fs.mkdtemp(`${root}/tmp/background-client-`);
const chrome=spawn('/opt/google/chrome/chrome',['--no-sandbox','--no-first-run','--no-default-browser-check','--disable-gpu',
  `--user-data-dir=${profile}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--window-size=700,1000','about:blank'],{stdio:'ignore'});
let browser;
const state=async id=>(await(await fetch('http://127.0.0.1:9314/state')).json())[`gptw:${id}`];
const waitState=async(id,test)=>{for(let i=0;i<100;i++){const s=await state(id);if(s&&test(s))return s;await sleep(100);}throw Error(`Fixture state timeout: ${JSON.stringify(await state(id))}`);};
const captureProcesses=async id=>{
  const entries=await fs.readdir('/proc');let count=0;
  for(const name of entries.filter(v=>/^\d+$/.test(v))){const command=await fs.readFile(`/proc/${name}/cmdline`,'utf8').catch(()=> '');if(command.startsWith('/app/capture\0')&&command.includes(id))count++;}
  return count;
};
try{
  let port;
  for(let i=0;i<100&&!port;i++){port=await fs.readFile(`${profile}/DevToolsActivePort`,'utf8').then(v=>Number(v.split('\n')[0])).catch(()=>null);if(!port)await sleep(100);}
  assert.ok(port,'native client browser must start');
  // A normal Playwright context forces page visibility. Connecting without
  // defaults preserves genuine foreground/background tab state for this test.
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});
  const context=browser.contexts()[0],page=context.pages()[0];page.on('pageerror',e=>report.errors.push(e.message));
  let hiddenAt=0;page.on('websocket',ws=>ws.on('close',()=>{if(hiddenAt)report.disconnectedAfterMs=Date.now()-hiddenAt;}));
  await page.setViewportSize({width:1280,height:800});await page.goto('http://127.0.0.1:3003/');const cdp=await context.newCDPSession(page);
  await page.bringToFront();
  await page.waitForFunction(()=>__gptWebStats?.connectionState==='connected'&&document.querySelector('canvas').width===1280,null,{polling:100,timeout:30000});
  const id=await page.evaluate(()=>__gptWebSessionId);await waitState(id,s=>s.viewport[0]===1280);
  const editor=(await state(id)).rects.editor;
  await page.mouse.click(editor.x+40,editor.y+20);
  await page.waitForFunction(()=>document.activeElement?.id==='ime',null,{polling:100});
  await page.keyboard.insertText('preserved draft');await waitState(id,s=>s.editor==='preserved draft');
  const helper=await context.newPage();await helper.goto('about:blank');await helper.bringToFront();
  await page.waitForFunction(()=>document.hidden,null,{polling:100});await sleep(500);
  await page.bringToFront();await page.waitForFunction(()=>!document.hidden,null,{polling:100});
  assert.equal(await page.evaluate(()=>__gptWebSessionId),id);assert.ok(await captureProcesses(id)>0);
  report.shortSwitchKeepsSession=true;
  await helper.bringToFront();await page.waitForFunction(()=>document.hidden,null,{polling:100});
  hiddenAt=Date.now();report.captureBefore=await captureProcesses(id);
  if(frozen){await sleep(500);await cdp.send('Page.setWebLifecycleState',{state:'frozen'});}
  console.log(`Native tab hidden; testing one-minute deadline (${frozen?'frozen':'normal'} client)`);
  if(frozen)await sleep(65_000);
  else{
    await sleep(58_000);report.captureAt58Seconds=await captureProcesses(id);
    assert.ok(report.captureAt58Seconds>0,'a normal hidden tab must keep its one-minute grace');
    await sleep(8000);
    assert.ok(report.disconnectedAfterMs>=58_000&&report.disconnectedAfterMs<63_000,'disconnect must occur near the one-minute deadline');
  }
  const paused=await state(id);report.captureAfter=await captureProcesses(id);report.remoteLastUpdateAgoMs=paused.sinceUpdateMs;
  assert.equal(report.captureAfter,0,'hidden session must stop the native capture process');
  assert.ok(paused.sinceUpdateMs>3000,'remote timers must be frozen after one minute');
  if(frozen)await cdp.send('Page.setWebLifecycleState',{state:'active'});await helper.close();await page.bringToFront();
  await page.waitForFunction(()=>__gptWebStats?.connectionState==='connected'&&document.querySelector('canvas').width===1280,null,{polling:100,timeout:30000});
  assert.equal(await page.evaluate(()=>__gptWebSessionId),id);
  await waitState(id,s=>s.editor==='preserved draft'&&s.ticks>paused.ticks);
  report.captureResumed=await captureProcesses(id);assert.ok(report.captureResumed>0);
  report.resumedSameSession=true;report.draftPreserved=true;report.realWaitSeconds=frozen?65:66;
  assert.deepEqual(report.errors,[]);report.ok=true;
}catch(error){report.failure=error.stack;process.exitCode=1;}finally{
  await fs.mkdir(`${root}/check-results`,{recursive:true});await fs.writeFile(`${root}/check-results/background-e2e.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));await browser?.close();chrome.kill('SIGTERM');
}
