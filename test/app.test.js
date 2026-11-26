import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { asrUrl } from '../server/asr.js';
import { mockCloud, sentence, testApp, until, wire } from './support.js';

test('实时区清空保存在活动内，重试旧确认时保留新发言', async (t) => {
  let app = await testApp();
  t.after(() => app.cleanup());
  const route = 'transcript/clear-live';
  assert.equal((await app.request(route, { revision: 0 })).status, 401);
  assert.equal((await app.call(route, {})).status, 400);
  assert.equal((await app.call(route, { revision: 1 })).status, 409);
  const before = app.store.paste('上一段发言。');
  const first = await (await app.call(route, { revision: 0 })).json();
  assert.deepEqual(first, { revision: 1, through: before.sequence, draftIds: [] });
  const next = app.store.paste('下一段发言。');
  assert(next.sequence > first.through);
  assert.deepEqual(await (await app.call(route, { revision: 0 })).json(), first);
  const dir = app.dir;
  await app.cleanup(true);
  app = await testApp({ dir });
  const snapshot = await (await app.call('control')).json();
  assert.deepEqual(snapshot.liveTranscriptBoundary, first);
  assert.equal(snapshot.rows.length, 2);
  const second = await (await app.call(route, { revision: 1 })).json();
  assert.equal(second.through, next.sequence);
  assert.equal(second.revision, 2);
});

test('公开大屏仅接收已发布内容，登录和逐字稿受活动权限保护', async (t) => {
  const app = await testApp();
  t.after(() => app.cleanup());
  assert.equal((await app.request('transcript')).status, 401);
  assert.equal((await app.request('control')).status, 401);
  assert.equal((await app.request('publish', { kind: 'idle', op: 'unauth-id' })).status, 401);
  assert.equal(
    (await app.request('login', { local: true }, null, { Origin: 'https://example.org' })).status,
    403
  );
  assert.equal(
    (await app.request('login', { local: true }, null, { 'X-Forwarded-For': '127.0.0.1' })).status,
    401
  );
  assert.equal((await fetch(app.url + '/../other/api/stage')).status, 404);
  const screen = wire(app, 'stage');
  assert.equal((await screen.wait((m) => m.type === 'screen')).screen.kind, 'idle');
  const pasted = { text: '原话不能在舞台接口里泄露', op: 'paste-once' };
  await app.call('paste', pasted);
  await app.call('paste', pasted);
  assert.equal(app.store.segments().length, 1);
  assert.equal((await (await app.request('stage')).text()).includes('原话不能'), false);
  const op = 'manual-001';
  let r = await app.call('publish', { op, kind: 'quote', text: '公开的金句' });
  const first = (await r.json()).screen;
  assert.equal(first.version, 1);
  assert.equal(
    (await (await app.call('publish', { op, kind: 'quote', text: '公开的金句' })).json()).screen.version,
    1
  );
  await screen.wait((m) => m.screen?.version === 1);
  screen.send({ type: 'displayed', version: 1 });
  await until(async () => (await (await app.call('control')).json()).displayed === 1);
  assert.ok(screen.messages.every((m) => m.type === 'screen' && !('rows' in m)));
  screen.send({ type: 'hidden' });
  await until(async () => {
    const s = await (await app.call('control')).json();
    return s.online === 1 && s.displayed === 0;
  });
  screen.ws.close();
  await until(async () => (await (await app.call('control')).json()).online === 0);
  const next = wire(app, 'stage');
  assert.equal((await next.wait((m) => m.screen)).screen.text, '公开的金句');
});

