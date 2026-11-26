import test from 'node:test';
import { extractQuote, parseDecision } from '../server/quotes.js';
import { completeThought, correctionTargets, isCorrection, unfinished } from '../server/speech-cues.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { mockCloud, sentence, testApp, until, wire } from './support.js';

test('完整定稿和已收束的数量事实走快线，条件前半句等待下文', async t => {
  const base = { mode: 'speech', speaker: '1:0' };
  assert(completeThought({ ...base, body: '选择要由自己决定，这是第一点。' }));
  assert(completeThought({ ...base, mode: 'debate', body: '我想问对方一个问题，这样还有意义吗？' }));
  assert(completeThought({ ...base, body: '只有一百户参加了复查，这是第一点。' }));
  assert(!completeThought({ ...base, body: '如果只统计到场人数。' }));
  assert(unfinished('我的观点取决于。'));
  assert(!unfinished('只有这十户完成了复查。'));
  assert(unfinished('只有在数据足够时。'));
  assert(!isCorrection('对方刚才说错了，签到只能证明到场。'));
  const question = { id: 'q', mode: 'debate', body: '这两种做法结果会一样吗？' };
  assert.deepEqual(await extractQuote(null, { id: 'a', mode: 'debate', body: '当然是不一样的。' }, [question]), { status: 'skip' });
  assert.deepEqual(correctionTargets({body:'我更正一下，刚才说成了一百户。是十户。',startMs:12000}, [
    {id:'unrelated',body:'三百户参加了初筛。',endMs:10000},
    {id:'correct',body:'100户完成了复查。',endMs:5000},
  ]), ['correct']);
  assert.deepEqual(correctionTargets({ body: '刚才说错了，说成了十户。是三户。', startMs: 9000 }, [
    { id: 'different-number', body: '一百一十户完成复查。', endMs: 6000 },
  ]), []);
  assert.deepEqual(correctionTargets({ body: '我们约在周三，我说错了，是周二。', startMs: 9000 }, [
    { id: 'different-topic', body: '安全工作必须有人负责。', endMs: 6000 },
  ]), []);
  const cloud = await mockCloud();
  const app = await testApp({dialAsr:cloud.dial, quoteTiming:{quietMs:1500, maxWaitMs:2500, fastMs:25}});
  t.after(async () => { await app.cleanup(); await cloud.stop(); });
  const mic = wire(app,'mic&mode=speech',true);
  await mic.wait(m=>m.type==='ready');
  const c = cloud.connections[0];
  c.send({sentences:[sentence(1,0,'选择要由自己决定，这是第一点。')]});
  await until(()=>app.store.segments()[0]?.status==='ready',650);
  c.send({sentences:[sentence(2,0,'如果只统计到场人数。')]});
  await until(()=>app.store.segments().length===2);
  assert.equal(app.store.segments()[1].status,'collecting');
  c.send({final:1});
  await until(()=>app.store.segments()[1].status==='waiting');
  assert.equal(app.store.screen().version,0);
});

