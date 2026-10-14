// Isolated Chromium acceptance. No production profile or external site is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';
import { BrowserManager } from '../src/browser-manager.js';
assert.equal(process.env.DRAG_TEST_ISOLATED, 'true');
const root=path.join(config.dataRoot,'tmp');await fs.mkdir(root,{recursive:true});
const directory=await fs.mkdtemp(path.join(root,'file-drag-e2e-'));
const results=path.join(config.dataRoot,'check-results/1.4.4');await fs.mkdir(results,{recursive:true});
const report={ok:false,checks:[]},events=[],pause=ms=>new Promise(r=>setTimeout(r,ms));
let manager,server,display;
try{
  process.env.DISPLAY=':197';display=spawn('Xvfb',[':197','-screen','0','10000x5000x24','-nolisten','tcp','-noreset'],{stdio:'ignore'});
  for(let i=0;i<100;i++){if(await fs.stat('/tmp/.X11-unix/X197').catch(()=>null))break;await pause(50);}
  server=http.createServer((request,response)=>{
    if(request.url==='/hold'){request.on('close',()=>response.end());return;}
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    response.end(`<!doctype html><meta charset="utf-8"><style>body{margin:20px;font:18px system-ui}#drop{width:400px;height:220px;border:2px dashed #777;background:white}#drop.dragging{background:rgb(220,230,255)}button{width:100px;height:50px}#card{padding:12px;border:1px solid #777;width:300px;margin-top:12px}#card[hidden]{display:none}</style>
    <h1>Native file drag acceptance</h1><div id="drop">Drop files here</div><div id="card" hidden>Uploading… <button id="cancel">×</button></div><input id="editor">
    <script>window.probe={events:[],drops:0,cancelled:0};let controller;const drop=document.querySelector('#drop'),card=document.querySelector('#card');
    for(const type of ['dragenter','dragover','dragleave','drop'])drop.addEventListener(type,async e=>{
      e.preventDefault();probe.events.push({type,kinds:[...e.dataTransfer.items].map(i=>i.kind),x:e.clientX,y:e.clientY});
      if(type==='dragenter'||type==='dragover')drop.classList.add('dragging');else drop.classList.remove('dragging');
      if(type==='drop'){probe.drops++;const file=e.dataTransfer.files[0];probe.name=file.name;probe.size=file.size;
        controller=new AbortController();card.hidden=false;probe.pending=true;
        try{probe.bytes=(await file.arrayBuffer()).byteLength;await fetch('/hold',{method:'POST',body:file,signal:controller.signal});}
        catch(error){probe.error=error.name;}
      }
    });
    document.querySelector('#cancel').onclick=()=>{probe.cancelled++;controller?.abort();card.hidden=true;probe.pending=false;};
    </script>`);
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}/`;
  manager=new BrowserManager({...config,dataRoot:directory,profileDir:path.join(directory,'profile'),uploadDir:path.join(directory,'uploads'),downloadDir:path.join(directory,'downloads'),upstreamProxy:'',chatgptUrl:origin},
    {get(){},update(){},flush(){}},{info(e){events.push(e)},warn(e){events.push(e)},error(e){events.push(e)},prune(){}});
  await manager.start();const session=await manager.getOrCreateSession('drag:acceptance');await session.page.locator('#drop').waitFor();
  const send=m=>session.handleMessage(JSON.stringify(m),{});
  const hovering=()=>session.page.locator('#drop').evaluate(e=>e.classList.contains('dragging'));
  for(const dpr of [1,1.5,2]){
    await session.resize({width:1920,height:1080,deviceScaleFactor:dpr,touch:true,touchPrimary:false});
    const id=`drag-test-${String(dpr).replace('.','-')}`,message={type:'file-drag',eventType:'enter',id,x:100,y:150,files:[{type:'application/pdf'}]};
    await send(message);await session.page.waitForFunction(()=>document.getElementById('drop').classList.contains('dragging'));
    assert.ok(await hovering());assert.equal(await session.page.evaluate(()=>probe.drops),0);
    assert.ok((await session.page.evaluate(()=>probe.events)).some(e=>e.type==='dragenter'&&e.kinds.includes('file')));
    const position=await session.page.evaluate(()=>probe.events.at(-1));
    assert.ok(Math.abs(position.x-100)<1&&Math.abs(position.y-150)<1,`DPR ${dpr} drag coordinates: ${JSON.stringify(position)}`);
    if(dpr===2){const shot=await session.cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(path.join(results,'native-drag-preview.png'),Buffer.from(shot.data,'base64'));}
    await send({...message,eventType:'cancel'});await session.page.waitForFunction(()=>!document.getElementById('drop').classList.contains('dragging'));
    assert.equal(session.fileDrag.active,null);
  }
  report.checks.push('native-file-enter-over-leave-without-upload-at-1x-1.5x-2x');
  const filePath=path.join(directory,'upload-test.txt');await fs.writeFile(filePath,'upload-test');
  const files=[{path:filePath,originalname:'upload-test.txt',mimetype:'text/plain',size:11}];
  const id='drag-test-real-drop';
  await send({type:'file-drag',eventType:'enter',id,x:100,y:150,files:[{type:'text/plain'}]});
  assert.equal(await session.applyUploadedFiles(files,'',{x:100,y:150,mode:'drop',dragId:id}),'drop');
  await session.page.waitForFunction(()=>probe.bytes===11&&probe.pending===true);
  assert.equal(await session.page.evaluate(()=>probe.drops),1);assert.equal(await session.page.evaluate(()=>probe.name),'upload-test.txt');
  await send({type:'file-drag',eventType:'over',id,x:100,y:150,files:[{type:'text/plain'}]});
  assert.equal(session.fileDrag.active,null,'late hover cannot cover the upload cancel control');
  const p=await session.page.locator('#cancel').evaluate(e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
  for(const eventType of ['mouseMoved','mousePressed','mouseReleased'])await send({type:'mouse',eventType,...p,button:eventType==='mouseMoved'?'none':'left',buttons:eventType==='mousePressed'?1:0,clickCount:1});
  await session.page.waitForFunction(()=>probe.cancelled===1&&probe.pending===false&&document.getElementById('card').hidden);
  assert.equal(await session.page.evaluate(()=>probe.error),'AbortError');
  report.checks.push('real-file-bytes-readable-and-native-cross-cancels-in-progress-upload');
  await assert.rejects(session.applyUploadedFiles(files,'expired-chooser',{x:100,y:150}),/选择窗口已失效/);
  assert.equal(await session.page.evaluate(()=>probe.drops),1);
  report.checks.push('expired-file-chooser-is-rejected-without-an-accidental-drop');
  await send({type:'file-drag',eventType:'enter',id:'drag-test-close',x:100,y:150,files:[{type:'application/zip'}]});
  const previewDirectory=session.fileDrag.active.directory;
  await session.close();assert.equal(await fs.stat(previewDirectory).catch(()=>null),null);
  assert.equal(events.includes('input_failed'),false);
  report.checks.push('closing-session-cleans-preview-files-and-no-input-errors');report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  await manager?.stop().catch(()=>{});server?.close();display?.kill();
  if(directory.startsWith(`${root}/file-drag-e2e-`))await fs.rm(directory,{recursive:true,force:true});
  await fs.writeFile(path.join(results,'file-drag-e2e.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
