import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserKeepalive } from '../src/browser-keepalive.js';

test('keepalive is a separate minimized blank window, without a member session or capture', async () => {
  const calls = [];
  const browserCdp = { async send(method, params) {
    calls.push({ method, params });
    if (method === 'Target.createTarget') return { targetId: 'blank-target' };
    if (method === 'Browser.getWindowForTarget') return { windowId: 42 };
    return {};
  } };
  assert.deepEqual(await createBrowserKeepalive(browserCdp), { targetId: 'blank-target', windowId: 42 });
  assert.deepEqual(calls, [
    { method: 'Target.createTarget', params: {
      url: 'about:blank', newWindow: true, background: true, width: 320, height: 240,
    } },
    { method: 'Browser.getWindowForTarget', params: { targetId: 'blank-target' } },
    { method: 'Browser.setWindowBounds', params: { windowId: 42, bounds: { windowState: 'minimized' } } },
  ]);
});

test('failure to retain the blank window is not silently ignored', async () => {
  const failure = new Error('Window unavailable');
  await assert.rejects(createBrowserKeepalive({ async send(method) {
    if (method === 'Target.createTarget') return { targetId: 'blank-target' };
    throw failure;
  } }), error => error === failure);
});
