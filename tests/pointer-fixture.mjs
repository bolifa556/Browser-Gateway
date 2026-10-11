// Owned, network-isolated text and pointer fixture; no account or CAPTCHA.
import http from 'node:http';
const states={};
const content=`<p id="plain">Alpha beta gamma 中文正文，鼠标拖动选择这一行文字。</p><p id="multiline">First line selectable text.<br>Second line 中文跨行选择。<br>Third line ending.</p><a id="link" href="#link">A normal link</a><button id="button">A normal button</button><p id="blocked" style="user-select:none">Unselectable text</p><p id="explicit" style="cursor:crosshair">Explicit cursor text</p><input id="input" value="Editable input 中文文本"><div id="editable" contenteditable style="user-select:none"><span style="user-select:none">Editable area 中文文本</span></div>`;
const style=`<style>html,body{margin:0;background:white;font:20px/32px sans-serif}body{padding:24px}p{margin:0 0 16px;width:700px}a,button,input,#editable{display:block;margin:16px 0}input{font:20px sans-serif;width:360px;height:40px}#editable{border:1px solid #999;width:360px;min-height:40px}iframe{position:absolute;left:800px;top:24px;width:720px;height:620px;border:0}</style>`;
const script=`<script>
const events=[];for(const type of ['mousedown','mousemove','mouseup'])document.addEventListener(type,e=>{events.push({type,button:e.button,buttons:e.buttons,x:e.clientX,y:e.clientY});if(events.length>24)events.shift()},true);
const snapshot=()=>{const active=document.activeElement;return {id:window.name,selected:String(getSelection()),inputSelected:active?.selectionStart===undefined?'':active.value.slice(active.selectionStart,active.selectionEnd),events:[...events],rects:Object.fromEntries([...document.querySelectorAll('[id]')].map(e=>{const r=e.getBoundingClientRect();return [e.id,{x:r.x,y:r.y,w:r.width,h:r.height}]})),viewport:[innerWidth,innerHeight,devicePixelRatio],child:window.childState}};
const report=()=>${'IS_CHILD'}?parent.postMessage({kind:'pointer-fixture',state:snapshot()},'http://127.0.0.1:9314'):fetch('/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot())});
for(const type of ['mouseup','selectionchange','input'])document.addEventListener(type,()=>setTimeout(report,20));setInterval(report,100);report();
window.addEventListener('message',e=>{if(e.origin==='http://localhost:9314'&&e.data?.kind==='pointer-fixture'){window.childState=e.data.state;report()}});
</script>`;
http.createServer((req,res)=>{
  if(req.url==='/state'&&req.method==='POST'){let body='';req.on('data',v=>body+=v);req.on('end',()=>{try{const v=JSON.parse(body);states[v.id]=v}catch{}res.end('ok')});return}
  if(req.url==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(states));return}
  const child=req.url==='/child';res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8">'+style+content+(child?'':'<iframe src="http://localhost:9314/child"></iframe>')+script.replace('IS_CHILD',String(child)));
}).listen(9314,'127.0.0.1');
