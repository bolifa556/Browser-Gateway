// Input must not wait for the client's display clock. Visible/occluded windows
// can have heavily throttled rAF even while ordinary timers continue normally.
// Coalesce for at most one short timer turn, flushing at every button boundary.
export function installPointerInput(canvas,{send,point,focus,now=()=>performance.now(),schedule=fn=>setTimeout(fn,8),cancel=clearTimeout}){
  let move=null,frame=0,click={at:0,x:0,y:0,button:-1,count:0};
  const buttons=new Map();
  const names=['left','middle','right','back','forward'];
  const dragButton=mask=>mask&1?'left':mask&2?'right':mask&4?'middle':mask&8?'back':mask&16?'forward':'none';
  const modifiers=e=>(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
  const flush=()=>{if(frame)cancel(frame);frame=0;if(move){send(move);move=null}};
  const mouse=(e,type,count=0)=>send({type:'mouse',eventType:type,...point(e),button:names[e.button]||'none',buttons:e.buttons||0,clickCount:count,modifiers:modifiers(e)});
  canvas.addEventListener('pointermove',e=>{
    move={type:'mouse',eventType:'mouseMoved',...point(e),button:dragButton(e.buttons||0),buttons:e.buttons||0,modifiers:modifiers(e)};
    if(!frame)frame=schedule(()=>{frame=0;if(move){send(move);move=null}});
  });
  canvas.addEventListener('pointerdown',e=>{
    e.preventDefault();flush();focus();const at=now(),p=point(e),same=at-click.at<500&&Math.abs(p.x-click.x)<4&&Math.abs(p.y-click.y)<4&&e.button===click.button;
    click={at,...p,button:e.button,count:same?Math.min(3,click.count+1):1};
    buttons.set(e.button,{...p,pointerId:e.pointerId});canvas.setPointerCapture(e.pointerId);mouse(e,'mousePressed',click.count);
  });
  canvas.addEventListener('pointerup',e=>{
    e.preventDefault();flush();mouse(e,'mouseReleased',click.count);buttons.delete(e.button);
    if(!buttons.size&&canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
  });
  const release=()=>{
    const p=move?{x:move.x,y:move.y}:null;flush();
    for(const [button,last]of buttons)send({type:'mouse',eventType:'mouseReleased',...(p||last),button:names[button],buttons:0,clickCount:1,modifiers:0});
    buttons.clear();
  };
  canvas.addEventListener('pointercancel',release);canvas.addEventListener('lostpointercapture',release);
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  return {release,reset(){if(frame)cancel(frame);frame=0;move=null;buttons.clear();click={at:0,x:0,y:0,button:-1,count:0}}};
}
