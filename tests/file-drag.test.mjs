import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFileDrag } from '../public/file-drag.js';
import { RemoteFileDrag } from '../src/file-drag.js';

function client() {
  const handlers = {}, messages = [], drops = [], jobs = new Map();let sequence = 0, available = true, warnings = 0;
  const input = installFileDrag({ addEventListener(type, fn) { handlers[type] = fn; } }, {
    send: value => messages.push(value), point: event => ({ x: event.clientX, y: event.clientY }),
    ready: () => available, onDrop: (...args) => drops.push(args), unavailable: () => warnings++,
    makeId: () => `drag-test-${++sequence}`, schedule: fn => { jobs.set(++sequence, fn);return sequence; }, cancel: id => jobs.delete(id),
  });
  function fire(type, extra = {}) {
    const dataTransfer = { types: ['Files'], items: [{ kind: 'file', type: 'text/plain' }], files: [], dropEffect: 'none', ...extra.dataTransfer };
    const event = { clientX: 30, clientY: 40, preventDefault() { this.prevented = true; }, ...extra, dataTransfer };
    handlers[type](event);return event;
  }
  return { input, messages, drops, fire, jobs, get warnings() { return warnings; }, ready(value) { available = value; }, tick() { const pending = [...jobs.values()];jobs.clear();for (const work of pending) work(); } };
}

test('file enter/over sends protected metadata and coalesces hover without uploading content', () => {
  const c = client();c.fire('dragenter');c.fire('dragover');c.fire('dragover', { clientX: 85 });c.tick();
  assert.deepEqual(c.messages.map(m => m.eventType), ['enter', 'over']);
  assert.deepEqual(c.messages[0].files, [{ type: 'text/plain' }]);assert.equal(c.messages[1].x, 85);assert.equal(c.drops.length, 0);
});
test('nested enter/leave does not clear the native drop UI until the pointer leaves the page', () => {
  const c = client();c.fire('dragenter');c.fire('dragenter');c.fire('dragleave');assert.equal(c.messages.length, 1);
  c.fire('dragleave');assert.equal(c.messages.at(-1).eventType, 'cancel');
});
test('drop retires preview before delivering the real files, and removes stale hover jobs', () => {
  const c = client(), files = [{ name: 'test.txt', size: 12 }];c.fire('dragenter');c.fire('dragover');
  c.fire('drop', { dataTransfer: { files }, clientX: 90 });c.tick();
  assert.deepEqual(c.messages.map(m => m.eventType), ['enter', 'cancel']);
  assert.deepEqual(c.drops, [[files, { x: 90, y: 40 }, c.messages[0].id]]);
});
test('unrelated text drags are untouched; disconnected file drops cannot navigate or upload', () => {
  const c = client();const e = c.fire('dragenter', { dataTransfer: { types: ['text/plain'], items: [{ kind: 'string' }] } });
  assert.equal(e.prevented, undefined);assert.equal(c.messages.length, 0);
  c.ready(false);assert.equal(c.fire('drop', { dataTransfer: { files: [{}] } }).prevented, true);
  assert.equal(c.drops.length, 0);assert.equal(c.warnings, 1);
});
test('blur/reconnect cleanup releases drag once and reset never sends into a new socket', () => {
  const c = client();c.fire('dragenter');c.fire('dragover');c.input.release();c.input.release();c.tick();
  assert.deepEqual(c.messages.map(m => m.eventType), ['enter', 'cancel']);
  c.fire('dragenter');c.fire('dragover');const count = c.messages.length;c.input.reset();c.tick();assert.equal(c.messages.length, count);
});

async function remote(t, overrides = {}) {
  const root = fileURLToPath(new URL('../data/tmp/', import.meta.url));await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'file-drag-unit-')), calls = [];
  const drag = new RemoteFileDrag({ directory, geometry: () => ({ width: 800, height: 600, dpr: 2 }),
    cdp: { async send(method, params) { calls.push({ method, params }); } }, ...overrides });
  t.after(async () => { await drag.close().catch(() => {});await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, drag, calls };
}
const enter = (id = 'drag-test-one') => ({ id, eventType: 'enter', x: 120, y: 80, files: [{ type: 'application/pdf' }] });

test('native preview uses zero-byte placeholders and CSS coordinates regardless of DPR, without a drop', async t => {
  const r = await remote(t);await r.drag.handle(enter());
  const data = r.calls[0].params.data;assert.equal(data.files.length, 1);assert.equal(path.extname(data.files[0]), '.pdf');
  assert.equal((await fs.stat(data.files[0])).size, 0);assert.equal(r.calls[0].params.x, 120);assert.equal(r.calls[0].params.y, 80);
  assert.deepEqual(r.calls.map(c => c.params?.type), ['dragEnter', 'dragOver']);
  await r.drag.cancel('drag-test-one');assert.equal(r.calls.at(-1).method, 'Input.cancelDragging');
  assert.deepEqual(await fs.readdir(r.directory), []);
});
test('native drag positions are clamped to the CSS viewport', async t => {
  const r = await remote(t, { geometry: () => ({ width: 800, height: 600, dpr: 1.5 }) });
  await r.drag.handle({ ...enter(), x: 900, y: -20 });
  assert.equal(r.calls[0].params.x, 799);assert.equal(r.calls[0].params.y, 0);
});
test('drop/cancel winning a network race cannot be reopened by late enter or over messages', async t => {
  const r = await remote(t);await r.drag.cancel('drag-test-one');await r.drag.handle(enter());
  await r.drag.handle({ ...enter(), eventType: 'over' });assert.equal(r.calls.length, 0);
  assert.deepEqual(await fs.readdir(r.directory), []);
});
test('invalid IDs cannot create files and item count is bounded', async t => {
  const r = await remote(t);await r.drag.handle(enter('../escape'));assert.equal(r.calls.length, 0);
  await r.drag.handle({ ...enter(), files: Array.from({ length: 50 }, () => ({ type: '../../bad' })) });
  assert.equal(r.calls[0].params.data.files.length, 10);
  for (const file of r.calls[0].params.data.files) assert.equal(path.extname(file), '.bin');
});
test('CDP errors clean up preview files and a closed session ignores late messages', async t => {
  const r = await remote(t, { cdp: { async send() { throw Error('closed target'); } } });
  await assert.rejects(r.drag.handle(enter()), /closed target/);assert.deepEqual(await fs.readdir(r.directory), []);
  await r.drag.close();await r.drag.handle(enter('drag-test-later'));assert.deepEqual(await fs.readdir(r.directory), []);
});
test('stale drag state expires even when the client loses its leave event', async t => {
  const r = await remote(t, { idleMs: 10 });await r.drag.handle(enter());
  await new Promise(resolve => setTimeout(resolve, 50));await r.drag.queue;
  assert.equal(r.drag.active, null);assert.deepEqual(await fs.readdir(r.directory), []);
});