test('改口先暂缓再撤回，摘编、改写与历史均拒绝；证据有修订时可恢复', async t => {
  const cloud = await mockCloud();
  const app = await testApp({
    dialAsr:cloud.dial,
    generate: async row => row.body.startsWith('走访了一千户') ? {
      status:'ready', quote:'走访的一千户中，一百户完成复查。', sources:[row.id], quoteEvidence:row.body,
    } : row.body,
  });
  t.after(async () => { await app.cleanup(); await cloud.stop(); });
  const mic = wire(app,'mic&mode=debate',true);
  await mic.wait(m=>m.type==='ready');
  const c = cloud.connections[0];
  const wrong = sentence(1,0,'走访了一千户，一百户完成了复查。');
  const other = sentence(2,1,'我们有一百户在等回访。');
  const aside = sentence(3,0,'我们的回访流程已经简化。');
  c.send({sentences:[wrong,other,aside]});
  await until(()=>app.store.segments().length===3 && !app.store.pending().length);
  const [old,opponent,unrelated] = app.store.segments();
  const ref = {kind:'candidate',id:old.id,rev:old.rev};
  assert.equal((await app.call('publish',{...ref,op:'initial-candidate'})).status,200);
  assert.equal(old.quoteEvidence, wrong.sentence);
  assert.equal(app.store.screen().adapted, true);
  const publicState = await (await app.request('stage')).json();
  assert.equal(old.quote, '走访的一千户中，一百户完成复查。');
  assert.equal(publicState.screen.text, '走访的一千户中一百户完成复查');
  assert(!JSON.stringify(publicState).includes(old.body));
  await app.call('publish',{kind:'quote',text:'切换到另一句。',op:'other-content'});
  const before = app.store.screen().version;
  const later = sentence(4,0,'刚才我口误，说成了一百户。是十户，只有这十户完成了复查。');
  c.send({sentences:[{...later,sentence_type:0}]});
  await until(()=>app.store.segment(old.id).status==='checking');
  assert.equal((await app.call('publish',{...ref,op:'blocked-partial'})).status,409);
  c.send({sentences:[{...later,sentence_type:0,sentence:'我们继续讨论复查。'}]});
  await until(()=>app.store.segment(old.id).status==='ready');
  c.send({sentences:[later]});
  await until(()=>app.store.segment(old.id).status==='withdrawn');
  assert.equal((await app.call('publish',{...ref,op:'blocked-original'})).status,409);
  assert.equal((await app.call('publish',{...ref,op:'blocked-edit',text:'改写过的旧数字。'})).status,409);
  assert.equal((await app.call('publish',{kind:'history',op:'blocked-history',version:1,currentVersion:before})).status,409);
  assert.equal(app.store.segment(opponent.id).status,'ready');
  assert.equal(app.store.segment(unrelated.id).status,'ready');
  assert.equal(app.store.screen().version,before);
  assert.match(app.store.transcript('彩排'),/一百户/);
  c.send({sentences:[{...later,sentence:'我们继续讨论流程。'}]});
  await until(()=>app.store.segment(old.id).status==='ready');
});

test('演讲临时稿尚无发言人编号时暂缓旧卡，定稿归属改变时放开旧卡', async (t) => {
  const cloud = await mockCloud();
  const app = await testApp({ dialAsr: cloud.dial });
  t.after(async () => { await app.cleanup(); await cloud.stop(); });
  const mic = wire(app,'mic&mode=speech',true);
  await mic.wait(m => m.type === 'ready');
  const source = cloud.connections[0];
  source.send({ sentences: [sentence(1, 0, '一百户完成了复查。')] });
  const original = await until(() => app.store.segments().find(s => s.status === 'ready'));
  const correction = sentence(2, -1, '刚才我口误', 0);
  const ctrl = wire(app, 'control', true);
  source.send({ sentences: [correction] });
  await until(() => app.store.segment(original.id).status === 'checking');
  const revised = { ...correction, sentence: '刚才我口误说成' };
  source.send({ sentences: [revised] });
  await ctrl.wait(m => m.audio?.partial === revised.sentence);
  assert.equal(app.store.segment(original.id).status, 'checking');
  source.send({ sentences: [{ ...correction, sentence_type: 1, speaker_id: 1, sentence: '刚才我口误，说成了一百户。是十户。' }] });
  await until(() => app.store.segment(original.id).status === 'ready');
  ctrl.ws.close();
});

test('更正到达时还在生成的跨段候选，返回后及重启后均不可发送', async (t) => {
  const firstApp = await testApp();
  const make = (id, startMs, body) => firstApp.store.upsert({
    id, startMs, endMs: startMs + 700, stream: 'test-turn', speaker: '1:0', mode: 'speech', body,
  });
  const old = make('old', 1000, '一百户参加复查。');
  const later = make('joined', 2000, '我们据此调整了下一次回访。');
  const repair = make('correction', 4000, '我刚才口误，说成了一百户。是十户，只有十户参加复查。');
  firstApp.store.settle(repair.id, repair.rev, 'skip', null, null);
  firstApp.store.settle(old.id, old.rev, 'waiting', null, null);
  firstApp.store.settle(later.id, later.rev, 'ready', old.body + later.body, null, [old.id, later.id]);
  const ref = { kind: 'candidate', id: later.id, rev: later.rev, op: 'old-late-result' };
  assert.equal(firstApp.store.segment(later.id).status, 'withdrawn');
  assert.equal((await firstApp.call('publish', ref)).status, 409);
  await firstApp.cleanup(true);
  const restarted = await testApp({ dir: firstApp.dir });
  t.after(() => restarted.cleanup());
  assert.equal(restarted.store.segment(later.id).status, 'withdrawn');
  assert.equal((await restarted.call('publish', ref)).status, 409);
  assert.equal(restarted.store.screen().version, 0);
});

