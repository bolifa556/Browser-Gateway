import assert from 'node:assert/strict';
import {chromium} from 'playwright';
// Certificate exceptions are confined to this disposable Linux test profile;
// no end-user browser or OS trust settings are changed.
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1280,height:800},ignoreHTTPSErrors:true,permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage();
try{
  await page.goto('https://127.0.0.1:3003/');await page.waitForFunction(()=>__gptWebStats.frames>0);await page.waitForTimeout(600);
  assert.equal(await page.evaluate(()=>isSecureContext),true);
  await page.mouse.click(425,585);
  await page.waitForFunction(async()=>await navigator.clipboard.readText()==='原生复制-test');
  await page.waitForTimeout(300);
  await page.mouse.click(625,585);
  await page.waitForFunction(()=>__gptWebStats.clipboardImageWrites>0);
  const pixels=await(await page.waitForFunction(async()=>{
    try{
      const items=await navigator.clipboard.read();const item=items.find(v=>v.types.includes('image/png'));if(!item)return false;
      const image=await createImageBitmap(await item.getType('image/png'));const c=document.createElement('canvas');c.width=c.height=2;
      const x=c.getContext('2d');x.drawImage(image,0,0);return [...x.getImageData(0,0,1,1).data];
    }catch{return false;}
  })).jsonValue();
  assert.deepEqual(pixels,[255,0,0,255]);
  await page.goto('http://127.0.0.1:3003/');await page.waitForFunction(()=>__gptWebStats.frames>0);
  console.log(JSON.stringify({ok:true,https:true,textCopy:true,pngCopy:true,pixels,httpAfterHttps:true}));
}finally{await browser.close();}