test('已有上屏记录、候选和新金句输出无标点，逐字稿保留原文', async (t) => {
  const app = await testApp();
  t.after(() => app.cleanup());
  app.store.set('screen', { kind: 'quote', version: 8, text: '创意不是选择创意是一种故事的表达。' });
  app.store.set('screenHistory', [{ kind: 'quote', version: 7, text: '「先听，再说！」' }]);
  const body = '判断一次服务的价值，要听服务对象的反馈。';
  const row = app.store.paste(body);
  app.store.settle(row.id, row.rev, 'ready', body, null);
  const desk = await (await app.call('control')).json();
  assert.equal(desk.screen.text, '创意不是选择创意是一种故事的表达');
  assert.equal(desk.screen.version, 8);
  assert.equal((await (await app.request('stage')).json()).screen.text, desk.screen.text);
  assert.equal(desk.history[0].text, '先听再说');
  assert.equal(desk.rows[0].body, body);
  assert.equal(desk.rows[0].quote, '判断一次服务的价值要听服务对象的反馈');
  assert.ok((await (await app.call('transcript')).text()).includes(body));

  const publish = async (op, payload) => app.call('publish', { op, ...payload });
  const replay = await publish('replay-old-text', { kind: 'history', version: 7, currentVersion: 8 });
  assert.equal((await replay.json()).screen.text, '先听再说');
  const candidate = { kind: 'candidate', id: row.id, rev: row.rev };
  const direct = await publish('send-candidate', candidate);
  assert.equal((await direct.json()).screen.text, desk.rows[0].quote);
  const edited = await publish('edit-candidate', { ...candidate, text: '降幅 3.5%！\n负责人说：“属实。”' });
  assert.equal((await edited.json()).screen.text, '降幅 百分之3点5\n负责人说属实');
  const before = app.store.screen();
  assert.equal((await publish('empty-manual', { kind: 'quote', text: '！？…——' })).status, 400);
  assert.equal((await publish('empty-edit', { ...candidate, text: '「」' })).status, 400);
  assert.deepEqual(app.store.screen(), before);
});

test('二维码 PNG 和 JPG 可替换、恢复，损坏图片保留上一版，重启后可读', async (t) => {
  const app = await testApp();
  let current = app;
  t.after(() => current.cleanup());
  const upload = async (file, op) =>
    fetch(app.url + '/api/qr', {
      method: 'POST',
      headers: { Cookie: app.cookie, 'X-Operation-Id': op },
      body: file,
    });
  const first = await (
    await upload(await readFile(new URL('./fixtures/qr-a.png', import.meta.url)), 'upload-aaa')
  ).json();
  assert.equal(first.screen.kind, 'qr');
  const img = await fetch(app.url + '/qr/' + first.screen.image + '.png');
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await upload(Buffer.from('损坏图片'), 'upload-bad')).status, 400);
  assert.equal((await (await app.call('stage')).json()).screen.version, 1);
  await app.call('publish', { op: 'manual-after-qr', kind: 'quote', text: '继续辩论' });
  const again = await (await app.call('publish', { op: 'reshow-qr', kind: 'qr' })).json();
  assert.equal(again.screen.image, first.screen.image);
  const second = await (
    await upload(await readFile(new URL('./fixtures/qr-b.jpg', import.meta.url)), 'upload-bbb')
  ).json();
  assert.notEqual(second.screen.image, first.screen.image);
  await current.cleanup(true);
  current = await testApp({ dir: app.dir });
  assert.deepEqual((await (await current.call('stage')).json()).screen, second.screen);
  assert.equal((await fetch(current.url + '/qr/' + second.screen.image + '.png')).status, 200);
});

