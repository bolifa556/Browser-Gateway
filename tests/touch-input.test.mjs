import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTouchInput } from '../public/touch-input.js';
import { installPointerInput } from '../public/pointer-input.js';

function fixture() {
  const handlers = {}, jobs = new Map(), holds = new Map(), messages = [], captured = new Set();let serial = 0, focus = 0, taps = 0;
  const fire = (type, values = {}) => { for (const fn of handlers[type] || []) fn({ pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 200, button: 0, buttons: 1, preventDefault() {}, ...values }); };
  const canvas = { addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    setPointerCapture(id) { captured.add(id); }, hasPointerCapture: id => captured.has(id),
    releasePointerCapture(id) { captured.delete(id);fire('lostpointercapture', { pointerId: id }); } };
  const options = { send: m => messages.push(m), point: e => ({ x: e.clientX, y: e.clientY }),
    schedule: fn => { jobs.set(++serial, fn);return serial; }, cancel: id => jobs.delete(id),
    hold:fn=>{holds.set(++serial,fn);return serial;},cancelHold:id=>holds.delete(id) };
  const mouse = installPointerInput(canvas, { ...options, focus() { focus++; } });
  const touch = installTouchInput(canvas, { ...options, onStart() { focus++; }, onTap() { taps++; } });
  return { messages, fire, touch, mouse, jobs,holds, get taps() { return taps; }, get focus() { return focus; },
    longPress(){const pending=[...holds.values()];holds.clear();for(const fn of pending)fn();},
    tick() { const pending = [...jobs.values()];jobs.clear();for (const fn of pending) fn(); } };
}
test('a finger tap emits native touch, never duplicate mouse presses', () => {
  const f = fixture();f.fire('pointerdown');f.fire('pointerup');
  assert.deepEqual(f.messages.map(m => m.eventType), ['touchStart', 'touchEnd']);assert.equal(f.focus, 1);assert.equal(f.taps, 1);
});
test('finger movement coalesces and is flushed before release without mouse dragging', () => {
  const f = fixture();f.fire('pointerdown');f.fire('pointermove', { clientY: 160 });f.fire('pointermove', { clientY: 100 });f.fire('pointerup', { clientY: 100 });f.tick();
  assert.deepEqual(f.messages.map(m => m.eventType), ['touchStart', 'touchMove', 'touchEnd']);
  assert.deepEqual(f.messages[1].points, [{ id: 0, x: 20, y: 100 }]);assert.equal(f.taps, 0);
});
test('multi-touch preserves contact IDs and lifting a contact never creates a phantom tap', () => {
  const f = fixture();f.fire('pointerdown');f.fire('pointerdown', { pointerId: 2, clientX: 100 });
  assert.deepEqual(f.messages.at(-1).points.map(p => p.id), [0, 1]);
  f.fire('pointermove', { pointerId: 2, clientX: 160 });f.tick();f.fire('pointerup', { pointerId: 2 });f.fire('pointerup');
  assert.equal(f.messages.at(-1).eventType, 'touchEnd');assert.equal(f.messages.filter(m => m.eventType === 'touchEnd').length, 1);assert.equal(f.taps, 0);
});
test('cancel, blur and disconnect do not leave remote fingers or queued moves held', () => {
  const f = fixture();f.fire('pointerdown');f.fire('pointermove');f.touch.release();f.tick();f.touch.release();
  assert.equal(f.messages.filter(m => m.eventType === 'touchCancel').length, 1);
  f.fire('pointerdown');assert.equal(f.messages.at(-1).eventType, 'touchStart');f.fire('pointermove');const count = f.messages.length;
  f.touch.reset();f.tick();assert.equal(f.messages.length, count);
});
test('mouse and pen continue to use the existing native mouse path', () => {
  const f = fixture();for (const pointerType of ['mouse', 'pen']) { f.fire('pointerdown', { pointerType });f.fire('pointerup', { pointerType }); }
  assert.deepEqual(f.messages.map(m => m.type), ['mouse', 'mouse', 'mouse', 'mouse']);assert.equal(f.taps, 0);
});
test('long press switches to word selection and releases its drag without an extra tap',()=>{
  const f=fixture();f.fire('pointerdown');f.longPress();f.fire('pointermove',{clientX:90});f.fire('pointerup',{clientX:90});
  assert.deepEqual(f.messages.map(m=>m.eventType||m.type),['touchStart','touchCancel','touch-select','mouseMoved','mouseReleased']);
  assert.equal(f.messages.at(-2).buttons,1);assert.equal(f.messages.at(-1).buttons,0);
});
test('moving a finger cancels the long press before a scroll gesture',()=>{
  const f=fixture();f.fire('pointerdown');f.fire('pointermove',{clientY:100});f.longPress();f.fire('pointerup',{clientY:100});
  assert.equal(f.messages.some(m=>m.type==='touch-select'),false);assert.equal(f.holds.size,0);
});
