import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:3840,height:2160},acceptDownloads:true});
const page=await context.newPage();
try{
  await page.goto('http://127.0.0.1:3003/');await page.waitForFunction(()=>__gptWebStats.frames>0&&document.querySelector('canvas').width===3840);await page.waitForTimeout(Number(process.env.TEST_WARMUP_MS||'1000'));
  for(let i=0;i<5;i++){const event=page.waitForEvent('download',{timeout:10000});await page.mouse.click(230,580);const d=await event;console.log('download '+i+' '+d.suggestedFilename());await page.waitForTimeout(300);}
}finally{await browser.close();}
