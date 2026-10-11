import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:3003';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:2560,height:1440},deviceScaleFactor:1.5});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  const health=await(await fetch(`${origin}/healthz`)).json();assert.equal(health.version,'1.3.7');
  await page.goto(origin);await page.waitForFunction(()=>__gptWebStats.frames>0&&document.querySelector('canvas').width===3840&&document.querySelector('canvas').height===2160);
  await page.waitForTimeout(8000);await fs.mkdir('/app/data/test-results',{recursive:true});
  await page.screenshot({path:'/app/data/test-results/site-4k.png'});
  const state=await page.evaluate(()=>({stats:{...__gptWebStats,samples:undefined},viewport:[innerWidth,innerHeight,devicePixelRatio],canvas:[document.querySelector('canvas').width,document.querySelector('canvas').height],connectionHidden:document.querySelector('#connection').hidden,notice:document.querySelector('#notice').textContent}));
  assert.deepEqual(state.canvas,[3840,2160]);assert.deepEqual(state.viewport,[2560,1440,1.5]);assert.equal(errors.length,0);
  console.log(JSON.stringify({ok:true,origin,health,errors,...state}));
}finally{await browser.close();}
