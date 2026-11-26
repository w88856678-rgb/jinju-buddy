import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptQuote } from '../server/quote-paraphrase.js';
import { fitsCandidate } from '../server/quote-fit.js';
import { extractQuote, presentationIssue } from '../server/quotes.js';
import { quoteText } from '../public/led-fit.js';
import { mockCloud, sentence, testApp, until, wire } from './support.js';

function decided(t, decision) {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    choices: [{message: {content: JSON.stringify(decision)}}],
  }));
}
const row = (body, id = 'r') => ({id, body, speaker:'1:0', mode:'speech', stream:'sample'});

test('屏幕按真实宽度准入，数字的百分比、范围与符号仍可读', () => {
  assert(fitsCandidate('春'.repeat(24)));
  assert(!fitsCandidate('春'.repeat(25)));
  assert.equal(quoteText('误差 -3.5%，范围 10%–20%。'),'误差 负百分之3点5范围 百分之10至百分之20');
  assert.equal(quoteText('比例3:1，出席3/5。'),'比例3∶1出席3∕5');
});

test('同一人有两个意思时，不把上一条独立观察的数字强加给后一条', async t => {
  decided(t, {status:'ready', use:['E2'], line:'签到不能代替倾听。'});
  const source = row('昨天下了十毫米雨。签到不能代替倾听。');
  const result = await extractQuote('fixture',source);
  assert.equal(result.quote,'签到不能代替倾听。');
  assert.deepEqual(result.sources,['r']);
  assert.equal(source.body,'昨天下了十毫米雨。签到不能代替倾听。');
});

test('短原话保留并列的两项条件、判断对象和反问', async t => {
  decided(t, {status:'original'});
  const source = row('你没走出过这个村子，你没走出过这个城区，你怎么知道别处有没有你想找的东西呢？');
  const result = await extractQuote('fixture',source);
  assert.equal(result.status,'ready');
  assert.match(result.quote,/没走出村子和城区/);
  assert.match(result.quote,/怎知别处有无你想找的东西？/);
  assert.equal(result.quoteEvidence, source.body);
  assert(fitsCandidate(result.quote));
});

test('数字的作用对象、范围、个人立场和问句极性须在所选证据中成立', () => {
  for (const [source, edited] of [
    ['按对方的定义，很难有对方想要的结果。','按对方的定义，很难有想要的结果。'],
    ['每年有10–20户参加。','每年有10和20户参加。'],
    ['我同意给教师十票，给学生六票。','我同意给学生十票，给教师六票。'],
    ['误差可以是±2毫米。','误差可以是2毫米。'],
    ['我的选择是留下，我相信机会还会出现。','选择是留下，我相信机会还会出现。'],
    ['没走出这个村子，怎么知道别处有没有机会？','没走出这个村子，怎么知道别处没有机会？'],
  ]) {
    const excerpt = {status:'ready', quote:source,sources:['r']};
    assert.deepEqual(adaptQuote(excerpt, edited, [row(source)]),excerpt);
  }
});

test('比较两端的数值保留，末尾限定不能留在证据之外', async t => {
  let decision = {status:'ready',use:['E2'],line:'现在只用两天。'};
  t.mock.method(globalThis, 'fetch', async () => Response.json({choices:[{message:{content:JSON.stringify(decision)}}]}));
  let result = await extractQuote('fixture',row('原来审核要十天，现在只用两天。'));
  assert.equal(result.quote,'原来审核要十天，现在只用两天。');
  decision = {status:'ready',use:['E1'],line:'报名人数增加了。'};
  result = await extractQuote('fixture',row('报名人数增加了，但不代表更多人完成了课程。'));
  assert.equal(result.status,'waiting');
});

test('相邻定稿并行，回得晚的旧证据不能盖过已完成的观点', async t => {
  const cloud = await mockCloud();
  const old = '先做小规模回访。', next = '再按反馈调整频率。';
  let release, entered = false;
  const paused = new Promise(resolve => { release = resolve; });
  const app = await testApp({dialAsr:cloud.dial, quoteTiming:{fastMs:2}, generate: async (s, ctx) => {
    if (s.body === old) { entered = true; await paused; return old; }
    return {status:'ready', quote:old + next, sources:[ctx.at(-1).id, s.id]};
  }});
  t.after(async () => { await app.cleanup(); await cloud.stop(); });
  const mic = wire(app, 'mic&mode=speech', true);
  t.after(() => mic.ws.close());
  await mic.wait(m => m.type === 'ready');
  const c = cloud.connections[0];
  try {
    c.send({sentences:[sentence(1,0,old)]});
    await until(() => entered);
    c.send({sentences:[sentence(2,0,next)]});
    await until(() => app.store.segments().at(-1)?.quote === old + next);
    assert.equal(app.store.screen().version,0);
  } finally { release(); }
  await until(() => app.store.segments()[0].status === 'merged');
  const first = app.store.segments()[0];
  assert.equal((await app.call('publish',{kind:'candidate',op:'obsolete',id:first.id,rev:first.rev})).status,409);
});

test('已有对象的短反问保留，议程指代、缺对象的半句和应答催促不出卡', () => {
  assert.equal(presentationIssue('价值源自于什么呢？'),'waiting');
  assert.equal(presentationIssue('我们一直在寻找，却还持续地依赖着。'),'waiting');
  assert.equal(presentationIssue('你知道小张为什么不肯回应我吗？'),'skip');
  assert.equal(presentationIssue('刚才主持人也示范了不同的回答。'),'skip');
  assert.equal(presentationIssue('门票卖得多，就能证明博物馆有价值吗？'),null);
  assert.equal(presentationIssue('小张不肯回应居民的质疑。'),null);
  assert.equal(presentationIssue('她会继续吗？'),'waiting');
  assert.equal(presentationIssue('数字化解决了这个问题。'),'waiting');
  assert.equal(presentationIssue('培训让实习生也能独立开发小程序。'),null);
  assert.equal(presentationIssue('培训让实习生也能去研发。'),'waiting');
  assert.equal(presentationIssue('社区的医生会继续回访吗？'),null);
  assert.equal(presentationIssue('我在东兴村遇见他，你还会去那里吗？'),null);
  assert.equal(presentationIssue('对方回避了成本，我们接下来讲的是他。'),'waiting');
});

test('旧标签页或旧候选也须通过服务端显示宽度检查，保留可用的人工短编辑', async t => {
  const app = await testApp(); t.after(() => app.cleanup());
  const body = '场'.repeat(25), row = app.store.paste(body, '1:0');
  app.store.settle(row.id, row.rev, 'ready', body, null, [row.id]);
  const ref = {kind:'candidate', id:row.id, rev:row.rev};
  assert.equal((await app.call('publish',{...ref,op:'legacy-too-long'})).status,400);
  assert.equal((await app.call('publish',{...ref,text:body,op:'edit-too-long'})).status,400);
  assert.equal(app.store.screen().version,0);
  assert.equal((await app.call('publish',{...ref,text:'回访要听服务对象的意见',op:'short-edit'})).status,200);
});
