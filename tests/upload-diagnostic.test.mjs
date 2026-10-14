import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { uploadRoute, startUploadDiagnostic } from '../src/upload-diagnostic.js';

const request = (url, failure = '') => ({ url: () => url, method: () => 'POST', failure: () => ({ errorText: failure }) });
test('upload routes expose only host/stage/method, never file IDs or signed URL tokens', () => {
  const value = uploadRoute(request('https://files.oaiusercontent.com/private-file?token=secret'));
  assert.deepEqual(value, { host: 'files.oaiusercontent.com', stage: 'storage', method: 'POST' });
  assert.equal(uploadRoute(request('https://chatgpt.com/backend-api/conversation')), null);
  assert.equal(uploadRoute(request('https://example.com/backend-api/files')), null);
  assert.equal(uploadRoute(request('not-a-url')), null);
  assert.equal(uploadRoute(request('https://chatgpt.com/backend-api/files/private-id/uploaded?sig=secret')).stage, 'complete');
});
test('diagnostics log response/error codes without reading content and detach on stop', () => {
  const page = new EventEmitter(), entries = [];
  const stop = startUploadDiagnostic(page, { info: (event, data) => entries.push({ event, data }) }, 'test-session');
  const first = request('https://chatgpt.com/backend-api/files/private-file?token=secret');
  page.emit('request', first);page.emit('response', { request: () => first, status: () => 403 });page.emit('requestfinished', first);
  const second = request('https://files.oaiusercontent.com/private?sig=secret', 'net::ERR_TIMED_OUT secret-token');
  page.emit('request', second);page.emit('requestfailed', second);stop();stop();
  const output = JSON.stringify(entries);assert.ok(output.includes('403'));assert.ok(output.includes('net::ERR_TIMED_OUT'));
  for (const forbidden of ['secret', 'private-file', 'private?', 'token=']) assert.equal(output.includes(forbidden), false);
  assert.equal(page.listenerCount('request'), 0);assert.equal(page.listenerCount('response'), 0);
  assert.equal(entries.at(-1).data.pending.length, 0);
});
test('the per-upload log volume is bounded and pending summaries omit URLs', () => {
  const page = new EventEmitter(), entries = [];
  const stop = startUploadDiagnostic(page, { info: (event, data) => entries.push({ event, data }) }, 'test', { limit: 2 });
  for (let i = 0; i < 10; i++) { const r = request(`https://files.oaiusercontent.com/private-${i}?secret=1`);page.emit('request', r);page.emit('response', { request: () => r, status: () => 200 }); }
  stop();assert.equal(entries.filter(e => e.event === 'upload_response').length, 2);
  assert.equal(entries.at(-1).data.pending.length, 2);assert.equal(JSON.stringify(entries).includes('private'), false);
});
