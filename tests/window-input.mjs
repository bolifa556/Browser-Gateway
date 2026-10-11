import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const nativeFocus=async id=>{
  const {stdout}=await promisify(execFile)('python3',['-c',String.raw`
import ctypes as c,sys,json
x=c.CDLL('libX11.so.6');x.XOpenDisplay.argtypes=[c.c_char_p];x.XOpenDisplay.restype=c.c_void_p
x.XGetInputFocus.argtypes=[c.c_void_p,c.POINTER(c.c_ulong),c.POINTER(c.c_int)]
x.XQueryTree.argtypes=[c.c_void_p,c.c_ulong,c.POINTER(c.c_ulong),c.POINTER(c.c_ulong),c.POINTER(c.POINTER(c.c_ulong)),c.POINTER(c.c_uint)]
x.XFree.argtypes=[c.c_void_p];x.XInternAtom.argtypes=[c.c_void_p,c.c_char_p,c.c_int];x.XInternAtom.restype=c.c_ulong
x.XGetWindowProperty.argtypes=[c.c_void_p,c.c_ulong,c.c_ulong,c.c_long,c.c_long,c.c_int,c.c_ulong,c.POINTER(c.c_ulong),c.POINTER(c.c_int),c.POINTER(c.c_ulong),c.POINTER(c.c_ulong),c.POINTER(c.c_void_p)]
d=x.XOpenDisplay(b':99');w=c.c_ulong();revert=c.c_int();x.XGetInputFocus(d,c.byref(w),c.byref(revert));found=False
for i in range(12):
 if not w.value:break
 actual=c.c_ulong();fmt=c.c_int();n=c.c_ulong();remaining=c.c_ulong();data=c.c_void_p()
 x.XGetWindowProperty(d,w,x.XInternAtom(d,b'_NET_WM_NAME',0),0,1024,0,0,c.byref(actual),c.byref(fmt),c.byref(n),c.byref(remaining),c.byref(data))
 title=c.string_at(data,n.value).decode(errors='replace') if data.value and fmt.value==8 else ''
 if sys.argv[1] in title:found=True
 if data.value:x.XFree(data)
 root=c.c_ulong();parent=c.c_ulong();children=c.POINTER(c.c_ulong)();count=c.c_uint()
 if not x.XQueryTree(d,w,c.byref(root),c.byref(parent),c.byref(children),c.byref(count)):break
 if children:x.XFree(children)
 w=parent
print(json.dumps({'nativeFocus':found}))
  `,`gptw-${id}`]);return JSON.parse(stdout).nativeFocus;
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const state=async id=>(await(await fetch('http://127.0.0.1:9314/state')).json())[`gptw:${id}`];
const wait=async(id,predicate)=>{for(let n=0;n<60;n++){const v=await state(id);if(v&&predicate(v))return v;await sleep(100);}throw Error('Fixture did not receive input: '+JSON.stringify(await state(id)));};
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox']});
const report={tests:[],errors:[],switches:[]};const clients=[];
try{
  for(const dpr of [1,1.5,2]){
    const c=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:dpr});
    const p=await c.newPage();clients.push({c,p});p.on('pageerror',e=>report.errors.push(e.message));
    await p.goto('http://127.0.0.1:3003/');
    await p.waitForFunction(dpr=>__gptWebStats.frames>0&&document.querySelector('canvas').width===1280*dpr,dpr);
    const id=await p.evaluate(()=>__gptWebSessionId);
    const before=await wait(id,v=>v.viewport[2]===dpr&&v.child);
    report.tests.push({dpr,before:{focus:before.focus,nativeFocus:await nativeFocus(id),childFocus:before.child.focus,childViewport:before.child.viewport}});
    await p.mouse.click(80,60);await p.keyboard.type('main-'+dpr);
    const main=await wait(id,v=>v.text==='main-'+dpr);const nativeMain=await nativeFocus(id);
    // This checkbox is just our test element, not a CAPTCHA or real verifier.
    await p.mouse.click(328,208);const checkbox=await wait(id,v=>v.child?.checked);
    await p.mouse.click(380,270);await p.keyboard.type('frame-'+dpr);
    const frame=await wait(id,v=>v.child?.text==='frame-'+dpr);
    Object.assign(report.tests.at(-1),{main:{focus:main.focus,nativeFocus:nativeMain,active:main.active},checkbox:{focus:checkbox.focus,childFocus:checkbox.child.focus,clicks:checkbox.child.clicks},frame:{focus:frame.focus,nativeFocus:await nativeFocus(id),childFocus:frame.child.focus,active:frame.child.active}});
    assert.equal(frame.child.clicks,1);
  }
  // Alternate two live windows and prove neither main-frame nor iframe input spills.
  for(let n=0;n<8;n++){
    const {p}=clients[n%2];await p.mouse.click(380,270);await p.keyboard.press('End');await p.keyboard.type('X');
    const id=await p.evaluate(()=>__gptWebSessionId);const focused=await nativeFocus(id);report.switches.push({client:n%2,nativeFocus:focused});
    if(process.env.TEST_REQUIRE_FOCUS==='true')assert.equal(focused,true,'A human interaction must activate its native window');
  }
  for(const [index,{p}]of clients.entries()){
    const id=await p.evaluate(()=>__gptWebSessionId);const v=await wait(id,v=>v.child?.text===`frame-${[1,1.5,2][index]}${index<2?'XXXX':''}`);
    assert.equal(v.text,'main-'+[1,1.5,2][index]);
  }
  assert.deepEqual(report.errors,[]);report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;}
finally{console.log(JSON.stringify(report));await browser.close();}
