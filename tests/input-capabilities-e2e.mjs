// Real Chromium regression; run only in a separate container/profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';
import { BrowserManager } from '../src/browser-manager.js';

assert.equal(process.env.INPUT_TEST_ISOLATED, 'true', 'An isolated container is required');
const root = path.join(config.dataRoot, 'tmp');
await fs.mkdir(root, { recursive: true });
const directory = await fs.mkdtemp(path.join(root, 'input-e2e-'));
const results = path.join(config.dataRoot, 'check-results/1.4.3');
await fs.mkdir(results, { recursive: true });
const report = { ok: false, checks: [] }, events = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let manager, display, server;
try {
  process.env.DISPLAY = ':198';
  display = spawn('Xvfb', [':198', '-screen', '0', '10000x5000x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await fs.stat('/tmp/.X11-unix/X198').catch(() => null)) break;
    await pause(50);
  }
  server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:16px;font:18px system-ui;background:white}
      .item{display:block;width:260px;height:52px;margin:8px 0;padding:12px;border:1px solid #888;background:rgb(255,255,255)}
      @media(hover:hover){.item:hover{background:rgb(224,224,224)}}
      #scroller{height:240px;width:280px;overflow:auto;touch-action:pan-y;border:1px solid #888}
      #scroller p{margin:12px;line-height:32px}#editor{width:260px;height:44px;margin:8px 0}
      #tip{height:30px}
      </style><button id="button" class="item">Button</button><div id="project" class="item">Project</div>
      <div id="conversation" class="item">Conversation</div><div id="tip"></div>
      <input id="editor"><p id="selection">Selectable desktop text stays selectable</p>
      <div id="scroller">${Array.from({ length: 60 }, (_, i) => `<p>Touch scrolling ${i}</p>`).join('')}</div>
      <script>window.taps=0;window.touches=0;window.trace=[];document.querySelector('#button').onclick=()=>window.taps++;
      document.addEventListener('touchstart',()=>window.touches++,{passive:true});
      for(const type of ['touchstart','pointerdown','mousedown','click','mousemove'])document.addEventListener(type,e=>{const p=e.touches?.[0]||e;window.trace.push({type,target:e.target.id,x:p.clientX,y:p.clientY});if(window.trace.length>16)window.trace.shift();},true);
      for(const item of document.querySelectorAll('.item'))item.onmouseenter=()=>document.querySelector('#tip').textContent=item.id;
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const logger = { info: event => events.push(event), warn: event => events.push(event), error: event => events.push(event), prune() {} };
  manager = new BrowserManager({ ...config, dataRoot: directory, profileDir: path.join(directory, 'profile'), uploadDir: path.join(directory, 'uploads'), downloadDir: path.join(directory, 'downloads'), upstreamProxy: '', chatgptUrl: origin }, { get() {}, update() {}, flush() {} }, logger);
  await manager.start();
  const desktop = await manager.getOrCreateSession('input:desktop');
  await desktop.page.locator('#button').waitFor();

  const send = (session, message) => session.handleMessage(JSON.stringify(message), {});
  const point = (session, id) => session.page.locator(`#${id}`).evaluate(element => {
    const r = element.getBoundingClientRect();return { x: r.x + Math.min(50, r.width / 2), y: r.y + r.height / 2 };
  });
  async function mouse(session, id, type = 'mouseMoved', values = {}) {
    await send(session, { type: 'mouse', eventType: type, ...await point(session, id), ...values });
  }
  async function media(session) {
    return session.page.evaluate(() => ({ hover: matchMedia('(hover:hover)').matches, fine: matchMedia('(pointer:fine)').matches, coarse: matchMedia('(pointer:coarse)').matches }));
  }
  async function hover(session, id) {
    await send(session, { type: 'mouse', eventType: 'mouseMoved', x: 310, y: 10 });
    await mouse(session, id);
    await session.page.waitForFunction(id => getComputedStyle(document.getElementById(id)).backgroundColor === 'rgb(224, 224, 224)', id);
    assert.equal(await session.page.locator('#tip').textContent(), id);
  }
  async function tap(session, id) {
    await send(session, { type: 'touch', eventType: 'touchStart', points: [{ id: 0, ...await point(session, id) }] });
    await send(session, { type: 'touch', eventType: 'touchEnd', points: [] });
    await session.page.waitForFunction(id => document.activeElement?.id === id, id);
  }
  async function swipe(session) {
    const r = await session.page.locator('#scroller').boundingBox();
    for (let i = 0; i <= 10; i++) {
      await send(session, { type: 'touch', eventType: i ? 'touchMove' : 'touchStart', points: [{ id: 0, x: r.x + 100, y: r.y + r.height - 24 - i * (r.height - 48) / 10 }] });
      await pause(16);
    }
    await send(session, { type: 'touch', eventType: 'touchEnd', points: [] });
    await session.page.waitForFunction(() => document.getElementById('scroller').scrollTop > 60);
    // Let the real browser's inertial fling finish before the next tap. A tap
    // during inertia legitimately stops scrolling instead of activating UI.
    let previous = -1, stable = 0;
    for (let i = 0; i < 100 && stable < 4; i++) {
      const position = await session.page.locator('#scroller').evaluate(element => element.scrollTop);
      stable = position === previous ? stable + 1 : 0;previous = position;
      await pause(50);
    }
    assert.equal(stable, 4, 'native scroll inertia must settle');
  }
  await desktop.resize({ width: 1920, height: 1080, deviceScaleFactor: 2, touch: false, touchPrimary: false });
  assert.deepEqual(await media(desktop), { hover: true, fine: true, coarse: false });
  for (const id of ['button', 'project', 'conversation']) await hover(desktop, id);
  report.checks.push('mouse-desktop-button-project-conversation-native-hover');

  // This is the real Windows hybrid combination reported by the client. The
  // old touch-only flag removed CSS hover even though mouse tooltips worked.
  await desktop.resize({ width: 1920, height: 1080, deviceScaleFactor: 2, touch: true, touchPrimary: false });
  assert.equal(desktop.touchEnabled, true);assert.equal(desktop.touchPrimary, false);
  assert.deepEqual(await media(desktop), { hover: true, fine: true, coarse: false });
  assert.equal(desktop.frameWidth, 3840);assert.equal(desktop.frameHeight, 2160);
  for (const id of ['button', 'project', 'conversation']) await hover(desktop, id);
  // Playwright's screenshot helper restores its own initial viewport, which
  // would overwrite the gateway's live native/CDP metrics. Capture directly.
  const screenshot = await desktop.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(results, 'hybrid-native-hover.png'), Buffer.from(screenshot.data, 'base64'));
  await tap(desktop, 'button');
  await desktop.page.waitForFunction(() => window.taps === 1);
  assert.equal(await desktop.page.evaluate(() => window.taps), 1);
  await tap(desktop, 'editor');
  await send(desktop, { type: 'text', text: 'Hybrid 中文' });
  assert.equal(await desktop.page.locator('#editor').inputValue(), 'Hybrid 中文');
  await swipe(desktop);
  assert.ok(await desktop.page.evaluate(() => window.touches) >= 3);
  for (const id of ['button', 'project', 'conversation']) await hover(desktop, id);
  report.checks.push('4K-hybrid-keeps-hover-plus-real-touch-tap-input-and-scroll');

  const text = await desktop.page.locator('#selection').boundingBox();
  await send(desktop, { type: 'mouse', eventType: 'mousePressed', x: text.x + 2, y: text.y + 12, button: 'left', buttons: 1, clickCount: 1 });
  await send(desktop, { type: 'mouse', eventType: 'mouseMoved', x: text.x + 230, y: text.y + 12, button: 'left', buttons: 1 });
  await send(desktop, { type: 'mouse', eventType: 'mouseReleased', x: text.x + 230, y: text.y + 12, button: 'left', buttons: 0, clickCount: 1 });
  assert.ok((await desktop.page.evaluate(() => String(getSelection()))).includes('Selectable'));
  report.checks.push('hybrid-mouse-text-selection-after-touch');

  const mobile = await manager.getOrCreateSession('input:mobile');
  await mobile.page.locator('#button').waitFor();
  await mobile.resize({ width: 390, height: 844, deviceScaleFactor: 3, touch: true, touchPrimary: true });
  assert.deepEqual(await media(mobile), { hover: false, fine: false, coarse: true });
  await tap(mobile, 'button');await mobile.page.waitForFunction(() => window.taps === 1);
  await tap(mobile, 'editor');await send(mobile, { type: 'text', text: '手机输入' });
  assert.equal(await mobile.page.locator('#editor').inputValue(), '手机输入');
  await swipe(mobile);
  await hover(desktop, 'project');
  assert.deepEqual(await media(desktop), { hover: true, fine: true, coarse: false });
  report.checks.push('phone-touch-primary-input-scroll-and-independent-desktop-hover');

  await mobile.resize({ width: 768, height: 1024, deviceScaleFactor: 2, touch: true, touchPrimary: true });
  assert.deepEqual(await media(mobile), { hover: false, fine: false, coarse: true });
  await mobile.resize({ width: 768, height: 1024, deviceScaleFactor: 2, touch: true, touchPrimary: false });
  await hover(mobile, 'conversation');
  assert.deepEqual(await media(mobile), { hover: true, fine: true, coarse: false });
  await tap(mobile, 'button');await mobile.page.waitForFunction(() => window.taps === 2);
  await mobile.page.reload();await hover(mobile, 'project');
  assert.deepEqual(await media(mobile), { hover: true, fine: true, coarse: false });
  // Backwards compatibility for an already-open client using the old protocol.
  await mobile.resize({ width: 768, height: 1024, deviceScaleFactor: 2, touch: true });
  assert.deepEqual(await media(mobile), { hover: false, fine: false, coarse: true });
  report.checks.push('tablet-primary-pointer-hot-switch-reload-and-old-client-compatibility');

  const { bounds } = await manager.browserCdp.send('Browser.getWindowBounds', { windowId: manager.keepalive.windowId });
  assert.equal(bounds.windowState, 'minimized');
  assert.equal(events.includes('input_failed'), false);
  report.checks.push('blank-keepalive-unaffected-and-no-input-errors');
  report.ok = true;
} catch (error) {
  report.error = error.stack;process.exitCode = 1;
  report.sessionState = await Promise.all([...manager?.sessions.values() || []].map(async session => ({
    touchPrimary: session.touchPrimary, dpr: session.dpr,
    state: await session.page.evaluate(() => ({ trace: window.trace, taps: window.taps, touches: window.touches, active: document.activeElement?.id,
      hover: matchMedia('(hover:hover)').matches, fine: matchMedia('(pointer:fine)').matches, scroll: [scrollX,scrollY],
      items: [...document.querySelectorAll('.item')].map(e=>({id:e.id,background:getComputedStyle(e).backgroundColor})) })).catch(() => null),
  })));
} finally {
  await manager?.stop().catch(() => {});server?.close();display?.kill();
  if (directory.startsWith(`${root}/input-e2e-`)) await fs.rm(directory, { recursive: true, force: true });
  await fs.writeFile(path.join(results, 'input-capabilities-e2e.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
