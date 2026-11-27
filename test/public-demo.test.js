import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoAllowance } from '../server/public-demo.js';
import { extractQuoteBatch } from '../server/quotes.js';
import { mockCloud, sentence, testApp, wire } from './support.js';

test('公开体验自动进入，公开和口令活动的数据库、会话独立', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-guest-'));
  const start = (publicDemo, id = 'public-demo') => testApp({
    dir, config: { id, dir, localControl: true, publicDemo },
  });
  let app = await start(false);
  t.after(() => app.cleanup());
  app.store.paste('原口令活动里的记录。');
  assert.equal((await app.request('login', { guest: true })).status, 401);
  await app.cleanup(true);
  app = await start(true);
  const login = await app.request('login', { guest: true }, null, { 'X-Forwarded-Proto': 'https' });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Secure/);
  const guest = setCookie.split(';')[0];
  assert.notEqual(guest, app.cookie);
  const snapshot = await (await app.request('control', undefined, guest)).json();
  assert.equal(snapshot.publicDemo, true);
  assert.deepEqual(snapshot.rows, []);
  assert.equal((await app.request('control')).status, 401);
  await app.request('publish', { kind: 'quote', op: 'guest-screen-test', text: '让好问题被听见' }, guest);
  assert.equal((await (await app.request('stage')).json()).screen.text, '让好问题被听见');
  await app.cleanup(true);
  app = await start(false);
  assert.equal((await app.request('control', undefined, guest)).status, 401);
  assert.equal(app.store.segments()[0].body, '原口令活动里的记录。');
  await app.cleanup(true);
  app = await start(true, 'conference');
  assert.equal((await app.request('login', { guest: true })).status, 401);
});

test('整场访客共用持久的云调用额度，到限后手写仍能上屏', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-usage-'));
  const cloud = await mockCloud();
  const app = await testApp({ dir, config: { id: 'public-demo', dir, localControl: true, publicDemo: true }, dialAsr: cloud.dial });
  t.after(async () => { await app.cleanup(); await cloud.stop(); });
  const quota = demoAllowance(app.store);
  quota.modelRequest();
  const usage = app.store.get('publicDemoUsage');
  // An event that used up the former allowance can still record the three-hour conference.
  app.store.set('publicDemoUsage', { ...usage, audioSeconds: 30 * 60, modelRequests: 300 });
  const chargeRecording = quota.startAudio();
  chargeRecording(3 * 60 * 60 * 1000);
  quota.modelRequest();
  assert.deepEqual(app.store.get('publicDemoUsage'), {
    day: usage.day, audioSeconds: (30 + 180) * 60, modelRequests: 301,
  });
  app.store.set('publicDemoUsage', { ...usage, audioSeconds: 4 * 60 * 60 - 1, modelRequests: 3_600 - 1 });
  quota.modelRequest();
  await assert.rejects(extractQuoteBatch('test', [{ id: 'sample', body: '分数只描述一张试卷，无法描述一个人。' }], [], quota.modelRequest), { status: 429 });
  const mic = wire(app, 'mic', true);
  await mic.wait(m => m.type === 'ready');
  const conn = cloud.connections[0];
  conn.onEnd = () => conn.send({ sentences: [sentence(1, 1, '保留最后一句。')], final: 1 });
  for (let i = 0; i < 3; i++) mic.ws.send(Buffer.alloc(12800));
  await mic.wait(m => m.type === 'ended');
  assert(conn.packets.length <= 2);
  assert.equal(app.store.segments()[0].body, '保留最后一句。');
  assert.match(app.store.get('lastCapture').message, /额度已用完/);
  const next = wire(app, 'mic', true);
  assert.match((await next.wait(m => m.type === 'error')).message, /额度已用完/);
  assert.equal(cloud.connections.length, 1);
  assert.equal((await app.call('publish', { kind: 'quote', op: 'over-quota-manual', text: '仍可发送' })).status, 200);
  app.store.set('publicDemoUsage', { ...app.store.get('publicDemoUsage'), day: '2000-01-01' });
  quota.modelRequest();
  assert.deepEqual(app.store.get('publicDemoUsage'), { day: usage.day, audioSeconds: 0, modelRequests: 1 });
});
