// Session-scoped, bounded rendering probe. No URLs, content, cookie values or
// browser-wide debugging port are returned or recorded.
export async function measureRender(page, point = {}) {
  return page.evaluate(({ x, y }) => new Promise(resolve => {
    const start = performance.now();let frames = 0,raf;
    const tick = () => {frames++;raf = requestAnimationFrame(tick);};
    raf = requestAnimationFrame(tick);
    setTimeout(() => {
      cancelAnimationFrame(raf);
      const element = document.elementFromPoint(x, y),style = element ? getComputedStyle(element) : null;
      const scroll = [...document.querySelectorAll('*')]
        .filter(e => e.scrollHeight > e.clientHeight + 100 && ['auto','scroll'].includes(getComputedStyle(e).overflowY))
        .map(e => ({top:e.scrollTop,height:e.clientHeight,max:e.scrollHeight-e.clientHeight})).slice(0,8);
      resolve({durationMs:performance.now()-start,animationFrames:frames,visibility:document.visibilityState,
        focus:document.hasFocus(),viewport:[innerWidth,innerHeight,devicePixelRatio],scroll,
        hit:element?{editable:element.isContentEditable,cursor:style.cursor,userSelect:style.userSelect}:null});
    },1000);
  }),{x:Number(point.x)||0,y:Number(point.y)||0});
}
