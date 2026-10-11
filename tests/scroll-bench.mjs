import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
const results=[];
const clientCount=Math.max(1,Math.min(4,Number(process.env.TEST_CLIENTS)||1));
const quantile=(a,p)=>a.length?a.slice().sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))]:null;
try{
 await fs.mkdir('/app/data/test-results',{recursive:true});
 for(const dpr of [1.5,2]){
  const clients=await Promise.all(Array.from({length:clientCount},async()=>{
   const context=await browser.newContext({viewport:{width:Math.round(3840/dpr),height:Math.round(2160/dpr)},deviceScaleFactor:dpr});
   const page=await context.newPage();await page.goto('http://127.0.0.1:3003/');
   await page.waitForFunction(()=>__gptWebStats?.width===3840&&__gptWebStats.frames>0);
   return {context,page,id:await page.evaluate(()=>__gptWebSessionId)};
  }));
  await pause(1200);
  for(const v of clients)v.start=await v.page.evaluate(()=>({at:performance.now(),frames:__gptWebStats.frames,bytes:__gptWebStats.bytes}));
  await fetch('http://127.0.0.1:9436/start?ids='+encodeURIComponent(clients.map(v=>`gptw:${v.id}`).join(',')));await pause(6200);await fetch('http://127.0.0.1:9436/stop');await pause(350);
  const sources=Object.values(await(await fetch('http://127.0.0.1:9436/state')).json());
  for(const [index,{page,id,start}] of clients.entries()){
  const state=await page.evaluate(start=>{
   const end=performance.now(),s=__gptWebStats,rows=s.samples.filter(v=>v.at>=start.at+300&&v.at<start.at+6000);
   return {dpr:devicePixelRatio,size:[s.width,s.height],frames:s.frames-start.frames,bytes:s.bytes-start.bytes,durationMs:end-start.at,rows,latest:{decodeMs:s.decodeMs,encodeMs:s.encodeMs,copyMs:s.copyMs}};
  },start);
  const source=sources.find(v=>v.id===`gptw:${id}`);
  const gaps=state.rows.slice(1).map((v,i)=>v.at-state.rows[i].at);
  results.push({...state,client:index+1,clientCount,rows:undefined,sampleFrames:state.rows.length,activeFps:state.rows.length>1?(state.rows.length-1)*1000/(state.rows.at(-1).at-state.rows[0].at):0,decodeMedianMs:quantile(state.rows.map(v=>v.decodeMs),.5),decodeP95Ms:quantile(state.rows.map(v=>v.decodeMs),.95),copyMedianMs:quantile(state.rows.map(v=>v.copyMs).filter(Number.isFinite),.5),encodeMedianMs:quantile(state.rows.map(v=>v.encodeMs).filter(Number.isFinite),.5),frameGapP95Ms:quantile(gaps,.95),sourceFps:source?.frames*1000/Math.max(1,source?.last-source?.first)});
  if(index===0)await page.screenshot({path:`/app/data/test-results/scroll-${dpr}.png`});
  }
  await Promise.all(clients.map(v=>v.context.close()));await pause(1200);
 }
 const report={ok:true,clientCount,results};console.log(JSON.stringify(report));
 await fs.writeFile(`/app/data/test-results/scroll-bench-${clientCount}clients.json`,JSON.stringify(report,null,2));
}finally{await browser.close();}
