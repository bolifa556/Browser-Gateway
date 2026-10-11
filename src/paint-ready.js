// Navigation can replace an about:blank execution context while a first resize
// is waiting for paint. Keep geometry/ready messages alive across that race.
export async function waitForPaint(page) {
  for(let attempt=0;attempt<3;attempt++){
    try{
      return await page.evaluate(()=>new Promise(resolve=>{
        let first,second;const timer=setTimeout(()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);resolve(false);},1000);
        first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{clearTimeout(timer);resolve(true);});});
      }));
    }catch(error){
      if(page.isClosed()||!/Execution context was destroyed|Cannot find context/.test(error.message))throw error;
      if(attempt<2)await page.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{});
    }
  }
  return false;
}
