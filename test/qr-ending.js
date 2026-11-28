// Run against its own temporary event, with two independent projection browsers.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { testApp, until } from './support.js';

async function scan(pixels) {
  const { data, info } = await sharp(pixels).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height);
}
function traceLanding() {
  const trace = window.endingTrace = { frames: [] };
  new MutationObserver(() => {
    const scene = document.querySelector('.scene[data-kind="qr"]');
    if (!scene) return;
    const actor = scene.querySelector('.led-qr-buddy');
    if (!actor.hasAttribute('data-frame')) return;
    const frame = Number(actor.dataset.frame);
    if (trace.frames.at(-1) !== frame) trace.frames.push(frame);
    const opacity = Number(getComputedStyle(scene.querySelector('.led-code')).opacity);
    if (opacity > 0 && opacity < 1) trace.fading ??= frame;
    if (opacity === 1 && !trace.full) {
      trace.full = { frame, at: performance.timeOrigin + performance.now() };
    }
  }).observe(document, { childList: true, attributes: true, subtree: true });
}

const app = await testApp();
const input = process.env.BUDDY_QR_FIXTURE || fileURLToPath(new URL('./fixtures/qr-a.png', import.meta.url));
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
try {
  browser = await chromium.launch({ ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  const desk = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  const screens = await Promise.all([0, 1].map(() => browser.newPage({ viewport: { width: 512, height: 128 } })));
  const pages = [desk, ...screens], errors = [];
  for (const page of pages) {
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(traceLanding);
  }
  await Promise.all([desk.goto(app.url + '/control'),
    ...screens.map(page => page.goto(app.url + '/stage?native=1&look=dark'))]);
  await until(async () => (await (await app.call('control')).json()).displayed === 2);
  const expected = await scan(input);
  assert(expected);
  await desk.locator('#qr-file').setInputFiles(input);
  await desk.getByRole('button', { name: '上传并展示' }).click();
  await Promise.all(pages.map(page => page.getByText('辩论精彩时刻总结', { exact: true }).waitFor()));
  await Promise.all(pages.map(page => page.waitForFunction(() => window.endingTrace.full)));
  const published = app.store.screen();
  assert.equal(published.kind, 'qr');
  const traces = await Promise.all(pages.map(page => page.evaluate(() => window.endingTrace)));
  for (const trace of traces) {
    assert(trace.fading >= 50 && trace.fading < 54, 'fade during the final downstroke');
    assert.equal(trace.full.frame, 54, 'fully visible on the original flower landing frame');
  }
  const fullAfterMs = traces.map(t => Math.round(t.full.at - published.publishedAt));
  const skewMs = Math.abs(fullAfterMs[1] - fullAfterMs[2]);
  assert(skewMs < 50);
  await desk.getByText('2 / 2 屏回执', { exact: true }).waitFor();
  const scans = await Promise.all(screens.map(async page => scan(await page.screenshot())));
  for (const decoded of scans) assert.deepEqual(decoded?.binaryData, expected.binaryData);
  await Promise.all(pages.map(page => page.locator('.led-qr-buddy[data-frame="124"]').waitFor()));
  // A late join must hold the end pose. The 10-second quote timer must not clear this code.
  await screens[1].reload();
  await screens[1].waitForFunction(() => window.endingTrace.full);
  assert.equal(await screens[1].evaluate(() => window.endingTrace.frames[0]), 124);
  await sleep(Math.max(0, published.publishedAt + 10400 - Date.now()));
  assert.equal(app.store.screen().version, published.version);
  for (const [i, page] of screens.entries()) {
    assert.equal(await page.locator('.led-qr-buddy').getAttribute('data-frame'), '124');
    const options = !i && process.env.BUDDY_QR_SCREENSHOT ? { path: process.env.BUDDY_QR_SCREENSHOT } : {};
    assert.deepEqual((await scan(await page.screenshot(options)))?.binaryData, expected.binaryData);
  }
  await desk.getByRole('button', { name: '回到待场' }).click();
  await Promise.all(pages.map(page => page.locator('.scene[data-kind="idle"]').waitFor()));
  await until(async () => (await (await app.call('control')).json()).displayed === 2);
  assert.deepEqual(errors, []);
  console.log('收尾独立彩排通过', JSON.stringify({ fullAfterMs, skewMs, frame: traces[1].full.frame,
    screensScanned: scans.length, modules: 17 + 4 * expected.version, lastFrame: 124,
    heldBeyond10s: true, lateJoin: true, manualSwitch: true }));
} finally {
  await browser?.close();
  await app.cleanup();
}
