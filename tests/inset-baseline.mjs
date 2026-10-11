import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  await fs.mkdir('/app/data/test-results', { recursive: true });
  for (const dpr of [1, 1.5, 2]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3003/');
    await page.waitForFunction(dpr => document.querySelector('#screen').width === 1280 * dpr && window.__gptWebStats?.frames > 0, dpr);
    await sleep(1000);
    const id = await page.evaluate(() => window.__gptWebSessionId);
    const readState = async () => (await (await fetch('http://127.0.0.1:9314/state')).json())[`gptw:${id}`];
    let state;
    for (let attempt = 0; attempt < 50; attempt++) {
      state = await readState();
      if (state?.child && state.viewport[2] === dpr) break;
      await sleep(100);
    }
    await page.waitForFunction(dpr => {
      const canvas = document.querySelector('#screen'), ctx = canvas.getContext('2d');
      let count = 0, first = null;
      for (let y = 0; y < Math.round(12 * dpr); y++) {
        const pixel = ctx.getImageData(Math.round(3 * dpr), y, 1, 1).data;
        if (pixel[0] === 0 && pixel[1] === 255 && pixel[2] === 0) { first ??= y; count++; }
      }
      return first !== null && first <= 1 && count >= Math.floor(8 * dpr);
    }, dpr);
    await page.mouse.click(83, 123);
    for (let attempt = 0; attempt < 40; attempt++) {
      state = await readState();
      if (state?.pinpointClicks === 1) break;
      await sleep(100);
    }
    const pinpointClicked = state?.pinpointClicks === 1;
    const pixels = await page.evaluate(dpr => {
      const canvas = document.querySelector('#screen');
      const ctx = canvas.getContext('2d');
      const x = Math.round(3 * dpr);
      const rows = [];
      for (let y = 0; y < Math.min(180, canvas.height); y++) {
        const pixel = ctx.getImageData(x, y, 1, 1).data;
        if (pixel[0] === 0 && pixel[1] === 255 && pixel[2] === 0) rows.push(y);
      }
      return { frame: [canvas.width, canvas.height], markerTop: rows[0] ?? null, markerBottom: rows.at(-1) ?? null };
    }, dpr);
    // This is an owned local checkbox, not a CAPTCHA or real verifier.
    await page.mouse.click(328, 208);
    for (let attempt = 0; attempt < 40; attempt++) {
      state = await readState();
      if (state?.child?.checked) break;
      await sleep(100);
    }
    const result = { dpr, pixels, viewport: state?.viewport, pinpointClicked, checkboxClicked: Boolean(state?.child?.checked) };
    results.push(result);
    await page.screenshot({ path: `/app/data/test-results/inset-${dpr}.png` });
    await context.close();
    await sleep(1100);
  }
  for (const result of results) {
    // Chrome may paint a one-physical-pixel separator shadow over row zero.
    assert.ok(result.pixels.markerTop <= 1, `Rendered page origin does not match capture origin at DPR ${result.dpr}`);
    assert.equal(result.pinpointClicked, true, `Six-pixel target did not match rendered position at DPR ${result.dpr}`);
    assert.equal(result.checkboxClicked, true, `Owned checkbox click did not match rendered position at DPR ${result.dpr}`);
  }
  console.log(JSON.stringify({ ok: true, results }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, results, error: error.message }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
