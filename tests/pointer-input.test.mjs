import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPointerInput} from '../public/pointer-input.js';
function fixture(){
  const handlers={},jobs=new Map(),messages=[];let serial=0,at=1000,captured=false;
  const canvas={addEventListener(k,fn){handlers[k]=fn},setPointerCapture(){captured=true},hasPointerCapture(){return captured},releasePointerCapture(){captured=false;handlers.lostpointercapture?.()}};
  const pointer=installPointerInput(canvas,{send:m=>messages.push(m),point:e=>({x:e.clientX,y:e.clientY}),focus(){},now:()=>at,schedule:fn=>{jobs.set(++serial,fn);return serial},cancel:id=>jobs.delete(id)});
  const fire=(type,extra={})=>handlers[type]({clientX:10,clientY:20,button:0,buttons:0,pointerId:1,preventDefault(){},...extra});
  return {messages,pointer,fire,jobs,tick(){const pending=[...jobs.values()];jobs.clear();for(const fn of pending)fn()},advance(ms){at+=ms}};
}
test('hover moves coalesce, but down and up flush pending moves in order',()=>{
  const f=fixture();f.fire('pointermove');f.fire('pointermove',{clientX:11});assert.equal(f.messages.length,0);
  f.fire('pointerdown',{buttons:1});f.fire('pointermove',{clientX:90,buttons:1});f.fire('pointerup',{clientX:90});f.tick();
  assert.deepEqual(f.messages.map(m=>[m.eventType,m.button,m.buttons,m.x]),[['mouseMoved','none',0,11],['mousePressed','left',1,10],['mouseMoved','left',1,90],['mouseReleased','left',0,90]]);
});
test('drag button comes from the held buttons mask, not pointermove.button',()=>{
  const f=fixture();for(const [mask,button]of [[1,'left'],[2,'right'],[4,'middle'],[8,'back'],[16,'forward'],[3,'left'],[0,'none']]){f.fire('pointermove',{button:-1,buttons:mask});f.tick();assert.equal(f.messages.at(-1).button,button)}
});
test('cancel or blur releases held buttons once, disconnect discards old moves',()=>{
  const f=fixture();f.fire('pointerdown',{buttons:1});f.fire('pointermove',{clientX:80,buttons:1});f.fire('pointercancel');f.pointer.release();f.tick();
  assert.deepEqual(f.messages.map(m=>m.eventType),['mousePressed','mouseMoved','mouseReleased']);assert.equal(f.messages.at(-1).x,80);
  f.fire('pointerdown',{buttons:1});f.fire('pointermove',{buttons:1});const count=f.messages.length;f.pointer.reset();f.tick();f.pointer.release();assert.equal(f.messages.length,count);
});
test('double and triple clicks preserve native click counts',()=>{
  const f=fixture();for(let n=1;n<=3;n++){f.fire('pointerdown',{buttons:1});assert.equal(f.messages.at(-1).clickCount,n);f.fire('pointerup');f.advance(100)}
  f.advance(600);f.fire('pointerdown',{buttons:1});assert.equal(f.messages.at(-1).clickCount,1);
});
test('default mouse batching does not depend on requestAnimationFrame',async()=>{
  const handlers={},messages=[];
  const canvas={addEventListener(k,fn){handlers[k]=fn}};
  const pointer=installPointerInput(canvas,{send:m=>messages.push(m),point:e=>({x:e.clientX,y:e.clientY}),focus(){}});
  handlers.pointermove({clientX:10,clientY:20,buttons:0});
  await new Promise(r=>setTimeout(r,30));assert.equal(messages.length,1);assert.equal(messages[0].eventType,'mouseMoved');pointer.reset();
});
