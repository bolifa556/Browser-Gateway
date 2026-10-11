import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import os from 'node:os';
const ip=Object.values(os.networkInterfaces()).flat().find(v=>v.family==='IPv4'&&!v.internal)?.address;
// A network-none fixture still needs a genuinely insecure HTTP origin. This
// reserved test hostname resolves locally without granting secure-context status.
const origin=process.env.TEST_ORIGIN||(ip?`http://${ip}:3003`:'http://gpt-web.test:3003');
const args=['--no-sandbox'];if(new URL(origin).hostname==='gpt-web.test')args.push('--host-resolver-rules=MAP gpt-web.test 127.0.0.1');
const browser=await chromium.launch({channel:'chrome',headless:true,args});
const context=await browser.newContext({viewport:{width:1280,height:800}});
const page=await context.newPage();
try{
  await page.goto(origin);await page.waitForFunction(()=>__gptWebStats.frames>0);await page.waitForTimeout(1000);
  const secure=await page.evaluate(()=>({secure:isSecureContext,clipboardAPI:Boolean(navigator.clipboard)}));assert.equal(secure.secure,false);
  await page.mouse.click(425,585);await page.waitForTimeout(300);
  const helper=await context.newPage();await helper.goto('http://127.0.0.1:9314/');await context.grantPermissions(['clipboard-read'],{origin:'http://127.0.0.1:9314'});
  const copied=await helper.evaluate(()=>navigator.clipboard.readText());assert.equal(copied,'原生复制-test');await helper.close();
  await page.bringToFront();await page.mouse.click(240,120);
  await page.evaluate(async()=>{
    const ime=document.querySelector('#ime');
    ime.dispatchEvent(new CompositionEvent('compositionstart',{data:''}));
    ime.dispatchEvent(new CompositionEvent('compositionupdate',{data:'中文输入'}));
    await new Promise(r=>setTimeout(r,50));
    ime.dispatchEvent(new CompositionEvent('compositionend',{data:'中文输入'}));
    ime.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'中文输入',cancelable:true}));
  });
  await page.waitForTimeout(500);const id=await page.evaluate(()=>__gptWebSessionId);
  const state=Object.values(await(await fetch('http://127.0.0.1:9314/state')).json()).find(v=>v.id===`gptw:${id}`);assert.equal(state.text,'中文输入');
  await page.keyboard.press('Control+A');await page.waitForTimeout(200);
  const copiedSelection=await page.evaluate(()=>{const d=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:d,bubbles:true,cancelable:true}));return d.getData('text/plain');});assert.equal(copiedSelection,'中文输入');
  console.log(JSON.stringify({ok:true,insecureHTTP:secure,buttonCopy:copied,composition:state.text,selectionCopy:copiedSelection}));
}finally{await browser.close();}
