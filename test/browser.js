// Isolated browser rehearsal: no Tencent credentials, no cloud audio, no stage changes in the live event.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { mockCloud, sentence, testApp, until, wire } from './support.js';

const fixture = (name) => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
const proofDir = process.env.BUDDY_PROOF_DIR;
const spokenQuote = '判断一次服务的价值，要听服务对象的反馈。';
const quote = '判断一次服务的价值要听服务对象的反馈';
const original = '签到可以记录谁来过。要评价服务做得好不好，还是应该听服务对象的反馈。';
const longFact = '在这一次面向全市多个社区的走访中，真正按时完成复查的只有一百户。';
const shortFact = '真正按时完成复查的只有一百户。';
const confirmedFact = '十户完成复查。';
const cloud = await mockCloud();
const app = await testApp({
  listenHost: '0.0.0.0',
  dialAsr: cloud.dial,
  generate: async row => {
    const shortened = row.body === original ? spokenQuote : row.body === longFact ? shortFact :
      row.body.startsWith('刚才我口误说成') || row.body.startsWith('刚才我口误，说成') ? confirmedFact : null;
    return shortened ? { status: 'ready', quote: shortened, sources: [row.id], quoteEvidence: row.body } : row.body;
  },
});
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
try {
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : existsSync(localChrome)
        ? { executablePath: localChrome }
        : {}),
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-proxy-server',
    ],
  });
  const ctrlContext = await browser.newContext({
    viewport: { width: 1440, height: 940 },
    permissions: ['microphone'],
  });
  const stageContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const control = await ctrlContext.newPage(),
    stage = await stageContext.newPage(),
    errors = [];
  for (const page of [control, stage]) page.on('pageerror', (e) => errors.push(e.message));
  await control.goto(app.url + '/control');
  await control.locator('#workspace').waitFor({ state: 'visible' });
  const clearLive = control.getByRole('button', { name: '清空实时逐字稿' });
  assert(await clearLive.isDisabled());
  const shared = await control.locator('#stage-url').getAttribute('href');
  // Use the same LAN link an operator copies to their projection computer.
  const stageAddress = new URL(shared);
  let stageSocket;
  app.server.on('upgrade', (req, socket) => {
    if (req.url.endsWith('role=stage')) stageSocket = socket;
  });
  await stage.goto(stageAddress.href);
  await stage.locator('.scene[data-kind="idle"]').waitFor();
  await control.getByText('大屏已连接', { exact: true }).waitFor();
  const motion = stage.locator('.led-buddy .idle-pose');
  const waitForMotion = (page, state) => page.locator('.led-buddy[data-motion="' + state + '"]').waitFor();
  await waitForMotion(stage, 'play');
  await waitForMotion(control, 'play');
  await stage.keyboard.press('f');
  assert.ok(await stage.evaluate(() => Boolean(document.fullscreenElement)));
  await stage.mouse.move(0, 0);
  const timings = [];
  const waitForQuote = (text) => stage.waitForFunction(expected => {
    const track = document.querySelector('.scene[data-kind="quote"] .led-quote-track');
    return track && !track.getAnimations().length && track.querySelector('.led-quote').textContent === expected;
  }, text);
  const write = async (text, expected = text) => {
    await control.getByRole('textbox', { name: '金句输入' }).fill(text);
    const start = performance.now();
    await control.getByRole('button', { name: '发送到大屏' }).click();
    await until(async () => (await stage.locator('.led-quote').textContent()) === expected);
    await until(async () => (await control.locator('#preview .led-quote').textContent()) === expected);
    await until(async () => {
      const s = await (await app.call('control')).json();
      return s.screen.text === expected && s.displayed === 1;
    });
    timings.push(Math.round(performance.now() - start));
  };
  await control.locator('#quote').fill('！？……');
  assert(await control.locator('#manual-send').isDisabled());
  assert.equal(await control.locator('#quote-count').textContent(), '0 / 320');
  await write('「第一句，测试金句！」', '第一句测试金句');
  await waitForMotion(stage, 'listening');
  await waitForMotion(control, 'listening');
  assert.equal(await stage.locator('.led-quote').textContent(), '第一句测试金句');
  // An intentional resend is a new publication even when the visible words match.
  await write('第一句测试金句');
  await waitForMotion(stage, 'listening');
  // Hold a real roll midway so two rapid publications exercise the same incoming slot.
  const track = stage.locator('.led-quote-track');
  await track.evaluate((n) => {
    const observer = new MutationObserver(() => {
      const animation = n.getAnimations()[0];
      if (!animation) return;
      observer.disconnect();
      animation.pause();
      animation.currentTime = animation.effect.getTiming().delay + 75;
    });
    observer.observe(n, { childList: true, subtree: true });
  });
  await app.call('publish', { kind: 'quote', op: 'during-roll-first', text: '正在进场的金句' });
  await until(() => track.evaluate(n => n.getAnimations()[0]?.playState === 'paused'));
  await app.call('publish', { kind: 'quote', op: 'during-roll-latest', text: '后来发出的金句' });
  await until(async () => await stage.locator('.led-quote').textContent() === '后来发出的金句');
  assert.equal((await (await app.call('control')).json()).displayed, 0);
  const duringRoll = await track.evaluate(n => {
    const old = n.querySelector('.led-quote-outgoing');
    const top = n.parentNode.getBoundingClientRect().top;
    const animations = n.getAnimations();
    return {
      old: old.textContent, hiddenFromSpeech: old.getAttribute('aria-hidden'),
      above: old.getBoundingClientRect().top < top,
      below: n.querySelector('.led-quote').getBoundingClientRect().top > top,
      count: animations.length, time: animations[0].currentTime - animations[0].effect.getTiming().delay,
      duration: animations[0].effect.getTiming().duration,
    };
  });
  assert.deepEqual(duringRoll, {
    old: '第一句测试金句', hiddenFromSpeech: 'true', above: true, below: true, count: 1, time: 75, duration: 180,
  });
  await track.evaluate(n => n.getAnimations()[0].play());
  await until(async () => (await (await app.call('control')).json()).displayed === 1);
  assert.equal(await stage.locator('.led-quote-outgoing').textContent(), '');
  for (const text of ['第二句测试金句', '第三句测试金句']) await write(text);
  await until(async () => (await control.locator('#screen-status').textContent()) === '大屏已显示');
  console.log(
    '独立浏览器上屏耗时（毫秒）',
    timings.join(' / '),
    '，投影使用局域网地址',
    stageAddress.hostname !== '127.0.0.1'
  );
  await stage.reload();
  await waitForQuote('第三句测试金句');
  await waitForMotion(stage, 'listening');
  const long = '观点要保留成立的条件和适用的范围。'.repeat(18);
  await control.locator('#quote').fill(long);
  assert(await control.locator('#manual-send').isDisabled());
  assert(await control.locator('#length-hint').isVisible());
  await control.locator('#quote').press('Control+Enter');
  assert.equal(app.store.screen().text, '第三句测试金句');
  stageSocket.destroy();
  await until(async () => (await stage.locator('#stage-status').textContent()) === '正在重连');
  assert.equal(await stage.locator('.led-quote').textContent(), '第三句测试金句');
  await app.call('publish', { op: 'offline-manual', kind: 'quote', text: '重连后显示最新金句' });
  await waitForQuote('重连后显示最新金句');

  const draft = '接下来请两位辩手回应同一个问题';
  await control.locator('#quote').fill('接下来，请两位辩手回应同一个问题。');
  assert(await control.locator('#record-play svg').isVisible());
  assert(await control.locator('#record-pause').isHidden());
  await control.getByRole('button', { name: '开始收音' }).click();
  await control.getByRole('button', { name: '暂停收音' }).waitFor();
  assert(await control.locator('#record-pause svg').isVisible());
  assert(await control.locator('#record-play').isHidden());
  const c = cloud.connections[0];
  await until(() => c?.packets.length >= 8, 5000);
  await until(() => c.packets.some((buf) => buf.some((v) => v !== 0)), 5000);
  assert.ok(
    c.packets.every((buf) => buf.length === 1280),
    '音频应为每 40 毫秒 1280 字节的 PCM'
  );
  c.send({ sentences: { sentence_list: [sentence(0, 0, '签到可以记录', 0)] } });
  const liveText = control.getByRole('textbox', {name:'实时逐字稿'});
  await until(async () => (await liveText.inputValue()) === '签到可以记录');
  assert(await liveText.evaluate(n => n.readOnly));
  c.send({sentences:[sentence(0,0,'签到可以记录多少人',0)]});
  await until(async()=>await liveText.inputValue()==='签到可以记录多少人');
  const one = sentence(0, 0, original),
    two = sentence(1, 1, '能持续参与，靠的是选择和承诺。');
  c.send({ sentences: { sentence_list: [one, two] } });
  await until(async () => (await control.locator('.candidate').count()) === 2);
  assert.equal(await control.locator('#quote').inputValue(), draft);
  assert.equal(await stage.locator('.led-quote').textContent(), '重连后显示最新金句');
  c.onEnd = () => {
    c.send({ final: 1 });
  };
  await control.getByRole('button', { name: '暂停收音' }).click();
  await control.getByRole('button', { name: '继续收音' }).waitFor();
  assert.equal(await control.locator('#record-status').textContent(), '已暂停');
  await control.locator('#records summary').click();
  assert.equal(await liveText.inputValue(), original + '\n\n' + two.sentence);
  assert.doesNotMatch(await control.locator('body').innerText(), /(?:发言人|说话人)\s*\d/);
  assert.doesNotMatch((await control.locator('#paste-speaker option').allTextContents()).join(' '), /(?:发言人|说话人)\s*\d/);
  await control.getByRole('combobox', {name:/设置发言.*签到可以记录/}).selectOption('正方');
  await control.getByRole('combobox', {name:/设置发言.*能持续参与/}).selectOption('反方');
  const saved = control.waitForEvent('download');
  await control.locator('#download').click();
  const download = await saved;
  const txt = await readFile(await download.path(), 'utf8');
  assert.ok(txt.includes('发言人 1｜正方') && txt.includes('发言人 2｜反方') && txt.includes(original));
  assert.equal(
    (await stageContext.request.get(new URL('./api/transcript', stageAddress).href)).status(),
    401
  );
  await control.locator('#records summary').click();
  const first = control.locator('.candidate').filter({ hasText: quote });
  assert.equal(await first.locator('.candidate-text').textContent(), quote);
  assert.equal(await first.locator('.adapted-label').innerText(), '现场金句');
  await first.getByText('原发言', { exact: true }).click();
  assert.match(await first.locator('.quote-evidence').innerText(), /原话依据.*签到可以记录谁来过/);
  await first.getByText('原发言', { exact: true }).click();
  await first.getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await first.getByRole('textbox').inputValue(), quote);
  assert.equal(await control.locator('#quote').inputValue(), draft);
  const revised = '服务的成效要听服务对象怎么说';
  await first.getByRole('textbox', { name: '编辑候选金句' }).fill('服务的成效，要听服务对象怎么说。');
  await first.getByRole('button', { name: '发送改写' }).click();
  await waitForQuote(revised);
  await first.getByText('改写已上屏', { exact: true }).waitFor();
  await first.getByRole('button', { name: '发送', exact: true }).click();
  await waitForQuote(quote);
  await first.getByText('大屏正显示', { exact: true }).waitFor();
  assert.equal(await stage.getByText('现场金句', { exact: true }).count(), 0);
  assert.equal(await control.locator('#preview').getByText('现场金句', { exact: true }).count(), 0);
  const second = control.locator('.candidate').filter({ hasText: '能持续参与靠的是选择和承诺' });
  await second.getByRole('button', { name: '发送', exact: true }).click();
  await second.getByText('大屏正显示', { exact: true }).waitFor();
  assert.ok(await first.locator('.confirmed-label').isHidden());
  await control.getByRole('button', { name: '恢复上一屏' }).click();
  await first.getByText('大屏正显示', { exact: true }).waitFor();
  await until(async () => (await control.locator('#screen-status').textContent()) === '大屏已显示');
  assert.equal(await control.locator('#quote').inputValue(), draft);
  await control.locator('#history summary').click();
  await control.locator('.history-item').filter({ hasText: revised }).getByRole('button', { name: '重新展示' }).click();
  await waitForQuote(revised);
  await control.locator('#history summary').click();
  await first.getByRole('button', { name: '发送', exact: true }).click();
  await waitForQuote(quote);
  await stage.evaluate(() => document.fonts.ready);
  await control.evaluate(() => document.fonts.ready);
  if (proofDir) await mkdir(proofDir, { recursive: true });
  const otherContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const otherStage = await otherContext.newPage();
  await otherStage.goto(stageAddress.href);
  await until(async () => (await control.locator('#receipt-count').textContent()) === '2 / 2 屏回执');
  const gates = [];
  for (const page of [stage, otherStage]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    gates.push(release);
    await page.route('**/qr/*.png', async (route) => { await gate; await route.continue(); }, { times: 1 });
  }
  const invalid = await sharp({ create: { width: 150, height: 150, channels: 3, background: 'white' } }).png().toBuffer();
  await control.locator('#qr-file').setInputFiles({ name: '纯色.png', mimeType: 'image/png', buffer: invalid });
  await control.locator('#qr-target').getByText(/未识别到二维码/).waitFor();
  assert.ok(await control.locator('#upload').isDisabled());
  assert.equal(app.store.screen().text, quote);
  await control.getByRole('button', { name: '取消选图' }).click();
  // Scan the rendered on-screen pixels for two distinct uploaded codes.
  for (const [file, letter] of [
    ['qr-a.png', 'a'],
    ['qr-b.jpg', 'b'],
  ]) {
    await until(() => control.locator('#qr-file').isEnabled());
    await control.locator('#qr-file').setInputFiles(fixture(file));
    const lastId = app.store.get('lastQr');
    await control.getByRole('button', { name: '上传并展示' }).click();
    const newId = await until(() => {
      const id = app.store.get('lastQr');
      return id && id !== lastId ? id : null;
    });
    if (letter === 'a') {
      await until(async () => (await control.locator('#receipt-count').textContent()) === '0 / 2 屏回执');
      assert.equal(await control.locator('#screen-status').textContent(), '已保存，等待大屏显示');
      assert.equal(await control.locator('.confirmed-label:visible').count(), 0);
      assert.ok((await control.locator('#last-ack').textContent()).includes(quote));
      assert.equal(await stage.locator('.led-quote').textContent(), quote);
      gates[0]();
      await until(async () => (await control.locator('#screen-status').textContent()) === '部分大屏已显示');
      assert.equal(await control.locator('#receipt-count').textContent(), '1 / 2 屏回执');
      gates[1]();
      await until(async () => (await control.locator('#receipt-count').textContent()) === '2 / 2 屏回执');
      await otherContext.close();
      await until(async () => (await control.locator('#receipt-count').textContent()) === '1 / 1 屏回执');
    }
    const qr = stage.locator('.led-code canvas[data-image="' + newId + '"]');
    await qr.waitFor();
    await until(async () => {
      const { data, info } = await sharp(await qr.screenshot())
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return (
        jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ===
        'https://example.org/debate/' + letter
      );
    }, 5000);
    assert.equal(await stage.locator('.led-buddy').isVisible(), false);
    assert.equal(await motion.evaluate(img => img.getAnimations().length), 0);
    if (letter === 'a' && proofDir) {
      if (!await stage.evaluate(() => Boolean(document.fullscreenElement))) {
        await stage.keyboard.press('f');
        await stage.mouse.move(0, 0);
      }
      const projected = await stage.screenshot({ path: resolve(proofDir, '投影-总结二维码.png') });
      const { data, info } = await sharp(projected).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data, 'https://example.org/debate/a');
      console.log('总结码白底方区边长', await qr.evaluate((e) => Math.min(e.clientWidth, e.clientHeight)), 'px');
      await control.getByRole('button', { name: '恢复上一屏' }).click();
      await waitForQuote(quote);
      await control.getByRole('button', { name: '继续收音' }).click();
      await control.getByRole('button', { name: '暂停收音' }).waitFor();
      await control.locator('#toast').waitFor({ state: 'hidden' });
      await stage.locator('.led-buddy').waitFor({ state: 'visible' });
      await control.evaluate(() => window.scrollTo(0, 0));
      await stage.screenshot({ path: resolve(proofDir, '投影-现场金句.png') });
      await control.screenshot({ path: resolve(proofDir, '现场控台.png'), fullPage: true });
      const cdp = await stageContext.newCDPSession(stage);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.led-quote > span' });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      assert.ok(fonts.some((f) => /tencent|腾讯/i.test(f.familyName + f.postScriptName)));
      console.log('1920 × 1080 投影金句字号', await stage.locator('.led-quote').evaluate((e) => getComputedStyle(e).fontSize), '实际字体', fonts.map((f) => f.postScriptName).join(','));
      await cdp.detach();
      cloud.connections.at(-1).onEnd = () => cloud.connections.at(-1).send({ final: 1 });
      await control.getByRole('button', { name: '暂停收音' }).click();
      await control.getByRole('button', { name: '继续收音' }).waitFor();
    }
    await write('二维码之后继续发言');
    await control.getByRole('button', { name: '展示已存二维码' }).click();
    await qr.waitFor();
  }
  const savedQr = app.store.get('lastQr');
  await until(() => control.locator('#qr-file').isEnabled());
  await control.locator('#qr-file').setInputFiles(fixture('qr-a.png'));
  await control.getByRole('button', { name: '取消选图' }).click();
  assert.equal(app.store.get('lastQr'), savedQr);
  assert.equal(await control.getByRole('button', { name: '上传并展示' }).isVisible(), false);
  const removeQr = control.getByRole('button', { name: '删除当前二维码' });
  await removeQr.click();
  await control.getByRole('dialog').waitFor();
  assert.equal(await control.getByRole('button', { name: '取消', exact: true }).evaluate((el) => el === document.activeElement), true);
  await control.keyboard.press('Escape');
  assert.equal(app.store.screen().image, savedQr);
  await removeQr.click();
  await control.getByRole('button', { name: '确认删除' }).click();
  await stage.locator('.scene[data-kind="idle"]').waitFor();
  await control.reload();
  await control.getByRole('button', { name: '撤销删除' }).click();
  await control.getByRole('button', { name: '展示已存二维码' }).waitFor();
  assert.equal(app.store.get('lastQr'), savedQr);
  assert.equal(app.store.screen().kind, 'idle');
  await control.getByRole('button', { name: '展示已存二维码' }).click();
  await stage.locator('.led-code canvas[data-image="' + savedQr + '"]').waitFor();
  await write('删除后台图片时保留这句金句');
  await removeQr.click();
  await control.getByRole('button', { name: '确认删除' }).click();
  await control.getByRole('button', { name: '撤销删除' }).waitFor();
  assert.equal(await stage.locator('.led-quote').textContent(), '删除后台图片时保留这句金句');
  await control.getByRole('button', { name: '回到待场' }).click();
  await stage.locator('.scene[data-kind="idle"]').waitFor();
  assert.ok(await stage.locator('.led-quote').isHidden());
  await control.getByRole('button', { name: '粘贴发言' }).click();
  const paste = '当一个服务持续三年，参与者的感受比签到次数更有说服力。';
  await control.locator('#source').fill(paste);
  await control.locator('#paste-speaker').selectOption('1:1');
  await control.reload();
  await control.locator('#source').waitFor();
  assert.equal(await control.locator('#source').inputValue(), paste);
  await until(async () => (await control.locator('#paste-speaker').inputValue()) === '1:1');
  const failedOnce = (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '彩排连接暂时中断' }) });
  await control.route('**/api/paste', failedOnce, { times: 1 });
  await control.getByRole('button', { name: '提炼候选' }).click();
  await control.locator('#toast').getByText('彩排连接暂时中断').waitFor();
  assert.equal(await control.locator('#source').inputValue(), paste);
  await control.getByRole('button', { name: '提炼候选' }).click();
  await until(async () => (await control.locator('#source').inputValue()) === '');
  assert.equal(await control.locator('.candidate').count(), 2, '旧记录里放不下 LED 的候选也不能出现在列表');
  await control.getByRole('link', { name: '逐字稿', exact: true }).click();
  const transcript = control.locator('.transcript-row').filter({ hasText: paste });
  await transcript.getByRole('button', { name: '校订文字' }).click();
  await control.getByLabel('校订文字').fill('持续服务三年的效果，应当听服务对象的反馈。');
  await control.getByRole('button', { name: '保存校订' }).click();
  const correctedRow = control.locator('.transcript-row').filter({ hasText: '持续服务三年的效果' });
  await correctedRow.getByText('已校订', { exact: true }).waitFor();
  assert.match(await (await app.call('transcript')).text(), /持续服务三年的效果/);
  await correctedRow.getByRole('button', { name: '校订文字' }).click();
  await control.getByLabel('从 TXT 导出中排除').check();
  await control.getByRole('button', { name: '保存校订' }).click();
  await correctedRow.getByText(/已排除导出/).waitFor();
  assert.doesNotMatch(await (await app.call('transcript')).text(), /持续服务三年的效果/);
  await correctedRow.getByRole('button', { name: '校订文字' }).click();
  await control.getByRole('button', { name: '恢复原文' }).click();
  await control.getByLabel('从 TXT 导出中排除').uncheck();
  await control.getByRole('button', { name: '保存校订' }).click();
  await transcript.waitFor();
  assert.match(await (await app.call('transcript')).text(), /当一个服务持续三年/);
  await control.locator('#records summary').click();
  await control.locator('#quote').fill('键盘也能把备句送上大屏。');
  await control.locator('#quote').press('Control+Enter');
  await waitForQuote('键盘也能把备句送上大屏');
  await stage.emulateMedia({ reducedMotion: 'reduce' });
  await stage.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
  await write(spokenQuote, quote);
  assert.equal(await motion.evaluate((img) => img.getAnimations().length), 0);
  await until(async () => await stage.locator('.led-buddy').isVisible());
  for (const [width, height] of [[1366, 768], [1024, 768], [720, 480], [390, 844], [320, 568]]) {
    await control.setViewportSize({ width, height });
    await stage.setViewportSize({ width, height });
    await stage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '控台横向溢出 ' + width);
    assert.ok(await stage.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1), '大屏溢出 ' + width);
    const frame = await stage.locator('.scene').boundingBox();
    assert(Math.abs(frame.width / frame.height - 4) < 0.01);
    const monitor = await control.locator('#preview .scene').boundingBox();
    assert(Math.abs(monitor.width / monitor.height - 4) < 0.01);
    assert.deepEqual(await stage.locator('.led-quote span').allTextContents(), ['判断一次服务的价值', '要听服务对象的反馈']);
    if (width === 390 && proofDir) {
      await control.evaluate(() => window.scrollTo(0, 0));
      await control.locator('#toast').waitFor({ state: 'hidden' });
      await control.screenshot({ path: resolve(proofDir, '窄屏-控台.png') });
      await stage.screenshot({ path: resolve(proofDir, '竖屏-金句.png') });
    }
  }
  await write('议'.repeat(24));
  assert.equal(await stage.locator('.led-quote').evaluate((e) => getComputedStyle(e).fontSize), '32px');
  for (const n of [25, 320, 321]) {
    await control.locator('#quote').fill('议'.repeat(n));
    assert(await control.locator('#manual-send').isDisabled());
  }
  assert.equal(await stage.locator('.led-quote').textContent(), '议'.repeat(24));
  // An LED-length edit must retain its ASR source on both desks when the speaker corrects a fact.
  await control.setViewportSize({ width: 1440, height: 940 });
  const desk = await browser.newPage();
  await desk.goto(app.url + '/control');
  await desk.locator('#workspace').waitFor();
  const mic = wire(app, 'mic&mode=speech', true);
  await mic.wait(m => m.type === 'ready');
  const source = cloud.connections.at(-1);
  const beforeEdit = app.store.screen().version;
  source.send({ sentences: [sentence(1, 0, longFact)] });
  const oldCard = page => page.locator('.candidate').filter({ has: page.locator('.candidate-text', { hasText: '真正按时完成复查的只有一百户' }) });
  const shortEdit = '按时完成复查的只有一百户';
  for (const page of [control, desk]) {
    const card = oldCard(page);
    const send = card.getByRole('button', { name: '发送', exact: true });
    await send.waitFor();
    assert(await send.isEnabled());
    await card.getByRole('button', { name: '编辑', exact: true }).click();
    await card.getByRole('textbox').fill(shortEdit);
  }
  assert.equal(app.store.screen().version, beforeEdit);
  await oldCard(desk).getByRole('button', { name: '发送改写' }).click();
  await until(async () => await stage.locator('.led-quote').textContent() === shortEdit);
  const editedVersion = app.store.screen().version;
  const correction = '十户完成复查';
  source.send({ sentences: [sentence(2, -1, '刚才我口误，说成了一百户', 0)] });
  const pendingEdit = oldCard(control).getByRole('button', { name: '发送改写' });
  await until(() => pendingEdit.isDisabled());
  source.send({ sentences: [sentence(2, 0, '刚才我口误，说成了一百户。十户完成复查。')] });
  source.send({ final: 1 });
  await control.locator('#screen-correction').getByText('发言人已更正大屏上的原话，请核对并手动换屏。').waitFor();
  assert.equal(await oldCard(control).getByRole('textbox').inputValue(), shortEdit);
  assert.equal(app.store.screen().version, editedVersion);
  const fixed = desk.locator('.candidate').filter({has:desk.locator('.candidate-text', {hasText:correction})});
  await fixed.getByRole('button', {name:'发送', exact:true}).click();
  await until(async () => await stage.locator('.led-quote').textContent() === correction);
  const replay = await app.call('publish', {kind:'history', op:'old-led-edit', version:editedVersion, currentVersion:app.store.screen().version});
  assert.equal(replay.status, 409);
  await desk.close();
  mic.ws.close();
  console.log('LED 短稿的人工编辑收到回执，改口暂缓两台控台的旧稿，旧画面重发被拦截。');
  // A two-hour transcript should not mount every historical row or displace a focused send button.
  for (let n = 0; n < 1200; n++) {
    const id = 'long-session/' + n;
    const row = app.store.upsert({ id, startMs: 100000 + 6000 * n, endMs: 102000 + 6000 * n, body: '长场发言 ' + n });
    app.store.settle(id, row.rev, 'ready', row.body, null);
  }
  await control.setViewportSize({ width: 1440, height: 940 });
  await control.reload();
  await until(async () => (await liveText.inputValue()).includes('长场发言 1199'));
  const historyText = await liveText.inputValue();
  assert(historyText.indexOf('长场发言 0') < historyText.indexOf('长场发言 1199'));
  assert(await liveText.evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop < 8));
  const scrollBefore = await liveText.evaluate(n => {
    n.focus();
    const pos = n.value.indexOf('长场发言 857');
    n.setSelectionRange(pos, pos + '长场发言 857'.length);
    n.scrollTop = Math.round(n.scrollHeight / 2);
    return n.scrollTop;
  });
  await app.call('paste', {text:'期间又送来一条新发言',op:'selection-retained'});
  await until(async () => (await liveText.inputValue()).includes('期间又送来一条新发言'));
  assert.deepEqual(await liveText.evaluate(n => [n.value.slice(n.selectionStart,n.selectionEnd),n.scrollTop]),
    ['长场发言 857',scrollBefore]);
  assert.equal(await control.locator('.candidate').count(), 24);
  await control.locator('#more-quotes').click();
  await until(async () => (await control.locator('.candidate').count()) === 54);
  const newest = control.locator('.candidate').first();
  const selected = await newest.locator('.candidate-text').textContent();
  await newest.getByRole('button', {name:'发送',exact:true}).focus();
  await control.keyboard.press('Space');
  await waitForQuote(selected);

  // Stop during a slow cloud handshake. The pre-roll must drain at playback speed, including the tail.
  cloud.setReadyDelay(1800);
  const beforeCount = cloud.connections.length;
  await control.locator('#record').click();
  await until(() => cloud.connections.length > beforeCount);
  const slow = cloud.connections.at(-1);
  await until(async () => /采集 0\.[4-9] 秒/.test(await control.locator('#capture-metrics').textContent()));
  assert.equal(slow.packets.length, 0);
  slow.onEnd = () => {
    slow.send({ sentences: [sentence(0,0,'等待握手期间采到的最后一句')] });
    slow.send({ final:1 });
  };
  await control.locator('#record').click();
  await until(() => slow.ended, 8000);
  const duration = slow.packets.reduce((ms, p) => ms + p.length / 32, 0);
  assert(duration >= 350);
  assert(slow.times.at(-1) - slow.times[0] >= duration - 100);
  assert(app.store.segments().some(s => s.body === '等待握手期间采到的最后一句'));
  console.log('慢握手期间实际保留并回放', Math.round(duration), '毫秒；1200 段原文连续显示，空格发送通过。');
  // Both streams restart their cloud sentence IDs at zero. A late final must survive the pause and append once.
  const resumeButton = control.getByRole('button', { name: '继续收音' });
  await resumeButton.waitFor();
  const pausedVersion = app.store.screen().version;
  const firstTail = '等待握手期间采到的最后一句';
  const secondTail = '继续收音后的这句话也要保留';
  const countAtPause = app.store.segments().length;
  cloud.setReadyDelay(0);
  await resumeButton.click();
  await control.getByRole('button', { name: '暂停收音' }).waitFor();
  await until(() => cloud.connections.length === beforeCount + 2);
  const next = cloud.connections.at(-1);
  next.send({ sentences: [sentence(0,0,'继续收音后的这句话',0)] });
  await until(async () => (await liveText.inputValue()).includes('继续收音后的这句话'));
  await control.getByRole('button', { name: '暂停收音' }).click();
  await until(() => next.ended);
  assert(await control.getByRole('button', { name: '等待最后定稿' }).isDisabled());
  next.send({ sentences: [sentence(0,0,secondTail)], final: 1 });
  await resumeButton.waitFor();
  await until(async () => (await liveText.inputValue()).includes(secondTail));
  const transcriptAfterPause = await (await app.call('transcript')).text();
  assert.equal(transcriptAfterPause.split(firstTail).length, 2);
  assert.equal(transcriptAfterPause.split(secondTail).length, 2);
  assert(transcriptAfterPause.indexOf(firstTail) < transcriptAfterPause.indexOf(secondTail));
  assert.equal(app.store.segments().length, countAtPause + 1);
  assert.equal(app.store.screen().version, pausedVersion);
  console.log('暂停后返回的末句与续录的末句按序进入同一份逐字稿，等候期间按钮锁定，全程由工作人员点选上屏。');
  // Clear during a real browser microphone session, with an interim that will finalize after the click.
  cloud.setReadyDelay(0);
  const beforeClearSession = cloud.connections.length;
  await resumeButton.click();
  await control.getByRole('button', { name: '暂停收音' }).waitFor();
  await until(() => cloud.connections.length > beforeClearSession);
  const clearingCapture = cloud.connections.at(-1);
  const interim = '这段发言在清空之前已经开始';
  clearingCapture.send({ sentences: [sentence(0, 0, interim, 0)] });
  await until(async () => (await liveText.inputValue()).includes(interim));
  const beforeClearText = await liveText.inputValue();
  const beforeClearExport = await (await app.call('transcript')).text();
  const beforeClearScreen = app.store.screen();
  const beforeClearCard = await control.locator('.candidate-text').first().textContent();
  const dialog = control.getByRole('dialog', { name: '清空实时逐字稿？' });
  const secondDesk = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await secondDesk.goto(app.url + '/control');
  const secondLiveText = secondDesk.getByRole('textbox', { name: '实时逐字稿' });
  await until(async () => (await secondLiveText.inputValue()) === beforeClearText);
  await clearLive.press('Enter');
  assert(await dialog.getByRole('button', { name: '取消' }).evaluate(b => b === document.activeElement));
  await control.keyboard.press('Escape');
  assert(await dialog.isHidden());
  assert.equal(await liveText.inputValue(), beforeClearText);
  await clearLive.click();
  await dialog.getByRole('button', { name: '取消' }).click();
  assert.equal(await secondLiveText.inputValue(), beforeClearText);
  await clearLive.click();
  await dialog.getByRole('button', { name: '确认清空' }).click();
  await until(async () => (await liveText.inputValue()) === '' && (await secondLiveText.inputValue()) === '');
  assert(await clearLive.isDisabled());
  assert.equal(await (await app.call('transcript')).text(), beforeClearExport);
  assert.equal(await control.locator('.candidate-text').first().textContent(), beforeClearCard);
  await secondDesk.reload();
  await secondDesk.locator('#workspace').waitFor();
  assert(await secondDesk.getByRole('button', { name: '清空实时逐字稿' }).isDisabled());
  const lateFinal = interim + '。';
  clearingCapture.send({ sentences: [sentence(0, 0, lateFinal)] });
  await until(async () => (await (await app.call('transcript')).text()).includes(lateFinal));
  assert.equal(await secondLiveText.inputValue(), '');
  const newWords = '清空后继续记录下一段发言';
  clearingCapture.send({ sentences: [sentence(1, 0, newWords, 0)] });
  await until(async () => (await liveText.inputValue()) === newWords);
  const newFinal = newWords + '。';
  clearingCapture.onEnd = () => clearingCapture.send({ sentences: [sentence(1, 0, newFinal)], final: 1 });
  await control.getByRole('button', { name: '暂停收音' }).click();
  await until(async () => (await liveText.inputValue()) === newFinal && (await secondLiveText.inputValue()) === newFinal);
  assert.deepEqual(app.store.screen(), beforeClearScreen);
  await secondDesk.close();
  console.log('实时逐字稿清空通过：取消、Esc、确认、多控台与刷新同步、迟到定稿、新发言、存档和投影。');
  assert.deepEqual(errors, []);
  console.log('通过：模拟麦克风 PCM、换人定稿、候选改写、草稿刷新与失败重试、逐字稿校订、上屏恢复、多屏逐次回执、实码解码、断线恢复、键盘与窄屏。');
} finally {
  if (browser) await browser.close();
  await app.cleanup();
  await cloud.stop();
}