test('删除及撤销二维码跨控台同步，支持旧数据、重启、操作重试和并发替换', async (t) => {
  let app = await testApp();
  t.after(() => app.cleanup());
  const file = await readFile(new URL('./fixtures/qr-a.png', import.meta.url));
  const upload = (op) => fetch(app.url + '/api/qr', {
    method: 'POST', headers: { Cookie: app.cookie, 'X-Operation-Id': op }, body: file,
  });
  const qr = (action, op, qrRevision) => app.call('qr/' + action, { op, qrRevision });
  const initial = await (await upload('qr-to-remove')).json();
  // A pre-upgrade event has a saved image and no QR revision.
  app.store.db.prepare('DELETE FROM meta WHERE key=?').run('qrRevision');
  const other = wire(app, 'control', true);
  const stage = wire(app, 'stage');
  await other.wait((m) => m.type === 'snapshot' && m.qrRevision === 0);
  await stage.wait((m) => m.screen?.image === initial.lastQr);
  assert.equal((await app.request('qr/remove', { op: 'unauthorized-remove', qrRevision: 0 })).status, 401);
  assert.equal((await app.request('qr/restore', { op: 'unauthorized-restore', qrRevision: 0 })).status, 401);
  const removed = await (await qr('remove', 'remove-active-qr', 0)).json();
  assert.equal(removed.lastQr, null);
  assert.equal(removed.screen.kind, 'idle');
  assert.equal(removed.screen.version, initial.screen.version + 1);
  await other.wait((m) => m.canRestoreQr && m.lastQr === null);
  await stage.wait((m) => m.screen?.kind === 'idle' && !('canRestoreQr' in m));
  const imageUrl = () => app.url + '/qr/' + initial.lastQr + '.png';
  assert.equal((await fetch(imageUrl())).status, 404);
  assert.deepEqual(await (await qr('remove', 'remove-active-qr', 0)).json(), removed);
  assert.equal((await qr('remove', 'remove-empty-qr', removed.qrRevision)).status, 409);
  await app.cleanup(true);
  app = await testApp({ dir: app.dir });
  assert.equal((await (await app.call('control')).json()).canRestoreQr, true);
  const { screen: quote } = await (await app.call('publish', { op: 'after-remove', kind: 'quote', text: '下一位发言' })).json();
  const restored = await (await qr('restore', 'restore-during-quote', removed.qrRevision)).json();
  assert.equal(restored.lastQr, initial.lastQr);
  assert.deepEqual(restored.screen, quote);
  assert.equal((await fetch(imageUrl())).status, 200);
  const removedOffScreen = await (await qr('remove', 'remove-while-quote', restored.qrRevision)).json();
  assert.deepEqual(removedOffScreen.screen, quote);
  const latest = await (await upload('reupload-same-qr')).json();
  assert.equal(latest.canRestoreQr, false);
  assert.equal((await qr('restore', 'stale-restore', removedOffScreen.qrRevision)).status, 409);
  assert.equal((await qr('remove', 'stale-remove', restored.qrRevision)).status, 409);
  assert.deepEqual(await (await qr('remove', 'remove-active-qr', 0)).json(), latest);
  assert.equal((await fetch(imageUrl())).status, 200);
});

test('V2 签名按原文排序后做 HMAC-SHA1，连接使用专用引擎', () => {
  const keys = { appId: '12345', secretId: 'example', secretKey: 'secret' };
  const url = new URL(asrUrl(keys, 'unique-1', 'context+/=', 1700000000, 145));
  const signature = url.searchParams.get('signature');
  url.searchParams.delete('signature');
  const canonical =
    url.host + url.pathname + '?' + Array.from(url.searchParams, ([k, v]) => k + '=' + v).join('&');
  assert.equal(signature, createHmac('sha1', keys.secretKey).update(canonical).digest('base64'));
  assert.deepEqual([...url.searchParams.keys()], [...url.searchParams.keys()].sort());
  assert.equal(url.searchParams.get('engine_model_type'), '16k_zh_en_speaker_2.0');
  assert.equal(url.searchParams.get('result_mod'), '1');
  assert.equal(url.searchParams.get('speaker_context_id'), 'context+/=');
  assert.equal(url.pathname, '/asr/v2/12345');
});

