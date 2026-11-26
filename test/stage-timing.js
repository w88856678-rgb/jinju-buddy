// One live-clock rehearsal. Each projector has its own browser context and clock.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { film } from '../public/buddy-frames.js';
import { testApp, until } from './support.js';

const app = await testApp();
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
try {
  browser = await chromium.launch({ ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  const desk = await browser.newPage({ viewport: { width: 1380, height: 900 } });
  const screens = await Promise.all([0, 1].map(() => browser.newPage({ viewport: { width: 512, height: 128 } })));
  const errors = [];
  for (const page of [desk, ...screens]) page.on('pageerror', e => errors.push(e.message));
  await screens[1].addInitScript(() => {
    const now = Date.now;
    Date.now = () => now() + 60000;
  });
  for (const page of screens) await page.addInitScript(() => {
    const trace = window.stageTrace = {};
    function sample() {
      const scene = document.querySelector('.scene');
      if (scene) {
        const now = performance.timeOrigin + performance.now();
        const buddy = scene.querySelector('.led-buddy');
        if (buddy.dataset.motion === 'wave') trace.wave ??= now;
        if (scene.dataset.kind === 'quote') {
          const opacity = +getComputedStyle(scene.querySelector('.led-words')).opacity;
          trace.quote ??= now;
          if (opacity > .02) trace.lastInk = now;
          if (opacity > .02 && opacity < .98) trace.fade ??= now;
        } else if (trace.quote) trace.clear ??= now;
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  // Hold the last sheet on one cold projector. An operator can cancel while it warms.
  let releaseSheet;
  const hold = new Promise(resolve => { releaseSheet = resolve; });
  await screens[1].route('**/buddy-hello-7.webp', async route => { await hold; await route.continue(); });
  await Promise.all([desk.goto(app.url + '/control'),
    ...screens.map((page,i) => page.goto(app.url + '/stage?native=1&look=' + (i ? 'blue' : 'dark')))]);
  await Promise.all([desk, ...screens].map(page => page.locator('.led-buddy[data-motion="play"]').waitFor()));
  assert(screens.every(page => page.url().includes('/e/rehearsal/')));
  assert.equal(app.store.screen().version, 0);
  const feedback = await desk.locator('#greet').evaluate(b => {
    b.click();
    return [b.textContent.trim(), b.disabled];
  });
  assert.deepEqual(feedback, ['准备打招呼…', true]);
  await desk.locator('#clear').click();
  releaseSheet();
  await until(async () => (await (await app.call('control')).json()).greetingReadyScreens === 2);
  assert.equal(app.store.screen().version, 0);
  // A separate request can cancel even while the first POST is still in flight.
  let letGreetingThrough, greetingSent, cancelArrived;
  const delayedGreeting = new Promise(resolve => { letGreetingThrough = resolve; });
  const delayedPost = new Promise(resolve => { greetingSent = resolve; });
  const cancelResponse = new Promise(resolve => { cancelArrived = resolve; });
  await desk.route('**/api/publish', async route => {
    if (route.request().postDataJSON().kind === 'greet') {
      greetingSent();
      await delayedGreeting;
    }
    await route.continue();
  });
  desk.on('response', response => {
    if (response.url().endsWith('/api/publish') && response.request().postDataJSON().kind === 'cancel-greet')
      cancelArrived();
  });
  await desk.locator('#greet').click();
  await delayedPost;
  await desk.locator('#clear').click();
  await cancelResponse;
  letGreetingThrough();
  await desk.waitForFunction(() => !document.querySelector('#greet').disabled);
  await desk.unroute('**/api/publish');
  assert.equal(app.store.screen().version, 0);
  const backdrops = await Promise.all(screens.map(async page => {
    return sharp(await page.screenshot()).extract({ left: 495, top: 20, width: 1, height: 1 }).raw().toBuffer();
  }));
  await desk.getByRole('button', { name: 'Buddy 打招呼' }).press('Enter');
  await desk.locator('#greet').evaluate(b => b.click());
  await Promise.all([desk, ...screens].map(page => page.locator('.led-buddy[data-motion="wave"]').waitFor()));
  await Promise.all(screens.map(p => p.waitForFunction(() => window.stageTrace.wave)));
  assert.equal(app.store.screen().version, 1);
  const waveTimes = await Promise.all(screens.map(p => p.evaluate(() => window.stageTrace.wave)));
  for (const [i,page] of screens.entries()) {
    const surface = await page.locator('.led-greeting').evaluate(c => ({
      visible: c.checkVisibility({ visibilityProperty: true }), width: c.width,
      clearCorner: c.getContext('2d').getImageData(0,0,1,1).data[3]
    }));
    assert.deepEqual(surface, { visible: true, width: film.greeting.cell, clearCorner: 0 });
    const sample = await sharp(await page.screenshot()).extract({left:495,top:20,width:1,height:1}).raw().toBuffer();
    assert.deepEqual(sample,backdrops[i]);
  }
  assert(await desk.locator('#greet').isDisabled());
  await desk.locator('#quote').fill('先听反馈，再改流程。');
  await desk.locator('#manual-send').click();
  const text = '先听反馈再改流程';
  await Promise.all([desk, ...screens].map(p => p.locator('.led-quote').getByText(text, { exact: true }).waitFor()));
  await until(async () => (await (await app.call('control')).json()).displayed === 2);
  for (const page of screens) assert.equal(await page.locator('.led-frame').getAttribute('data-greeting-visible'), null);
  const published = app.store.screen();
  assert.equal(published.text, text);
  assert.equal(await desk.locator('#receipt-count').innerText(), '2 / 2 屏回执');
  const first = await Promise.all(screens.map(p => p.evaluate(() => window.stageTrace.quote)));
  await screens[1].reload();
  await screens[1].locator('.led-quote').getByText(text, { exact: true }).waitFor();
  await Promise.all(screens.map(p => p.waitForFunction(() => window.stageTrace.clear, null, { timeout: 14000 })));
  const traces = await Promise.all(screens.map(p => p.evaluate(() => window.stageTrace)));
  for (const trace of traces) {
    assert(trace.fade && trace.clear > trace.fade);
    assert(trace.lastInk - published.publishedAt <= 10000);
    assert(Math.abs(trace.clear - published.publishedAt - 10000) < 180);
  }
  const skew = Math.abs(traces[0].clear - traces[1].clear);
  assert(skew < 120);
  await until(async () => {
    const s = await (await app.call('control')).json();
    return s.screen.kind === 'idle' && s.displayed === 2;
  });
  for (const page of [desk, ...screens]) {
    await page.locator('.scene[data-kind="idle"] .led-buddy[data-motion="play"]').waitFor();
    assert.equal(await page.locator('.led-quote').textContent(), '');
  }
  assert(await desk.locator('#greet').isEnabled());
  assert(app.store.history().some(s => s.text === text));
  assert.deepEqual(errors, []);
  console.log('独立彩排通过', JSON.stringify({
    screens: 2, receipts: await desk.locator('#receipt-count').innerText(), quote: text,
    waveSkewMs: Math.round(Math.abs(waveTimes[0] - waveTimes[1])),
    textSkewMs: Math.round(Math.abs(first[0] - first[1])),
    lastVisibleMs: traces.map(t => Math.round(t.lastInk - published.publishedAt)),
    clearedAfterPublishMs: traces.map(t => Math.round(t.clear - published.publishedAt)),
    clearSkewMs: Math.round(skew), secondScreenReloaded: true,
  }));
} finally {
  await browser?.close();
  await app.cleanup();
}
