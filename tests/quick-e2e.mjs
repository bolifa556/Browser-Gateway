import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:3840,height:2160},deviceScaleFactor:1,acceptDownloads:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
  await page.goto('http://127.0.0.1:3003/');await page.waitForFunction(()=>globalThis.__gptWebStats?.frames>0&&document.querySelector('canvas').width===3840,null,{timeout:30000});
  await page.waitForTimeout(1000);
  const state=await page.evaluate(()=>({stats:globalThis.__gptWebStats,notice:document.querySelector('#notice').textContent,canvas:[document.querySelector('canvas').width,document.querySelector('canvas').height],color:[...document.querySelector('canvas').getContext('2d').getImageData(40,350,4,1).data]}));
  console.log(JSON.stringify({state,errors}));
  await fs.mkdir('/app/data/check-results',{recursive:true});await page.screenshot({path:'/app/data/check-results/4k.png'});
  await page.mouse.click(240,120);await page.keyboard.type('ABC test');await page.waitForTimeout(400);
  console.log('fixture='+await(await fetch('http://127.0.0.1:9314/state')).text());
}catch(error){console.log(JSON.stringify({error:error.message,errors,state:await page.evaluate(()=>({stats:globalThis.__gptWebStats,notice:document.querySelector('#notice')?.textContent,connection:document.querySelector('#connection')?.textContent})).catch(()=>null)}));throw error;}finally{await browser.close();}
