import assert from 'node:assert/strict';
import test from 'node:test';
import { extractQuote, extractQuoteBatch, parseDecision } from '../server/quotes.js';
import { adaptQuote } from '../server/quote-paraphrase.js';
import { prepareReadings, stagePunctuation } from '../server/quote-reading.js';

const row = (id, body, extra = {}) => ({ id, body, speaker:'1:0', stream:'session', mode:'speech', ...extra });

test('分句摘录精确定位，允许从给出的起始小节跨到本段下一小节', async t => {
  let decision;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices:[{ message:{ content:JSON.stringify(decision) } }] }));
  const item = row('a','对我而言，怎样选择，是我自己说了算，这是第一点。');
  decision = {status:'ready',use:[[2,'怎样选择，是我自己说了算']]};
  assert.equal((await extractQuote('fixture',item)).quote,'怎样选择，是我自己说了算。');
  decision = {status:'ready',use:[[1,'怎样选择，是我自己说了算']]};
  await assert.rejects(extractQuote('fixture',item));
  decision = {status:'ready',use:[[2,'所有人都说了算']]};
  await assert.rejects(extractQuote('fixture',item));
});

test('裁掉独立举例仍须保留数字、否定、条件和说话人范围', () => {
  const pick = (body, text) => parseDecision(JSON.stringify({status:'ready',spans:[[1,text]]}),[row('x',body)]);
  for (const [source, excerpt] of [
    ['如果连续回访三个月，失访率会降低。','失访率会降低。'],
    ['我的选择是留在本地。','选择是留在本地。'],
    ['这不是所有人的选择。','所有人的选择。'],
    ['至少十五户完成了复查。','十五户完成了复查。'],
    ['一百一十五户完成了复查。','十五户完成了复查。'],
    ['对方认为这个做法是对的。','这个做法是对的。'],
  ]) assert.throws(() => pick(source,excerpt));
  const source='我们先做初筛，除非家属同意，才会安排上门。';
  assert.throws(() => parseDecision(JSON.stringify({status:'ready',spans:[[1,'我们先做初筛，'],[1,'才会安排上门。']]}),[row('x',source)]));
  assert.equal(pick(source,source).quote,source);
});

test('读稿修复有原话佐证的口吃及明确指物的代词，保留原稿和人称', () => {
  const original='可以依依靠身边的人，也可以依靠专业的帮助。';
  const rows=[row('a',original),row('b','慢慢来，我们应该好好学习。')];
  assert.match(prepareReadings(rows,x=>x)[0].reading,/可以依靠身边的人/);
  assert.equal(rows[0].body,original);
  assert.equal(prepareReadings(rows,x=>x)[1].reading,rows[1].body);
  const material=[row('1','软件的价值从来不在于它有多少功能。'),row('2','往往在于。'),row('3','他能否完成这项任务。')];
  assert.match(prepareReadings(material,x=>x)[2].reading,/^它能否/);
  material[1].body='医生才是决策者，关键在于。';
  assert.match(prepareReadings(material,x=>x)[2].reading,/^他能否/);
  material[2].speaker='2:1'; material[1].body='往往在于。';
  assert.match(prepareReadings(material,x=>x)[2].reading,/^他能否/);
  assert.equal(stagePunctuation('我希望大家好好学习。',false),'我希望大家好好学习。');
});

test('单次 Hy4 返回可朗读的摘编与独立证据，批次只用同一人已说的内容', async t => {
  const source = row('x','这个方案推进的过程当中，我们发现交接记录很重要。');
  const line = '这个方案推进时，我们发现交接记录很重要。';
  let reply, calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'hy4-flash');
    assert.match(body.messages[1].content, /E1/);
    return Response.json({choices:[{message:{content:JSON.stringify(reply)}}]});
  });
  const use = ['E1','E2'];
  reply = {status:'ready', use, line};
  const single = await extractQuote('fixture', source);
  assert.deepEqual(single, {status:'ready',quote:line,quoteEvidence:source.body,sources:['x']});
  reply = { decisions:[{at:1,status:'ready',use,line},{at:2,status:'waiting'}] };
  const batch = await extractQuoteBatch('fixture',[source,row('y','如果对方提出新的问题，')],[]);
  assert.deepEqual(batch,[single,{status:'waiting'}]);
  assert.equal(calls, 2);
});

test('摘编保护数量、量词、否定、作用对象、归属、条件与问句，疑似错听保留摘录', () => {
  const protect = (body, proposed, extra) => {
    const evidence = {status:'ready', quote:body, sources:['x']};
    assert.deepEqual(adaptQuote(evidence, proposed, [row('x',body,extra)]), evidence);
  };
  protect('只有十户家庭完成了核查。','只有一百户家庭完成了核查。');
  protect('误差降低了三个百分点。','误差降低了百分之三。');
  protect('我记得大概花了两天时间。','我记得花了两天时间。');
  protect('签到可以证明人来过，不能证明服务有效。','签到可以证明人来过，证明服务无效。');
  protect('家长资助学校，学校支持社区。','学校资助家长，学校支持社区。');
  protect('我方反对减少投入，对方支持减少投入。','对方反对减少投入，我方支持减少投入。');
  protect('只有现场核对，才能确认收到了材料。','现场核对就能确认收到了材料。');
  protect('平静时听到同一句话，感觉一样吗？','平静时听到同一句话，感觉一样。');
  protect('这个体系当中的交接记录很重要。','体系里的交接记录很重要。',{review:'定稿末尾有新增词'});
  protect('这个体系当中的交接记录很重要。','体系里的交接记录很重要。',{mode:'debate',speaker:null});
  protect('刚才我说错了，只有十户完成了复查。','刚才我说错了，只有十户完成复查。');
});

test('改口先确认数量、再否定旧值时，候选用最后的完整事实，逐字稿保留两个数量', async t => {
  const source = row('c','刚才我说错了，是十八位，不是八十位。我们最终只采访了十八位老师。');
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert(!JSON.stringify(payload.原文).includes('八十'));
    return Response.json({choices:[{message:{content:JSON.stringify({status:'ready',use:['E1'],line:'我们最终只采访了十八位老师。'})}}]});
  });
  assert.equal((await extractQuote('fixture',source)).quote,'我们最终只采访了十八位老师。');
  assert.match(source.body,/不是八十位/);
  const incomplete = row('d','刚才我说错了，是十八位，不是八十位。');
  assert.deepEqual(await extractQuote('fixture',incomplete),{status:'waiting'});
});

test('补回句首主语须用同一证据段紧邻的原话，缺少依据时回退', async t => {
  let line = '签到只能记录到场人数，不能说明培训已经有效。';
  const source = row('s','这个签到呢，只能记录到场的人数，不能说明培训已经有效。');
  t.mock.method(globalThis,'fetch',async () => Response.json({choices:[{message:{content:JSON.stringify({
    status:'ready',use:['E2','E3'],line,
  })}}]}));
  const accepted = await extractQuote('fixture',source);
  assert.equal(accepted.quote,line);
  assert.equal(accepted.quoteEvidence,source.body);
  line = '体检只能记录到场人数，不能说明培训已经有效。';
  assert(!('quoteEvidence' in await extractQuote('fixture',source)));
});
