import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:3003',report={errors:[]};
assert.equal(process.env.CHATGPT_URL,'http://127.0.0.1:9314/','Login tests must use the isolated fixture, never the real account');
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function state(predicate){for(let retry=0;retry<100;retry++){const all=Object.values(await(await fetch('http://127.0.0.1:9314/state')).json()),value=all.find(predicate);if(value)return value;await pause(100);}throw Error('Native fixture state timeout');}
async function auth(viewport={width:1280,height:900},dpr=1.5){
  const context=await browser.newContext({viewport,deviceScaleFactor:dpr});const page=await context.newPage();
  page.on('pageerror',error=>report.errors.push(error.message));await page.goto(`${origin}/admin/signin`);
  await page.locator('#code').fill(process.env.ADMIN_KEY);await page.getByRole('button',{name:'打开管理员页面'}).click();
  await page.waitForURL(`${origin}/admin/signin`);return {context,page};
}
async function anonymous(path,options={}){const response=await fetch(`${origin}${path}`,options);return response.status;}
try{
  assert.equal(await anonymous('/api/native-login'),403);
  assert.equal(await anonymous('/api/native-login/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),403);
  const member=await browser.newPage({viewport:{width:1000,height:700}});await member.goto(origin);
  await member.waitForFunction(()=>globalThis.__gptWebStats?.frames>0);
  const {context,page}=await auth();
  const csrf=await context.request.post(`${origin}/api/native-login/start`,{headers:{Origin:'https://untrusted.invalid'},data:{confirm:true}});
  assert.equal(csrf.status(),403);
  await page.getByRole('button',{name:'开始手动登录',exact:true}).click();
  await page.locator('#finish-login').waitFor({state:'visible',timeout:25000});
  await page.waitForFunction(()=>globalThis.__gptWebStats?.frames>0&&document.querySelector('canvas').width===1920&&document.querySelector('canvas').height===1278,null,{timeout:20000});
  await member.waitForFunction(()=>document.querySelector('#connection').textContent.includes('管理员正在手动登录'));
  assert.equal((await(await fetch(`${origin}/healthz`)).json()).mode,'native-login');
  const foreign=await auth();await foreign.page.getByRole('button',{name:'开始手动登录',exact:true}).click();
  await foreign.page.locator('#start-error').waitFor({state:'visible'});assert.match(await foreign.page.locator('#start-error').textContent(),/另一管理员/);
  const illegalFinish=await foreign.context.request.post(`${origin}/api/native-login/finish`,{headers:{Origin:origin},data:{}});assert.equal(illegalFinish.status(),500);
  await foreign.context.close();
  // Chrome can finish adding its container/sandbox notice after the first paint.
  // Its actual browser toolbar remains visible; don't suppress security notices.
  await pause(2200);
  let native=await state(value=>value.id==='');
  assert.equal(native.webdriver,false);assert.equal(native.clipboardBridge,'undefined');assert.equal(native.viewport[2],1.5);
  report.nativeViewport=native.viewport;report.outerViewport=native.outerViewport;
  report.browserMode={webdriver:native.webdriver,clipboardBridge:native.clipboardBridge};
  for(const pid of await fs.readdir('/proc')){
    if(!/^\d+$/.test(pid))continue;
    const args=await fs.readFile(`/proc/${pid}/cmdline`).then(bytes=>bytes.toString().split('\0')).catch(()=>[]);
    if(args.includes('--user-data-dir=/app/data/profile')&&!args.some(arg=>arg.startsWith('--type='))){
      report.launch={debugging:args.some(arg=>arg.startsWith('--remote-debugging')),headless:args.some(arg=>arg.startsWith('--headless')),testType:args.includes('--test-type'),automation:args.includes('--enable-automation')};
      assert.deepEqual(report.launch,{debugging:false,headless:false,testType:false,automation:false});
    }
  }
  assert.ok(report.launch);
  const chromeTop=native.outerViewport[1]-native.viewport[1];
  const stageTop=await page.locator('#stage').evaluate(node=>node.getBoundingClientRect().top);
  await page.mouse.click(240,stageTop+chromeTop+120);await page.keyboard.type('AbC@!? native');
  native=await state(value=>value.id===''&&value.text==='AbC@!? native');
  await page.evaluate(()=>{const transfer=new DataTransfer();transfer.setData('text/plain',' 中文粘贴');document.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));});
  native=await state(value=>value.id===''&&value.text==='AbC@!? native 中文粘贴');
  await page.evaluate(()=>{__gptWebSend({type:'composition',text:'输入法'});__gptWebSend({type:'composition',text:''});__gptWebSend({type:'text',text:'输入法'});});
  await state(value=>value.id===''&&value.text==='AbC@!? native 中文粘贴输入法');
  await page.keyboard.press('F9');await state(value=>value.id===''&&value.cookie.includes('shared=profile-ok'));
  await page.keyboard.press('F10');await state(value=>value.id===''&&value.cookie.includes('persistent=profile-ok'));
  await page.mouse.click(80,stageTop+chromeTop+40);await state(value=>value.id===''&&value.color==='rgb(0, 255, 0)');
  await page.waitForFunction(y=>{const data=document.querySelector('canvas').getContext('2d').getImageData(60,y,1,1).data;return data[0]===0&&data[1]===255&&data[2]===0;},Math.round((chromeTop+40)*1.5));
  await page.setViewportSize({width:1653,height:917});await page.waitForFunction(()=>document.querySelector('canvas').width===2480&&document.querySelector('canvas').height===1304);
  report.resized=true;
  await page.locator('#finish-login').click();await page.waitForURL(`${origin}/`,{timeout:30000});
  await page.waitForFunction(()=>globalThis.__gptWebStats?.frames>0);
  const id=await page.evaluate(()=>globalThis.__gptWebSessionId);
  const restored=await state(value=>value.id===`gptw:${id}`);report.restoredCookies=restored.cookie;
  await state(value=>value.id===`gptw:${id}`&&value.cookie.includes('shared=profile-ok')&&value.cookie.includes('persistent=profile-ok'));
  await member.waitForFunction(()=>document.querySelector('#connection').hidden);
  assert.equal((await(await fetch(`${origin}/healthz`)).json()).mode,'normal');
  await page.mouse.click(240,120);await page.keyboard.type('restored-native');await state(value=>value.id===`gptw:${id}`&&value.text==='restored-native');
  report.functions=['exclusive-human-login','no-page-bridge','native-pointer','literal-text','unicode-paste','IME-commit','DPR1.5','resize','same-profile-cookie','member-auto-reconnect','input-after-restore','admin-only','cross-origin-denied','other-admin-denied'];
  assert.deepEqual(report.errors,[]);report.ok=true;
  await context.close();await member.close();
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;}
finally{
  console.log(JSON.stringify(report));await fs.mkdir('/app/data/check-results',{recursive:true});await fs.writeFile('/app/data/check-results/native-login.json',JSON.stringify(report,null,2));
  await browser.close();
}
