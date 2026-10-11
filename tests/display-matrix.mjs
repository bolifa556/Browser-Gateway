import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
const state=async id=>Object.values(await(await fetch('http://127.0.0.1:9314/state')).json()).find(v=>v.id===`gptw:${id}`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];
let current;
try{
  for(const dpr of [.75,1,1.25,1.5,2,3]){
    const c=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:dpr});
    const p=await c.newPage();current={p,dpr};await p.goto('http://127.0.0.1:3003/');
    for(const [width,height] of [[1280,800],[1653,917],[1280,800]]){
      await p.setViewportSize({width,height});
      const physical=[Math.round(width*dpr),Math.round(height*dpr)];
      Object.assign(current,{width,height,physical});
      await p.waitForFunction(({physical,dpr})=>{const c=document.querySelector('canvas');if(c.width!==physical[0]||c.height!==physical[1]||!__gptWebStats.frames)return false;const b=c.getContext('2d').getImageData(c.width-Math.round(30*dpr),c.height-Math.round(10*dpr),1,1).data;return b[0]===0&&b[1]===255&&b[2]===255;},{physical,dpr});
      assert.deepEqual(await p.evaluate(()=>[...document.querySelector('canvas').getContext('2d').getImageData(20,20,1,1).data]),[255,0,0,255]);
      const id=await p.evaluate(()=>__gptWebSessionId);
      for(let n=0;n<50;n++){const s=await state(id);if(s?.viewport[0]===width&&s?.viewport[1]===height&&s?.viewport[2]===dpr)break;await sleep(100);}
      assert.deepEqual((await state(id)).viewport,[width,height,dpr]);
      results.push({viewport:[width,height,dpr],physical,fullCorners:true});
    }
    await p.mouse.click(240,120);await p.keyboard.type(`DPR-${dpr}`);
    const id=await p.evaluate(()=>__gptWebSessionId);
    for(let n=0;n<50&&(await state(id))?.text!==`DPR-${dpr}`;n++)await sleep(100);
    assert.equal((await state(id)).text,`DPR-${dpr}`);
    await p.mouse.move(1000,500);await p.mouse.wheel(0,100);
    for(let n=0;n<50&&Math.abs(((await state(id))?.scroll?.[1]||0)-100)>1;n++)await sleep(100);
    assert.ok(Math.abs((await state(id)).scroll[1]-100)<=1,`Wheel mismatch at DPR ${dpr}: ${(await state(id)).scroll[1]}`);
    await c.close();await sleep(1100);
  }
  console.log(JSON.stringify({ok:true,results,inputAlignedAtEveryDpr:true,wheel100CssPixelsAtEveryDpr:true}));
}catch(error){
  const {p,...expected}=current;const id=await p.evaluate(()=>__gptWebSessionId);
  const pixels=await p.evaluate(()=>{const c=document.querySelector('canvas'),x=c.getContext('2d');return {size:[c.width,c.height],stats:{...__gptWebStats,samples:undefined},nearCorner:[...x.getImageData(c.width-30,c.height-10,1,1).data]};});
  await p.screenshot({path:'/app/data/test-results/dpi-failure.png'});
  console.log(JSON.stringify({ok:false,expected,fixture:await state(id),pixels,results,error:error.message}));throw error;
}finally{await browser.close();}