test('模拟收音覆盖临时稿、插话、旧模型结果、声纹续接和停止前最后一段', async (t) => {
  const cloud = await mockCloud();
  let finishOld;
  const old = new Promise((resolve) => {
    finishOld = resolve;
  });
  const app = await testApp({
    dialAsr: cloud.dial,
    generate: async (s) => {
      if (s.body === '尚待修订') return old;
      if (s.body === '所以我们想……') return null;
      return s.body;
    },
  });
  t.after(async () => {
    finishOld('旧稿');
    await app.cleanup();
    await cloud.stop();
  });
  const mic = wire(app, 'mic', true);
  await mic.wait((m) => m.type === 'ready');
  const cloud1 = cloud.connections[0];
  mic.ws.send(Buffer.alloc(1280, 3));
  await until(() => cloud1.packets.length === 1);
  const competing = wire(app, 'mic', true);
  assert.match((await competing.wait((m) => m.type === 'error')).message, /已有控台/);
  const a = sentence(0, 0, '尚待修订'),
    b = sentence(1, 1, '另一位辩手的独立观点'),
    c = sentence(2, -1, '所以我们想……');
  const push = (...list) => cloud1.send({ sentences: { sentence_list: list } });
  push({ ...a, sentence_type: 0 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(app.store.segments().length, 0);
  push(a, b, c);
  await until(() => app.store.segments().some((s) => s.status === 'skip'));
  assert.equal(app.store.screen().kind, 'idle');
  const revised = { ...a, sentence: '修订后完整观点' };
  push(revised, b, c);
  push(revised, b, c);
  finishOld('这条旧稿不可显示');
  await until(() => app.store.segments()[0]?.status === 'ready');
  let all = app.store.segments();
  assert.deepEqual(
    all.map((r) => r.quote),
    ['修订后完整观点', '另一位辩手的独立观点', null]
  );
  assert.deepEqual(
    all.map((r) => r.speaker),
    ['1:0', '1:1', null]
  );
  assert.equal(all[0].rev, 2);
  assert.equal(
    (await app.call('publish', { kind: 'candidate', op: 'old-candidate', id: all[0].id, rev: 1 })).status,
    409
  );
  await app.call('assign', { speaker: '1:0', role: '正方' });
  await app.call('assign', { speaker: '1:1', role: '反方' });
  await app.call('override', { id: all[1].id, role: '待确认' });
  assert.match(await (await app.call('transcript')).text(), /发言人 1｜正方　修订后完整观点/);
  assert.match(await (await app.call('transcript')).text(), /发言人 2｜待确认/);
  cloud1.onEnd = () => {
    push(revised, b, c, sentence(3, 1, '收音结束前的最后一句'));
    cloud1.send({ final: 1 });
  };
  mic.send({ type: 'end' });
  await mic.wait((m) => m.type === 'ended');
  assert.equal(app.store.segments().length, 4);
  const mic2 = wire(app, 'mic', true);
  await mic2.wait((m) => m.type === 'ready');
  assert.equal(cloud.signed[1].searchParams.get('speaker_context_id'), 'fixture-context');
  assert.notEqual(cloud.signed[1].searchParams.get('voice_id'), cloud.signed[0].searchParams.get('voice_id'));
  cloud.connections[1].send({ code: 4005 });
  assert.match((await mic2.wait((m) => m.type === 'error')).message, /充值/);
  const before = app.store.screen().version;
  await app.call('publish', { op: 'manual-cloud-stop', kind: 'quote', text: '收音中断后继续上屏' });
  assert.equal(app.store.screen().version, before + 1);
});

test('模型失败保留原稿并可重试，较早发言的迟到候选按原时间归位', async (t) => {
  let failing = true,
    release;
  const wait = new Promise((res) => {
    release = res;
  });
  const app = await testApp({
    generate: async (item) => {
      if (item.body === '第一段') {
        if (failing) throw new Error('模拟网关不可用');
        await wait;
      }
      return item.body + '的候选';
    },
  });
  t.after(async () => {
    release();
    await app.cleanup();
  });
  await app.call('paste', { text: '第一段' });
  await until(() => app.store.segments()[0]?.status === 'error');
  failing = false;
  await app.call('retry', {});
  await app.call('paste', { text: '第二段' });
  await until(() => app.store.segments()[1]?.status === 'ready');
  release();
  await until(() => app.store.segments()[0]?.status === 'ready');
  const all = app.store.segments();
  assert.deepEqual(
    all.map((r) => r.quote),
    ['第一段的候选', '第二段的候选']
  );
  assert.equal(
    (
      await (
        await app.call('publish', { op: 'publish-first', kind: 'candidate', id: all[0].id, rev: all[0].rev })
      ).json()
    ).screen.text,
    '第一段的候选'
  );
});

test('近期画面按活动共享；旧版二维码可重发，过期恢复不会覆盖新画面', async (t) => {
  let app = await testApp();
  t.after(() => app.cleanup());
  const upload = async (name, op) => {
    const file = await readFile(new URL('./fixtures/' + name, import.meta.url));
    return (await fetch(app.url + '/api/qr', { method: 'POST', headers: { Cookie: app.cookie, 'X-Operation-Id': op }, body: file })).json();
  };
  const a = await upload('qr-a.png', 'history-qr-a');
  const b = await upload('qr-b.jpg', 'history-qr-b');
  assert.equal(b.history[0].image, a.lastQr);
  assert.equal((await (await app.call('qr/target?image=' + b.lastQr)).json()).target, 'https://example.org/debate/b');
  await app.cleanup(true);
  app = await testApp({ dir: app.dir });
  const replay = { op: 'restore-qr-a', kind: 'history', version: a.screen.version, currentVersion: b.screen.version };
  const restored = await (await app.call('publish', replay)).json();
  assert.equal(restored.screen.image, a.lastQr);
  assert.equal(restored.lastQr, b.lastQr);
  assert.equal((await (await app.call('publish', replay)).json()).screen.version, restored.screen.version);
  assert.equal((await app.call('publish', { ...replay, op: 'stale-replay' })).status, 409);
  await app.call('qr/remove', { op: 'remove-newer-qr', qrRevision: restored.qrRevision });
  assert.equal(app.store.screen().image, a.lastQr);
  assert.ok(!app.store.history().some((s) => s.image === b.lastQr));
  assert.ok(!('history' in await (await app.request('stage')).json()));
});

test('校订更新候选并停用旧发送，排除只影响导出，原始识别仍可核对', async (t) => {
  let app = await testApp();
  t.after(() => app.cleanup());
  const { id } = await (await app.call('paste', { text: '识别原文', op: 'paste-edits' })).json();
  await until(() => app.store.segment(id).status === 'ready');
  const row = app.store.segment(id);
  const edit = { id, rev: row.rev, editVersion: 0, text: '校订后的发言', excluded: false };
  assert.equal((await app.request('transcript/edit', edit)).status, 401);
  assert.equal((await app.call('transcript/edit', edit)).status, 200);
  assert.equal((await app.call('transcript/edit', edit)).status, 200);
  assert.equal((await app.call('transcript/edit', { ...edit, text: '过期校订' })).status, 409);
  const updated = app.store.segment(id);
  await until(()=>app.store.segment(id).status==='ready');
  assert.equal(app.store.segment(id).quote, '校订后的发言');
  assert.equal((await app.call('publish',{kind:'candidate',op:'pre-proof-edit',id,rev:row.rev})).status,409);
  assert.equal(updated.body, '识别原文');
  assert.match(await (await app.call('transcript')).text(), /校订后的发言/);
  await app.call('transcript/edit', { ...edit, rev:updated.rev, editVersion: updated.editVersion, excluded: true });
  await app.cleanup(true);
  app = await testApp({ dir: app.dir });
  assert.doesNotMatch(await (await app.call('transcript')).text(), /校订后的发言/);
  await app.call('transcript/edit', { ...edit, rev:app.store.segment(id).rev, editVersion: app.store.segment(id).editVersion, text: row.body });
  assert.match(await (await app.call('transcript')).text(), /识别原文/);
  await until(()=>app.store.segment(id).status==='ready');
  const send = { op: 'send-edit-once', kind: 'candidate', id, rev: app.store.segment(id).rev, text: '人工改写的金句' };
  assert.equal((await (await app.call('publish', send)).json()).screen.text, send.text);
  assert.equal((await (await app.request('stage')).json()).screen.candidate, undefined);
  assert.equal((await app.call('publish', { ...send, op: 'send-stale-row', rev: row.rev + 1 })).status, 409);
});