test('增量回调保留多个临时稿、接收字符串编号、显示新增尾词，断线临时稿单独留存', async (t) => {
  const cloud = await mockCloud(),
    app = await testApp({ dialAsr: cloud.dial });
  t.after(async () => {
    await app.cleanup();
    await cloud.stop();
  });
  const control = wire(app, 'control', true),
    mic = wire(app, 'mic', true);
  await mic.wait((m) => m.type === 'ready');
  const c = cloud.connections[0],
    a = { ...sentence(1, 0, '这个项目原本是要做的', 0), sentence_id: '1', speaker_id: '0' };
  const b = sentence(2, 1, '我想补充一句', 0);
  c.send({ sentences: [a, b] });
  await control.wait((m) => m.audio?.partials?.length === 2);
  c.send({
    result: { speaker_sentences: [{ ...a, sentence_type: '1', sentence: '这个项目原本是要做的访谈。' }] },
  });
  await control.wait((m) => m.audio?.partial === b.sentence);
  const first = app.store.segments()[0];
  assert.match(first.review, /访谈/);
  assert.equal(first.speaker, '1:0');
  c.ws.terminate();
  await mic.wait((m) => m.type === 'error');
  const last = app.store.segments().at(-1);
  assert.equal(last.status, 'unconfirmed');
  assert.equal(last.quote, null);
  assert.match(app.store.transcript('彩排'), /临时稿待核对/);
  assert.equal(app.store.screen().version, 0);
});

test('同人邻句合并后收起旧候选；发言修订重新计算，并拒绝旧版本发送', async (t) => {
  const cloud = await mockCloud(),
    app = await testApp({
      dialAsr: cloud.dial,
      generate: async (r, ctx) => {
        const used = [...ctx, r];
        return { status: 'ready', quote: used.map((s) => s.body).join(''), sources: used.map((s) => s.id) };
      },
    });
  t.after(async () => {
    await app.cleanup();
    await cloud.stop();
  });
  const mic = wire(app, 'mic', true);
  await mic.wait((m) => m.type === 'ready');
  const c = cloud.connections[0],
    a = sentence(1, 0, '每周回访。'),
    b = sentence(2, 0, '问题发现得早。');
  c.send({ sentences: [a, b] });
  await until(() => app.store.segments().at(-1)?.status === 'ready' && app.store.segments().length === 2);
  let [first, second] = app.store.segments();
  assert.equal(first.status, 'merged');
  assert.equal(second.quote, a.sentence + b.sentence);
  assert.equal(
    (await app.call('publish', { kind: 'candidate', op: 'merged-old', id: first.id, rev: first.rev })).status,
    409
  );
  c.send({ sentences: [{ ...a, speaker_id: 1, sentence: '对方说每周回访。' }] });
  await until(
    () => app.store.segment(first.id).status === 'ready' && app.store.segment(second.id).quote === b.sentence
  );
  assert.equal(app.store.segment(first.id).status, 'ready');
  assert.equal(
    (await app.call('publish', { kind: 'candidate', op: 'revised-old', id: second.id, rev: second.rev }))
      .status,
    409
  );
  c.onEnd = () => c.send({ final: 1 });
  mic.send({ type: 'end' });
  await mic.wait((m) => m.type === 'ended');
});

test('收音网关仅向腾讯建连，旧控台请求其他识别服务会收到明确错误', async t => {
  let calls = 0;
  const app = await testApp({ dialAsr: () => { calls++; throw new Error('未预期的外部连接'); } });
  t.after(() => app.cleanup());
  const mic = wire(app, 'mic&provider=qwen', true);
  assert.match((await mic.wait(m => m.type === 'error')).message, /仅使用腾讯/);
  assert.equal(calls, 0);
  assert.deepEqual((await (await app.call('services')).json()).providers, { tencent: true });
});

test('自由辩匿名和中间插话都打断前文；单人演讲的匿名连续片段可接续', async (t) => {
  const app = await testApp();
  t.after(() => app.cleanup());
  const put = (n, mode, speaker, stream = 'run') =>
    app.store.upsert({
      id: stream + '/' + n,
      mode,
      speaker,
      stream,
      body: '片段' + n,
      startMs: n * 1000,
      endMs: n * 1000 + 600,
    });
  put(1, 'debate', '1:0');
  put(2, 'debate', '1:1');
  const a = put(3, 'debate', '1:0');
  assert.equal(app.store.neighbors(a).length, 0);
  put(4, 'debate', null);
  assert.equal(app.store.neighbors(put(5, 'debate', null)).length, 0);
  put(6, 'speech', null);
  assert.equal(app.store.neighbors(put(7, 'speech', null)).length, 1);
  assert.equal(app.store.neighbors(put(8, 'speech', null, 'next')).length, 0);
});

