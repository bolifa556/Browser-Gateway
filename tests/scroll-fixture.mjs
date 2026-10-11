// Local, disposable rendering benchmark. No account, external site or CAPTCHA.
import http from 'node:http';
const states={};
const paragraph='清晰的文字和连续滚动应该同时保持。服务器传回的是原始 RGB 像素，不应牺牲分辨率和文本边缘。 Native browser rendering, latency and smooth scrolling — 0123456789.';
const html=`<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#fff;font:16px/1.8 system-ui,sans-serif;color:#202124}
aside{position:fixed;inset:0 auto 0 0;width:260px;border-right:1px solid #ddd;padding:20px;background:#fafafa}
main{position:fixed;inset:0 0 0 260px;overflow:auto;padding:35px max(40px,calc((100vw - 1060px)/2)) 140px}
section{width:800px;max-width:100%;margin:0 auto}p{margin:18px 0}h2{font-size:22px}pre{background:#f1f1f1;padding:20px;border-radius:14px;font:14px/1.7 monospace}
footer{position:fixed;bottom:18px;left:calc(50% - 270px);width:800px;max-width:calc(100% - 320px);height:60px;border:1px solid #ddd;background:#fff;border-radius:30px;padding:15px 24px}
#pixel-grid{position:fixed;left:4px;top:4px;width:32px;height:32px;background:repeating-linear-gradient(90deg,#000 0 1px,#fff 1px 2px)}
</style><aside><h2>滚动回归</h2>${Array.from({length:30},(_,i)=>`<p>独立输入 / 清晰文字 ${i+1}</p>`).join('')}</aside><main><section>${Array.from({length:120},(_,i)=>`<h2>第 ${i+1} 节：文字、代码与表格</h2><p>${paragraph}</p><pre>const frame = { width: 3840, height: 2160 };\n// preserve every RGB pixel; avoid queued stale frames\nrender(frame);</pre><p>${paragraph}</p>`).join('')}</section></main><footer>输入框固定在屏幕底部 — 不发送聊天消息</footer><div id="pixel-grid"></div><script>
const main=document.querySelector('main');let running=false,frames=0,last=0,first=0,direction=1;
function tick(at){if(running){if(!first)first=at;if(last){main.scrollTop+=direction*(at-last)*.9;if(main.scrollTop>5000)direction=-1;if(main.scrollTop<200)direction=1;}last=at;frames++;}requestAnimationFrame(tick);}requestAnimationFrame(tick);
function report(){return {id:window.name,frames,first,last,scrollTop:main.scrollTop,viewport:[innerWidth,innerHeight,devicePixelRatio],running};}
setInterval(()=>{fetch('/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report())});fetch('/control?id='+encodeURIComponent(window.name)).then(r=>r.json()).then(v=>{if(v.running&&!running){first=last=frames=0;direction=1;main.scrollTop=200;}running=v.running;});},100);
</script>`;
let running=false,activeIds=null;
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(req.method==='POST'&&req.url==='/state'){let body='';req.on('data',v=>body+=v);req.on('end',()=>{try{const v=JSON.parse(body);states[v.id]=v;}catch{}res.end('ok');});return;}
 if(url.pathname==='/start'||url.pathname==='/stop'){running=url.pathname==='/start';activeIds=url.searchParams.has('ids')?new Set(url.searchParams.get('ids').split(',')):null;res.end('ok');return;}
 if(url.pathname==='/state'||url.pathname==='/control'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(url.pathname==='/state'?states:{running:running&&(!activeIds||activeIds.has(url.searchParams.get('id')))}));return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
}).listen(9436,'127.0.0.1');
