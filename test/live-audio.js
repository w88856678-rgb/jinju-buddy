// Opt-in real ASR + Hy4. Runs a separate activity in a temporary database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { chromium } from 'playwright';
import { credentials, providers } from '../server/config.js';
import { extractQuote, extractQuoteBatch } from '../server/quotes.js';
import { quoteText } from '../public/format.js';
import { sentencesOf } from '../server/asr.js';
import { mockCloud, testApp, wire, until } from './support.js';
const { values: args } = parseArgs({
  options: {
    file: { type: 'string' },
    name: { type: 'string', default: '合成' },
    start: { type: 'string', default: '0' },
    duration: { type: 'string' },
    provider: { type: 'string', default: 'tencent' },
    mode: { type: 'string', default: 'debate' },
    out: { type: 'string', default: 'output/现场发言验收' },
    browser: { type: 'boolean' },
    timed: { type: 'boolean' },
    'replay-tencent': { type: 'string' },
    pick: { type: 'string' },
  },
});
assert(args.file, '请提供 --file 录音路径');
assert(!(args.browser && args.timed), '请选择模拟麦克风或按原声计时的回放');
const keys = credentials();
assert(providers(keys)[args.provider] && keys.token, '请先在服务端配置所选识别服务与 Hy4');
const ffmpegArgs = ['-loglevel', 'error', '-ss', args.start, '-i', args.file];
if (args.duration) ffmpegArgs.push('-t', args.duration);
const decoded = spawnSync('ffmpeg', [...ffmpegArgs, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], {
  maxBuffer: 64 * 1024 * 1024,
});
assert.equal(decoded.status, 0, '无法解码测试音频');
const pcm = decoded.stdout;
const recorded = args['replay-tencent'] ? JSON.parse(await readFile(args['replay-tencent'], 'utf8')) : null;
if (recorded) {
  assert(args.timed && args.provider === 'tencent' && recorded.provider === 'tencent' && args.mode === recorded.mode);
  assert.equal(createHash('sha256').update(pcm).digest('hex'), recorded.inputSHA256);
}
const replayCloud = recorded ? await mockCloud() : null;
const target = resolve(args.out);
await mkdir(target, { recursive: true });
const evidence = {
  file: args.file.split('/').at(-1),
  startSeconds: Number(args.start),
  durationMs: pcm.length / 32,
  provider: args.provider,
  mode: args.mode,
  path: recorded ? '固定历史腾讯回调、实际 Hy4 和 Chrome 控台按钮计时' :
    args.browser ? 'Chrome 模拟麦克风' : args.timed ? '实时 PCM 与 Chrome 控台按钮计时' : '直接 PCM',
  inputSHA256: createHash('sha256').update(pcm).digest('hex'),
  events: [],
  candidates: [],
  extractionCalls: [],
};
let zero = performance.now();
const afterMs = () => Math.round(performance.now() - zero);
const hash = createHash('sha256');
let cloudBytes = 0;
const app = await testApp({
  credentials,
  quoteTiming: {},
  generate: (row, context) => {
    evidence.extractionCalls.push({ ms: afterMs(), ids: [row.id] });
    return extractQuote(keys.token, row, context);
  },
  generateBatch: (rows, context) => {
    evidence.extractionCalls.push({ ms: afterMs(), ids: rows.map(r => r.id) });
    return extractQuoteBatch(keys.token, rows, context);
  },
  dialAsr(url, options) {
    const ws = replayCloud ? replayCloud.dial(url) : new WebSocket(url, { ...options, handshakeTimeout: 10000 });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      evidence.events.push({ ms: afterMs(), code: m.code, final: m.final, sentences: sentencesOf(m) });
    });
    const send = ws.send.bind(ws);
    ws.send = (data, ...rest) => {
      const audio = Buffer.isBuffer(data) ? data : JSON.parse(data).audio;
      if (audio) {
        const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio, 'base64');
        cloudBytes += buf.length;
        hash.update(buf);
      }
      return send(data, ...rest);
    };
    return ws;
  },
});
let browser, observed;
try {
  observed = wire(app, 'control', true);
  observed.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'segment')
      evidence.candidates.push({
        ms: afterMs(),
        id: m.row.id,
        rev: m.row.rev,
        status: m.row.status,
        quote: m.row.quote,
      });
  });
  let page, stage, activeShot, pageClock;
  if (args.browser || args.timed) {
    const wav = join(app.dir, 'source.wav');
    if (args.browser) {
      const pre = Buffer.alloc(32000); // Keep file boundaries visible after the fake microphone opens.
      const audio = Buffer.concat([pre, pcm, Buffer.alloc(48000)]);
      assert.equal(
        spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', '-', '-y', wav],
          { input: audio }).status,
        0,
      );
    }
    const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || (existsSync(localChrome) ? localChrome : undefined),
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        ...(args.browser ? ['--use-file-for-fake-audio-capture=' + wav + '%noloop'] : []),
        '--no-proxy-server',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    const ctrl = await browser.newContext({
      viewport: { width: 1500, height: 990 },
      permissions: ['microphone'],
    });
    const proj = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await ctrl.newPage();
    stage = await proj.newPage();
    await stage.goto(app.url + '/stage');
    await page.goto(app.url + '/control');
    await page.locator('#workspace').waitFor();
    await page.locator('#speech-mode').selectOption(args.mode);
    await page.locator('#audio-settings summary').click();
    await page.locator('#audio-settings summary').click();
    await page.evaluate(() => document.fonts.ready);
    zero = performance.now();
  }
  if (args.timed) {
    const samples = [];
    for (let i = 0; i < 7; i++) {
      const before = performance.now();
      const pageNow = await page.evaluate(() => performance.now());
      const after = performance.now();
      samples.push({ offset: (after + before) / 2 - pageNow - zero, rtt: after - before });
    }
    pageClock = samples.sort((a, b) => a.rtt - b.rtt)[0];
    evidence.clockRoundTripMs = pageClock.rtt;
    await page.evaluate(() => {
      window.quoteAppearances = [];
      const seen = new Set();
      const panel = document.querySelector('#candidates');
      const observe = () => {
        const bounds = panel.getBoundingClientRect();
        for (const card of panel.querySelectorAll('.candidate')) {
          const button = card.querySelector('.send-candidate');
          if (button.disabled || !button.getClientRects().length) continue;
          const rect = button.getBoundingClientRect();
          if (rect.bottom <= Math.max(0, bounds.top) || rect.top >= Math.min(innerHeight, bounds.bottom)) continue;
          const quote = card.querySelector('.candidate-text');
          const id = decodeURIComponent(quote.id.slice('quote-'.length));
          const review = card.querySelector('.review-note');
          const warning = review.hidden ? '' : review.textContent;
          const key = JSON.stringify([id, quote.textContent, warning]);
          if (seen.has(key)) continue;
          seen.add(key);
          window.quoteAppearances.push({ id, text: quote.textContent, lines:[...quote.children].map(s=>s.textContent), warning, at: performance.now() });
        }
      };
      new MutationObserver(() => requestAnimationFrame(observe)).observe(panel,
        { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await page.locator('#source-section').scrollIntoViewIfNeeded();
  }
  if (args.browser) {
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#record-status').dataset.phase === 'recording');
    activeShot = (async () => {
      await page.waitForFunction(
        () =>
          !document.querySelector('#live-state').hidden && document.querySelectorAll('.candidate').length > 0,
        null,
        { timeout: pcm.length / 32 + 1500 },
      );
      await page.screenshot({ path: join(target, args.name + '-识别中.png') });
      return true;
    })().catch(() => false);
    await sleep(pcm.length / 32 + 2300);
    await page.locator('#record').click();
    await page.waitForFunction(
      () => document.querySelector('#record-status').dataset.phase === 'idle',
      null,
      { timeout: 35000 },
    );
    evidence.activeScreenshot = await activeShot;
  } else {
    const mic = wire(app, 'mic&provider=' + args.provider + '&mode=' + args.mode, true);
    await mic
      .wait((m) => m.type === 'ready' || m.type === 'error')
      .then((m) => assert.equal(m.type, 'ready', m.message));
    const start = performance.now();
    evidence.audioStartMs = start - zero;
    const replayEvents = recorded && (async () => {
      const conn = replayCloud.connections[0];
      for (const event of recorded.events) {
        if (!event.sentences?.length && !event.final) continue;
        await sleep(Math.max(0, start + event.ms - recorded.audioStartMs - performance.now()));
        if (event.final) await until(() => conn.ended);
        conn.send({ sentences:event.sentences, final:event.final });
      }
    })();
    let maxDrift = 0;
    for (let i = 0; i < pcm.length; i += 1280) {
      const deadline = start + (args.timed ? Math.min(i + 1280, pcm.length) : i) / 32;
      await sleep(Math.max(0, deadline - performance.now()));
      maxDrift = Math.max(maxDrift, performance.now() - deadline);
      mic.ws.send(pcm.subarray(i, i + 1280));
    }
    evidence.maxPlaybackDriftMs = Math.round(maxDrift);
    mic.send({ type: 'end' });
    await until(() => mic.messages.find((m) => m.type === 'ended' || m.type === 'error'), 20000).then((m) =>
      assert.equal(m.type, 'ended', m.message),
    );
    if (replayEvents) await replayEvents;
  }
  await until(() => !app.store.pending().length, 65000);
  assert.equal(app.store.screen().version, 0);
  evidence.rows = app.store
    .segments()
    .map(
      ({ id, body, speaker, startMs, endMs, rev, quote, status, sourceIds, review, problem, latencyMs, quoteEvidence }) => ({
        id,
        body,
        speaker,
        startMs,
        endMs,
        rev,
        quote,
        status,
        sources: JSON.parse(sourceIds || '[]'),
        review,
        problem,
        latencyMs,
        quoteEvidence,
      }),
    );
  evidence.editorCards = app.store.cards.all();
  evidence.timings = app.store.db.prepare('SELECT * FROM editorial_timing').all();
  const visibleCards = [...evidence.rows,...evidence.editorCards].filter(r => ['review','ready'].includes(r.status) && quoteText(r.quote));
  evidence.metrics = app.store.get('lastCapture');
  evidence.cloudMs = cloudBytes / 32;
  evidence.cloudSHA256 = hash.digest('hex');
  if (!args.browser) assert.equal(evidence.inputSHA256, evidence.cloudSHA256);
  if (args.timed) {
    await page.waitForFunction(n => Number(document.querySelector('#candidate-count').textContent) === n,
      visibleCards.length);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    evidence.uiCards = (await page.evaluate(() => window.quoteAppearances)).map(({ at, ...card }) => ({
      ...card, audioMs: Math.round(at + pageClock.offset - evidence.audioStartMs),
    }));
    evidence.screenBeforeSelection = app.store.screen().version;
  }
  if (args.browser || args.timed) {
    const pool = visibleCards.filter(s=>s.status==='ready')
      .map(s => ({ ...s, quote: quoteText(s.quote) }));
    await page.waitForFunction(n => Number(document.querySelector('#candidate-count').textContent) === n, visibleCards.length);
    const enabled = await page.locator('.candidate:has(.send-candidate:enabled) .candidate-text').allTextContents();
    const requested = args.pick && pool.find((s) => s.quote.includes(args.pick));
    const chosen = args.pick ? requested : !args.timed && pool.find((s) => enabled.includes(s.quote));
    if (args.pick && !requested) evidence.selection = '未找到指定候选';
    if (chosen) {
      const card = page
        .locator('.candidate')
        .filter({ has: page.locator('.candidate-text').filter({hasText:chosen.quote}) })
        .first();
      const send = card.getByRole('button', { name: '发送', exact: true });
      if (await send.isDisabled()) {
        const note = card.locator('.service-note:visible').first();
        evidence.selection = { text: chosen.quote, reason: await note.count() ? await note.textContent() : '该候选暂时无法发送' };
      } else {
        await send.focus();
        const sentAt = performance.now();
        await page.keyboard.press('Enter');
        await stage.waitForFunction(text => document.querySelector('.led-quote')?.textContent === text, chosen.quote);
        await until(
          () => observed.messages.some((m) => m.ackVersion === app.store.screen().version && m.displayed > 0),
          8000,
        );
        await page.waitForFunction(() => document.querySelector('#screen-status').textContent === '大屏已显示');
        evidence.display = {
          text: chosen.quote,
          adapted: Boolean(chosen.quoteEvidence),
          version: app.store.screen().version,
          acknowledged: true,
          key: 'Enter',
          receiptMs: Math.round(performance.now() - sentAt),
        };
        await stage.screenshot({ path: join(target, args.name + '-投影.png') });
      }
    }
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(target, args.name + '-控台.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => window.scrollTo(0, document.querySelector('#source-section').offsetTop - 8));
    await page.screenshot({ path: join(target, args.name + '-窄屏.png') });
  }
  console.log(
    args.name,
    '音频毫秒',
    evidence.cloudMs,
    '定稿/候选',
    evidence.rows.length,
    evidence.rows.filter((r) => r.status === 'ready').length,
  );
} finally {
  await writeFile(join(target, args.name + '.json'), JSON.stringify(evidence, null, 2));
  observed?.ws.close();
  await browser?.close();
  await app.cleanup();
  await replayCloud?.stop();
}
