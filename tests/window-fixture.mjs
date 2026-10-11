// Owned, local-only compatibility fixture. Never contacts a verification service.
import http from 'node:http';
const states = {};
const child = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#eef;font:20px Arial}input[type=checkbox]{width:24px;height:24px;margin:16px}input[type=text]{margin:16px;width:240px;font-size:20px}</style><label><input id="check" type="checkbox">Local checkbox</label><br><input id="entry" type="text"><script>
let clicks=0;document.querySelector('#check').addEventListener('click',()=>clicks++);
const report=()=>parent.postMessage({kind:'local-fixture',checked:document.querySelector('#check').checked,text:document.querySelector('#entry').value,clicks,focus:document.hasFocus(),active:document.activeElement.id,viewport:[innerWidth,innerHeight,devicePixelRatio]},'http://127.0.0.1:9314');
for(const type of ['click','input','focus','blur'])window.addEventListener(type,()=>setTimeout(report,30),true);setInterval(report,200);report();</script>`;
const root = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:20px Arial;background:white}#entry{position:absolute;left:20px;top:40px;width:220px;height:40px;font-size:20px}iframe{position:absolute;left:300px;top:180px;width:420px;height:300px;border:0}#marker{position:fixed;left:0;top:0;width:10px;height:10px;background:lime}#pinpoint{position:absolute;left:80px;top:120px;width:6px;height:6px;background:magenta}</style><div id="marker"></div><div id="pinpoint"></div><input id="entry"><iframe src="http://localhost:9314/child"></iframe><script>
let child,pinpointClicks=0;document.querySelector('#pinpoint').onclick=()=>pinpointClicks++;addEventListener('message',e=>{if(e.origin==='http://localhost:9314'&&e.data.kind==='local-fixture')child=e.data;});
const report=()=>fetch('/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:window.name,focus:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.tagName,text:document.querySelector('#entry').value,viewport:[innerWidth,innerHeight,devicePixelRatio],pinpointClicks,child})});
for(const type of ['click','input','focus','blur'])window.addEventListener(type,()=>setTimeout(report,30),true);setInterval(report,200);report();</script>`;
http.createServer((req,res)=>{
  if(req.url==='/state'&&req.method==='POST'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{try{const v=JSON.parse(body);states[v.id]=v;}catch{}res.end('ok');});return;}
  res.setHeader('Content-Type',req.url==='/state'?'application/json':'text/html; charset=utf-8');
  res.end(req.url==='/state'?JSON.stringify(states):req.url==='/child'?child:root);
}).listen(9314,'127.0.0.1');