test('44.1/48 kHz 工作线程以 40 ms 分包，停录保留不满一帧的样本', async () => {
  const script = await readFile(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8');
  for (const rate of [44100, 48000]) {
    let Processor;
    runInNewContext(script, {
      AudioWorkletProcessor: class {
        constructor() {
          this.port = {};
        }
      },
      sampleRate: rate,
      registerProcessor: (name, C) => {
        Processor = C;
      },
    });
    const node = new Processor(),
      packets = [];
    node.port.postMessage = (value) => packets.push(value);
    const samples = Math.floor(rate * 0.1627);
    for (let offset = 0; offset < samples; offset += 128)
      node.process([[new Float32Array(Math.min(128, samples - offset)).fill(0.5)]]);
    node.port.onmessage({ data: 'flush' });
    assert.equal(packets.pop(), 'flushed');
    assert(packets.slice(0, -1).every((p) => p.byteLength === 1280));
    assert.equal(
      packets.reduce((a, p) => a + p.byteLength / 2, 0),
      Math.ceil((samples * 16000) / rate)
    );
    assert.equal(new Int16Array(packets.at(-1)).at(-1), 16384);
  }
});

test('模型摘录须保持否定、数字、相邻条件和口误后的事实', () => {
  const decide = (text, rows) =>
    parseDecision(JSON.stringify({ status: 'ready', spans: [[rows.length, text]] }), rows);
  assert.throws(() => decide('证明服务有效。', [{ id: 'a', body: '签到不能证明服务有效。' }]));
  assert.throws(() => decide('有15户。', [{ id: 'a', body: '有115户。' }]));
  assert.throws(() => decide('15户。', [{ id: 'a', body: '有115户。' }]));
  const context = [
    { id: 'a', body: '如果只看人数，', status: 'waiting' },
    { id: 'b', body: '就会忽略效果。' },
  ];
  assert.equal(decide('就会忽略效果。', context).quote, '如果只看人数，就会忽略效果。');
  const correction = [{ id: 'c', body: '刚才我口误，说成了一百户。是十户，只有这十户完成了复查。' }];
  assert.throws(() => decide('一百户。', correction));
  assert.equal(decide('只有这十户完成了复查。', correction).quote, '只有这十户完成了复查。');
  const correctedNumber = [{ id: 'd', body: '不是一百户，是十户，只有十户完成复查。' }];
  assert.throws(() => decide('一百户。', correctedNumber));
  assert.equal(decide('只有十户完成复查。', correctedNumber).quote, '只有十户完成复查。');
});

test('同一人的定稿等候接续，一次判定多段；临时内容不入模，停录收尾立即提交', async (t) => {
  const cloud = await mockCloud(),
    calls = [];
  const app = await testApp({
    dialAsr: cloud.dial,
    quoteTiming: { quietMs: 320, maxWaitMs: 2000 },
    generate: async (r) => {
      calls.push([r.body]);
      return r.body;
    },
    generateBatch: async (rows) => {
      calls.push(rows.map((r) => r.body));
      return [
        { status: 'waiting' },
        { status: 'ready', quote: rows[0].body + rows[1].body, sources: [rows[0].id, rows[1].id] },
      ];
    },
  });
  t.after(async () => {
    await app.cleanup();
    await cloud.stop();
  });
  const mic = wire(app, 'mic&mode=speech', true);
  await mic.wait((m) => m.type === 'ready');
  const c = cloud.connections[0];
  const a = sentence(0, 0, '如果只看报名数，'),
    b = sentence(1, 0, '就会忽略效果。'),
    d = sentence(2, 0, '先问需求，再定目标。');
  c.send({ sentences: [a, b] });
  await until(() => app.store.segments().length === 2);
  assert(app.store.segments().every((r) => r.status === 'collecting'));
  await sleep(170);
  c.send({ sentences: [{ ...d, sentence_type: 0, sentence: '还在修改的临时词' }] });
  await sleep(185);
  assert.deepEqual(calls, [[a.sentence, b.sentence]], '完整条件和结论先送出，下一句的临时稿不可混入');
  c.onEnd = () => {
    c.send({ sentences: [d] });
    c.send({ final: 1 });
  };
  mic.send({ type: 'end' });
  await mic.wait((m) => m.type === 'ended');
  await until(() => !app.store.pending().length);
  assert.deepEqual(calls, [[a.sentence, b.sentence], [d.sentence]]);
  assert.deepEqual(
    app.store.segments().map((r) => r.status),
    ['waiting', 'ready', 'ready']
  );
  assert.equal(app.store.screen().version, 0);
});

test('持续有临时文字时仍有最长等待，换人后不拼接两个辩手', async (t) => {
  const cloud = await mockCloud(),
    calls = [];
  const app = await testApp({
    dialAsr: cloud.dial,
    quoteTiming: { quietMs: 210, maxWaitMs: 430 },
    generate: async (r) => {
      calls.push([r.body]);
      return r.body;
    },
    generateBatch: async (rows) => {
      calls.push(rows.map((r) => r.body));
      return rows.map((r) => r.body);
    },
  });
  t.after(async () => {
    await app.cleanup();
    await cloud.stop();
  });
  const mic = wire(app, 'mic', true);
  await mic.wait((m) => m.type === 'ready');
  const c = cloud.connections[0],
    a = sentence(0, 0, '第一个完整观点'),
    b = sentence(1, 0, '同一人下一个观点'),
    d = sentence(2, 1, '另一位辩手回应');
  c.send({ sentences: [a] });
  await until(() => app.store.segments().length === 1);
  let count = 0;
  const keepTalking = setInterval(
    () => c.send({ sentences: [{ ...b, sentence_type: 0, sentence: '还在讲话' + ++count }] }),
    55
  );
  try {
    await until(() => calls.length > 0, 1000);
    assert(count >= 4, '不应在第一次短暂停顿前把句子送出');
  } finally {
    clearInterval(keepTalking);
  }
  assert.deepEqual(calls, [[a.sentence]]);
  c.send({ sentences: [b, d] });
  await until(() => calls.some((group) => group.includes(b.sentence)));
  c.onEnd = () => c.send({ final: 1 });
  mic.send({ type: 'end' });
  await mic.wait((m) => m.type === 'ended');
  await until(() => !app.store.pending().length);
  assert.deepEqual(calls, [[a.sentence], [b.sentence], [d.sentence]]);
});

test('进程重启后恢复曾在等待接续的定稿，按同一轮发言送一次', async (t) => {
  const initial = await testApp();
  for (const [i, body] of ['先听需求，', '再定方案。'].entries())
    initial.store.upsert({
      id: 'demo/' + i,
      stream: 'demo',
      mode: 'speech',
      speaker: '1:0',
      startMs: i * 1000,
      endMs: i * 1000 + 800,
      body,
      collecting: true,
    });
  await initial.cleanup(true);
  const calls = [];
  const app = await testApp({
    dir: initial.dir,
    generateBatch: async (rows) => {
      calls.push(rows.map((r) => r.id));
      return [
        { status: 'waiting' },
        { status: 'ready', quote: '先听需求，再定方案。', sources: rows.map((r) => r.id) },
      ];
    },
  });
  t.after(() => app.cleanup());
  await until(() => !app.store.pending().length);
  assert.deepEqual(calls, [['demo/0', 'demo/1']]);
  assert.equal(app.store.segments()[1].quote, '先听需求，再定方案。');
});

test('后一句被云端修订为另一位发言人时，重新判断之前暂缓的独立观点', async (t) => {
  const cloud = await mockCloud();
  const app = await testApp({
    dialAsr: cloud.dial,
    generate: async row => row.body,
    generateBatch: async rows => [
      {status:'waiting'},
      {status:'ready', quote:rows.map(s=>s.body).join(''), sources:rows.map(s=>s.id)},
    ],
  });
  t.after(async()=>{ await app.cleanup(); await cloud.stop(); });
  const mic = wire(app,'mic',true);
  await mic.wait(m=>m.type==='ready');
  const c=cloud.connections[0], a=sentence(0,0,'每周回访。'), b=sentence(1,0,'问题发现得早。');
  c.send({sentences:[a,b]});
  await until(()=>app.store.segments().at(-1)?.status==='ready');
  const [first,second]=app.store.segments();
  assert.equal(first.status,'waiting');
  c.send({sentences:[{...b,speaker_id:1,sentence:'这是另一个问题。'}]});
  await until(()=>app.store.segment(first.id).status==='ready' && app.store.segment(second.id).quote==='这是另一个问题。');
  assert.equal(app.store.segment(first.id).quote,a.sentence);
  assert.equal((await app.call('publish',{kind:'candidate',op:'stale-joined',id:second.id,rev:second.rev})).status,409);
});
