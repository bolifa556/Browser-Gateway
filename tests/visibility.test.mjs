import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installVisibilityLifecycle } from '../public/visibility-lifecycle.js';
import { installVisibilityLease } from '../src/visibility-lease.js';

function clock() {
  let at = 0, serial = 0;const jobs = new Map();
  return { now: () => at, jobs,
    schedule(fn, delay) { const id = ++serial;jobs.set(id, { fn, at: at + delay });return id; },
    cancel: id => jobs.delete(id),
    advance(ms, run = true) { at += ms;if (run) for (const [id, job] of [...jobs]) if (job.at <= at) { jobs.delete(id);job.fn(); } },
  };
}
function target() {
  const events = new EventEmitter();
  return { hidden: false, addEventListener: events.on.bind(events), removeEventListener: events.off.bind(events), fire: events.emit.bind(events) };
}
function client() {
  const doc = target(), win = target(), time = clock(), messages = [];let pauses = 0, resumes = 0;
  const lifecycle = installVisibilityLifecycle({ document: doc, window: win, ...time,
    onVisibility: value => messages.push(value), onSuspend: () => pauses++, onResume: () => resumes++ });
  return { doc, win, time, lifecycle, messages, get pauses() { return pauses; }, get resumes() { return resumes; } };
}
test('a hidden tab suspends at 60 seconds, never on window blur alone', () => {
  const f = client();f.win.fire('blur');f.time.advance(120_000);assert.equal(f.pauses, 0);
  f.doc.hidden = true;f.doc.fire('visibilitychange');f.time.advance(59_999);assert.equal(f.pauses, 0);
  f.time.advance(1);assert.equal(f.pauses, 1);assert.equal(f.lifecycle.canConnect(), false);
  f.time.advance(60_000);assert.equal(f.pauses, 1);f.lifecycle.stop();
});
test('returning before the deadline cancels it; returning afterwards resumes once', () => {
  const f = client();f.doc.hidden = true;f.doc.fire('visibilitychange');f.time.advance(59_000);
  f.doc.hidden = false;f.doc.fire('visibilitychange');f.time.advance(61_000);assert.equal(f.pauses, 0);
  f.doc.hidden = true;f.doc.fire('visibilitychange');f.time.advance(60_000);assert.equal(f.pauses, 1);
  f.doc.hidden = false;f.doc.fire('visibilitychange');assert.equal(f.resumes, 2);assert.equal(f.lifecycle.canConnect(), true);f.lifecycle.stop();
});
test('a throttled client cannot reconnect hidden after its deadline; BFCache resumes', () => {
  const f = client();f.doc.hidden = true;f.doc.fire('visibilitychange');f.time.advance(65_000, false);
  assert.equal(f.lifecycle.canConnect(), false);assert.equal(f.pauses, 1);
  f.doc.hidden = false;f.win.fire('pageshow');assert.equal(f.lifecycle.canConnect(), true);
  f.win.fire('pagehide');assert.equal(f.lifecycle.canConnect(), false);
  f.win.fire('pageshow');assert.equal(f.lifecycle.canConnect(), true);f.lifecycle.stop();assert.equal(f.time.jobs.size, 0);
});
test('repeated visibility synchronization never restarts the one-minute grace', () => {
  const f = client();f.doc.hidden = true;f.doc.fire('visibilitychange');f.time.advance(45_000);f.lifecycle.sync();
  assert.equal(f.messages.at(-1).hiddenForMs, 45_000);f.time.advance(15_000);assert.equal(f.pauses, 1);f.lifecycle.stop();
});
function server() {
  const socket = new EventEmitter(), time = clock(), closes = [];socket.readyState = 1;let detached = 0;
  socket.close = (code, reason) => { closes.push({ code, reason });socket.readyState = 2; };
  socket.on('background-idle', () => detached++);
  const lease = installVisibilityLease(socket, time);
  return { socket, time, closes, lease, get detached() { return detached; } };
}
test('server releases resources at one minute even if the client JS is frozen', () => {
  const f = server();f.socket.emit('message', JSON.stringify({ type: 'visibility', hidden: true }), false);
  f.time.advance(59_999);assert.equal(f.closes.length, 0);f.time.advance(1);
  assert.deepEqual(f.closes, [{ code: 4001, reason: 'Background idle' }]);assert.equal(f.detached, 1);assert.equal(f.time.jobs.size, 0);
});
test('the server honors elapsed grace, rejects extension, and clears on return/close', () => {
  const f = server();f.lease.update(true, 40_000);f.time.advance(10_000);f.lease.update(true, 0);
  f.time.advance(9_999);assert.equal(f.closes.length, 0);f.lease.update(false);f.time.advance(60_000);assert.equal(f.closes.length, 0);
  f.lease.update(true);f.socket.emit('close');assert.equal(f.time.jobs.size, 0);
  f.lease.update(true, 60_000);f.time.advance(0);assert.equal(f.closes.length, 1);
});
test('bad visibility messages cannot suspend a foreground socket', () => {
  const f = server();for (const raw of ['invalid', '{"type":"visibility","hidden":"true"}', '{"type":"key"}']) f.socket.emit('message', raw, false);
  f.socket.emit('message', '{"type":"visibility","hidden":true}', true);f.time.advance(120_000);assert.equal(f.closes.length, 0);
});
