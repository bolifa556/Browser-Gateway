import http from 'node:http';
const states = new Map();
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Touch acceptance fixture</title>
<style>*{box-sizing:border-box}body{margin:0;font:16px system-ui;background:#fff;color:#222;padding:16px}h1{font-size:20px;margin:0 0 12px}.row{display:flex;gap:12px;margin-bottom:12px;align-items:center}button,input,textarea,select{font:inherit;min-height:44px}button{padding:8px 16px}input[type=text],textarea{display:block;width:100%;border:1px solid #777;border-radius:8px;padding:10px;margin:0 0 12px}textarea{height:68px;resize:none}#upload{max-width:100%;margin-bottom:12px}#scroller{height:260px;overflow:auto;border:1px solid #999;border-radius:8px;padding:12px;touch-action:pan-y;overscroll-behavior:contain}#scroller p{margin:0 0 16px;line-height:28px}#status{font-size:14px;margin-top:12px}a{padding:10px;color:#0761cb}</style></head>
<body><h1>Browser Gateway · touch test</h1><div class="row"><button id="tap">Tap: 0</button><select id="language"><option value="en">English</option><option value="zh">中文</option><option value="ja">日本語</option></select><a id="download" href="/download" download="mobile-test.txt">Download</a></div>
<input id="editor" type="text" inputmode="text" enterkeyhint="done" placeholder="Text input"><textarea id="multiline" enterkeyhint="enter" placeholder="Multiline input"></textarea>
<input id="upload" type="file"><div id="scroller">${Array.from({length:80},(_,i)=>`<p>Selectable touch text ${i+1} · 触摸滚动测试</p>`).join('')}</div><div id="status">Independent fixture; no production account.</div>
<script>
let taps=0,ticks=0,touches=0;const files=[];
document.querySelector('#tap').onclick=()=>document.querySelector('#tap').textContent='Tap: '+(++taps);
document.querySelector('#upload').onchange=e=>{files.splice(0,files.length,...[...e.target.files].map(f=>f.name));};
document.addEventListener('touchstart',()=>touches++,{passive:true});
const report=()=>{
  const rects={};for(const id of ['tap','language','download','editor','multiline','upload','scroller']){const r=document.getElementById(id).getBoundingClientRect();rects[id]={x:r.x,y:r.y,width:r.width,height:r.height};}
  const area=rects.scroller,paragraph=[...document.querySelectorAll('#scroller p')].map(p=>p.getBoundingClientRect()).find(r=>r.top>area.y+12&&r.bottom<area.y+area.height-12);
  fetch('/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:window.name,ticks,taps,touches,files,rects,
    selectionPoint:paragraph?{x:paragraph.x+35,y:paragraph.y+14}:null,
    editor:document.querySelector('#editor').value,multiline:document.querySelector('#multiline').value,
    scroll:document.querySelector('#scroller').scrollTop,language:document.querySelector('#language').value,
    selection:String(getSelection()||''),viewport:[innerWidth,innerHeight,devicePixelRatio],visualScale:visualViewport.scale,
    focused:document.activeElement?.id||'',touchCapable:navigator.maxTouchPoints>0})}).catch(()=>{});
};
setInterval(()=>{ticks++;report();},300);for(const name of ['input','change','click','scroll','selectionchange'])document.addEventListener(name,()=>setTimeout(report,30),true);report();
</script></body></html>`;
http.createServer((req,res)=>{
  if(req.url==='/state'&&req.method==='POST'){
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{try{const value=JSON.parse(body);states.set(value.id,{...value,updatedAt:Date.now()});}catch{}res.end('ok');});return;
  }
  if(req.url==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(Object.fromEntries([...states].map(([id,value])=>[id,{...value,sinceUpdateMs:Date.now()-value.updatedAt}]))));return;}
  if(req.url==='/download'){res.writeHead(200,{'Content-Type':'text/plain;charset=utf-8','Content-Disposition':'attachment;filename="mobile-test.txt"'});res.end('touch-download-ok');return;}
  res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(html);
}).listen(9314,'127.0.0.1',()=>console.log('Mobile fixture ready'));
