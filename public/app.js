import {installPointerInput} from './pointer-input.js?v=1.4.1';
import {installTouchInput} from './touch-input.js?v=1.4.1';
import {installImeInput} from './ime-input.js?v=1.4.1';
import {installVisibilityLifecycle} from './visibility-lifecycle.js?v=1.4.1';
const touchDisplay=navigator.maxTouchPoints>0&&matchMedia('(pointer:coarse)').matches;
const canvas=document.querySelector('#screen'),ctx=canvas.getContext('2d',{alpha:false,desynchronized:!touchDisplay,colorSpace:'srgb'});
const ime=document.querySelector('#ime'),picker=document.querySelector('#file-picker'),connection=document.querySelector('#connection'),notice=document.querySelector('#notice');
const stage=document.querySelector('#stage'),nativeLogin=document.body.dataset.mode==='native-login';
let maintenanceMessage='';
let socket,ready=false,remoteWidth=1280,remoteHeight=800,image,lastSequence=0,selection='',selectionHtml='',chooserId='',reconnect=250,viewportSignature='',resizeTimer,noticeTimer,reconnectTimer;
let inputFields=[],inputField={},lastTouchAt=0,touchSelecting=false,chooserPending=false;
const pressed=new Map();
let tab=sessionStorage.getItem('gptw_tab');if(!tab){tab=crypto.randomUUID?.()||`${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;sessionStorage.setItem('gptw_tab',tab);}
const reloadRemote=performance.getEntriesByType('navigation')[0]?.type==='reload';let remoteReloadSent=false;
const stats=globalThis.__gptWebStats={transport:'lossless-qoi',frames:0,bytes:0,samples:[]};
let decoderPromise;
const decoder=()=>decoderPromise??=WebAssembly.instantiateStreaming(fetch('/assets/qoi.wasm'),{}).then(r=>r.instance.exports);
const send=m=>{if(socket?.readyState===1)socket.send(JSON.stringify(m));};
const toast=text=>{notice.textContent=text;notice.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{notice.hidden=true;},2500);};
const point=e=>{const r=stage.getBoundingClientRect();return {x:(e.clientX-r.left)*remoteWidth/Math.max(1,r.width),y:(e.clientY-r.top)*remoteHeight/Math.max(1,r.height)};};
const modifiers=e=>(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
const coarse=()=>navigator.maxTouchPoints>0&&matchMedia('(pointer:coarse)').matches;
const focus=()=>{if(!coarse())ime.focus({preventScroll:true});};
const configureInput=field=>{
  inputField=field||{};ime.readOnly=false;
  ime.inputMode=inputField.inputMode||'text';ime.enterKeyHint=inputField.enterKeyHint||'enter';
};
function layoutStage(){
  const visual=window.visualViewport,toolbar=nativeLogin?(document.querySelector('#manual-controls')?.offsetHeight||48):0;
  stage.style.left=`${visual?.offsetLeft||0}px`;stage.style.top=`${(visual?.offsetTop||0)+toolbar}px`;
  stage.style.width=`${visual?.width||innerWidth}px`;stage.style.height=`${Math.max(1,(visual?.height||innerHeight)-toolbar)}px`;
}
function legacyCopy(){
  const helper=document.createElement('textarea');helper.value=selection;helper.style.cssText='position:fixed;left:-9999px;top:0';document.body.append(helper);helper.focus();helper.select();
  let ok=false;try{ok=document.execCommand('copy');}catch{}helper.remove();focus();if(!ok)toast('当前浏览器限制自动复制，可选中文字后按 Ctrl+C');
}
function viewport(){
  layoutStage();if(!ready||document.hidden)return;
  const width=Math.max(320,stage.clientWidth),height=Math.max(128,stage.clientHeight),deviceScaleFactor=devicePixelRatio||1,touch=navigator.maxTouchPoints>0;
  const signature=`${width}:${height}:${deviceScaleFactor}:${touch}`;if(signature===viewportSignature)return;viewportSignature=signature;
  send({type:'viewport',width,height,deviceScaleFactor,touch});
}
async function draw(packet,current){
  if(maintenanceMessage||socket!==current||lifecycle.suspended)return;
  const wasm=await decoder(),view=new DataView(packet);
  if(socket!==current||lifecycle.suspended)return;
  if(packet.byteLength<32||view.getUint32(0,true)!==0x314f5147)throw Error('Invalid frame header');
  const sequence=view.getUint32(4,true),w=view.getUint16(8,true),h=view.getUint16(10,true),count=view.getUint16(12,true),full=Boolean(view.getUint16(14,true));
  if(!w||!h||w>8192||h>4320||count>4500)throw Error('Invalid frame size');
  if(lastSequence&&sequence!==((lastSequence+1)>>>0)&&!full){send({type:'frameReset'});return;}
  const started=performance.now();
  const raster=(wasm.heap_base()+15)&~15,scratch=raster+w*h*4,input=scratch+32768,required=input+packet.byteLength;
  const resized=!image||image.width!==w||image.height!==h;
  if(resized&&!full){send({type:'frameReset'});return;}
  if(required>wasm.memory.buffer.byteLength){wasm.memory.grow(Math.ceil((required-wasm.memory.buffer.byteLength)/65536));image=null;}
  if(resized){canvas.width=w;canvas.height=h;}
  if(!image||resized)image=new ImageData(new Uint8ClampedArray(wasm.memory.buffer,raster,w*h*4),w,h);
  new Uint8Array(wasm.memory.buffer,input,packet.byteLength).set(new Uint8Array(packet));
  if(!wasm.decode_packet(input,packet.byteLength,raster,scratch,w,h))throw Error('Invalid QOI packet');
  if(count)ctx.putImageData(image,0,0,wasm.damage_x(),wasm.damage_y(),wasm.damage_width(),wasm.damage_height());
  lastSequence=sequence;stats.frames++;stats.bytes+=packet.byteLength;stats.tiles=count;stats.decodeMs=performance.now()-started;
  stats.copyMs=view.getUint32(24,true)/1000;stats.encodeMs=view.getUint32(28,true)/1000;stats.width=w;stats.height=h;
  stats.samples.push({at:performance.now(),decodeMs:stats.decodeMs,copyMs:stats.copyMs,encodeMs:stats.encodeMs,tiles:count,bytes:packet.byteLength});if(stats.samples.length>720)stats.samples.shift();
  connection.hidden=true;stats.connectionState=document.hidden?'background-grace':'connected';send({type:'frameAck',sequence});
  window.dispatchEvent(new Event('gpt-frame'));
}
function start(){
  if(!lifecycle.canConnect()||socket?.readyState===0||socket?.readyState===1)return;
  clearTimeout(reconnectTimer);connection.textContent=maintenanceMessage||'正在连接服务器浏览器…';stats.connectionState='connecting';
  connection.hidden=false;const current=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}${nativeLogin?'/ws/login':'/ws'}?tab=${encodeURIComponent(tab)}`);socket=current;current.binaryType='arraybuffer';let drawQueue=Promise.resolve();
  current.onopen=()=>{if(socket!==current)return;reconnect=250;viewportSignature='';lifecycle.sync();};
  current.onmessage=({data})=>{
    if(socket!==current)return;
    if(data instanceof ArrayBuffer){drawQueue=drawQueue.then(()=>draw(data,current)).catch(error=>{if(socket!==current)return;toast(`画面解码恢复中：${error.message}`);lastSequence=0;send({type:'frameReset'});});return;}
    let m;try{m=JSON.parse(data);}catch{return;}
    if(m.type==='tab-conflict'){tab=m.tab;sessionStorage.setItem('gptw_tab',tab);current.close();return;}
    if(m.type==='ready'){maintenanceMessage='';globalThis.__gptWebSessionId=m.id;ready=true;remoteWidth=m.width;remoteHeight=m.height;lastSequence=0;viewport();focus();if(reloadRemote&&!remoteReloadSent&&!nativeLogin){remoteReloadSent=true;send({type:'reload'});}}
    if(m.type==='stream'){stats.targetFps=m.fps;stats.transport=m.transport;}
    if(m.type==='selection'){selection=m.text||'';selectionHtml=m.html||'';}
    if(m.type==='selection'&&selection&&coarse()&&touchSelecting){
      ime.readOnly=true;ime.inputMode='none';ime.value=selection;ime.focus({preventScroll:true});ime.setSelectionRange(0,selection.length);
    }
    if(m.type==='input-state'&&m.width===remoteWidth&&m.height===remoteHeight&&Array.isArray(m.fields)){
      inputFields=m.fields;const active=inputFields.find(f=>f.focused);
      if(active&&!touchSelecting){configureInput(active);imeInput.prepare();}
      else if(coarse()&&document.activeElement===ime&&!touchSelecting&&performance.now()-lastTouchAt>1000)ime.blur();
    }
    if(m.type==='cursor'&&/^[a-z-]{1,30}$/.test(m.cursor||''))canvas.style.cursor=m.cursor;
    if(m.type==='ime-anchor'){const r=stage.getBoundingClientRect();ime.style.left=`${r.left+Math.max(0,Math.min(r.width-4,m.x*r.width/remoteWidth))}px`;ime.style.top=`${r.top+Math.max(0,Math.min(r.height-24,m.y*r.height/remoteHeight))}px`;}
    if(m.type==='clipboard'){
      selection=m.text||'';selectionHtml=m.html||'';
      if(m.image?.type==='image/png'){
        if(navigator.clipboard?.write&&globalThis.ClipboardItem){
          const bytes=Uint8Array.from(atob(m.image.data),c=>c.charCodeAt(0));
          void navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]).then(()=>{stats.clipboardImageWrites=(stats.clipboardImageWrites||0)+1;}).catch(()=>toast('请允许此网站使用剪贴板'));
        }else toast('复制图片需使用 HTTPS 入口并手动信任证书；文字复制仍可使用 HTTP');
      }
      else if(selectionHtml&&navigator.clipboard?.write&&globalThis.ClipboardItem){void navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([selection],{type:'text/plain'}),'text/html':new Blob([selectionHtml],{type:'text/html'})})]).catch(()=>toast('请允许此网站使用剪贴板'));}
      else if(navigator.clipboard?.writeText)void navigator.clipboard.writeText(selection).catch(()=>toast('请允许此网站使用剪贴板'));
      else legacyCopy();
    }
    if(m.type==='filechooser'){chooserId=m.id;chooserPending=true;picker.accept=m.accept||'';picker.multiple=Boolean(m.multiple);picker.click();if(coarse()&&!navigator.userActivation?.isActive)toast('若文件选择未打开，请再点一次上传位置');}
    if(m.type==='download'){const a=document.createElement('a');a.href=`${m.url}?tab=${encodeURIComponent(tab)}`;a.download=m.filename||'download';document.body.append(a);a.click();a.remove();}
    if(m.type==='notice')toast(m.message);
    if(m.type==='fatal'||m.type==='maintenance'){maintenanceMessage=m.message;connection.textContent=m.message;connection.hidden=false;ready=false;}
    if(m.type==='diagnostic-pong')globalThis.dispatchEvent(new CustomEvent('gpt-pong',{detail:m}));
    if(m.type==='diagnostic-render')globalThis.dispatchEvent(new CustomEvent('gpt-render',{detail:m}));
  };
  current.onclose=event=>{
    if(socket!==current)return;socket=null;ready=false;pressed.clear();pointer.reset();touch.reset();imeInput.reset();selection='';selectionHtml='';inputFields=[];canvas.style.cursor='default';lastSequence=0;
    if(event.code===4001&&document.hidden)lifecycle.suspend();
    if(!lifecycle.canConnect())return;
    connection.textContent=maintenanceMessage||'连接已断开，正在重连…';connection.hidden=false;stats.connectionState='reconnecting';
    clearTimeout(reconnectTimer);reconnectTimer=setTimeout(start,reconnect);reconnect=Math.min(5000,reconnect*2);
  };current.onerror=()=>{};
}
const pointer=installPointerInput(canvas,{send,point,focus});
const imeInput=installImeInput(ime,{send,ready:()=>ready,coarse,field:()=>inputField});
canvas.addEventListener('pointerdown',e=>{
  if(!chooserPending||!chooserId)return;
  e.preventDefault();e.stopImmediatePropagation();picker.click();
},true);
const touch=installTouchInput(canvas,{send,point,native:!nativeLogin,onStart:p=>{
  if(!ready)return;lastTouchAt=performance.now();touchSelecting=false;
  const field=inputFields.find(f=>p.x>=f.x&&p.y>=f.y&&p.x<=f.x+f.width&&p.y<=f.y+f.height);
  if(field||nativeLogin){configureInput(field);imeInput.prepare();ime.focus({preventScroll:true});}
  else if(coarse()){ime.blur();}
},onSelect:()=>{touchSelecting=true;},onTap:()=>{touchSelecting=performance.now()-lastTouchAt>=450;}});
canvas.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey)return;e.preventDefault();const factor=e.deltaMode===1?16:e.deltaMode===2?innerHeight:1;send({type:'wheel',...point(e),deltaX:e.deltaX*factor,deltaY:e.deltaY*factor,modifiers:modifiers(e)});},{passive:false});
const key=(e,eventType)=>({type:'key',eventType,key:e.key,code:e.code,keyCode:e.keyCode,location:e.location,repeat:e.repeat,modifiers:modifiers(e),text:eventType==='keyDown'&&e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey?e.key:''});
document.addEventListener('keydown',e=>{
  if(nativeLogin&&e.target.closest?.('#manual-controls'))return;
  if(!ready||imeInput.composing||e.isComposing||e.keyCode===229)return;
  if(coarse()&&e.target===ime&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&(e.key.length===1||['Backspace','Delete','Enter','Unidentified'].includes(e.key)))return;
  if((e.ctrlKey||e.metaKey)&&['c','v','x'].includes(e.key.toLowerCase()))return;
  if(e.key==='F5'||((e.ctrlKey||e.metaKey)&&['r','+','-','=','0'].includes(e.key.toLowerCase())))return;
  if(e.altKey&&e.key==='ArrowLeft'){e.preventDefault();send({type:'back'});return;}
  if(e.altKey&&e.key==='ArrowRight'){e.preventDefault();send({type:'forward'});return;}
  e.preventDefault();const m=key(e,'keyDown');pressed.set(e.code,m);send(m);
});
document.addEventListener('keyup',e=>{if(imeInput.composing||e.isComposing)return;if(pressed.has(e.code)){e.preventDefault();pressed.delete(e.code);send(key(e,'keyUp'));}});
document.addEventListener('copy',e=>{if(ready){e.preventDefault();e.clipboardData.setData('text/plain',selection);if(selectionHtml)e.clipboardData.setData('text/html',selectionHtml);}});
document.addEventListener('cut',e=>{if(!ready)return;e.preventDefault();e.clipboardData.setData('text/plain',selection);send({type:'key',eventType:'keyDown',key:'x',code:'KeyX',keyCode:88,modifiers:2});send({type:'key',eventType:'keyUp',key:'x',code:'KeyX',keyCode:88,modifiers:2});});
async function upload(files,mode='drop',p={x:remoteWidth/2,y:remoteHeight/2},chooser=''){
  if(!files.length)return;const body=new FormData();for(const file of files)body.append('files',file,file.name||`clipboard-${Date.now()}.png`);body.append('mode',mode);body.append('x',p.x);body.append('y',p.y);if(chooser)body.append('chooserId',chooser);
  try{const response=await fetch('/api/upload',{method:'POST',headers:{'X-Gpt-Tab':tab},body});const result=await response.json();if(!response.ok)throw Error(result.error||'Upload failed');}catch(error){toast(`文件传输失败：${error.message}`);}finally{focus();}
}
document.addEventListener('paste',e=>{if(!ready)return;e.preventDefault();const files=Array.from(e.clipboardData?.files||[]);if(files.length){void upload(files,'paste');return;}const text=e.clipboardData?.getData('text/plain');if(text)send({type:'text',text});});
canvas.addEventListener('dragenter',e=>e.preventDefault());canvas.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';});canvas.addEventListener('drop',e=>{e.preventDefault();focus();void upload(Array.from(e.dataTransfer.files),'drop',point(e));});
picker.addEventListener('change',()=>{const id=chooserId;chooserId='';chooserPending=false;void upload(Array.from(picker.files),'chooser',undefined,id);picker.value='';});
picker.addEventListener('cancel',()=>{chooserId='';chooserPending=false;});
const resize=()=>{layoutStage();clearTimeout(resizeTimer);resizeTimer=setTimeout(viewport,60);};
window.addEventListener('resize',resize);window.addEventListener('orientationchange',resize);
window.visualViewport?.addEventListener('resize',resize);window.visualViewport?.addEventListener('scroll',resize);
function releaseInputs(){
  pointer.release();touch.release();for(const down of pressed.values())send({...down,eventType:'keyUp',text:'',modifiers:0});pressed.clear();
  if(imeInput.composing)send({type:'composition',text:''});
}
function suspendConnection(){
  clearTimeout(reconnectTimer);releaseInputs();const current=socket;socket=null;ready=false;current?.close(1000,'Background idle');
  pointer.reset();touch.reset();imeInput.reset();ime.blur();inputFields=[];selection=selectionHtml='';lastSequence=0;image=null;decoderPromise=null;
  canvas.width=canvas.height=1;connection.textContent='后台超过一分钟，已暂停连接；返回后自动恢复';connection.hidden=false;stats.connectionState='suspended';
}
const lifecycle=installVisibilityLifecycle({onVisibility:message=>{
  send({type:'visibility',...message});stats.hidden=message.hidden;
  if(message.hidden){releaseInputs();stats.connectionState='background-grace';}
},onSuspend:suspendConnection,onResume:()=>{if(ready){viewport();send({type:'selection'});}else start();}});
const dprCheck=setInterval(()=>{if(!document.hidden&&!lifecycle.suspended)viewport();},1000);
window.addEventListener('blur',releaseInputs);window.addEventListener('focus',()=>{if(ready){focus();send({type:'selection'});}});
window.addEventListener('beforeunload',()=>{lifecycle.stop();clearInterval(dprCheck);clearTimeout(reconnectTimer);socket?.close();});
globalThis.__gptWebSend=send;layoutStage();start();
