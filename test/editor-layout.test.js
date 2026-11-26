import test from 'node:test';
import {modelEndpoint} from '../server/config.js';
import assert from 'node:assert/strict';
import {candidateLayout} from '../server/quote-fit.js';
import {adaptQuote} from '../server/quote-paraphrase.js';
import {extractQuote, QuoteQueue, presentationIssue} from '../server/quotes.js';
import {sourceRef} from '../server/editor-cards.js';
import {testApp,until} from './support.js';
const snow = ['如果是昨天的熊浩学长，他可能会说，为什么缺爱的人不太擅长被爱。','因为他太焦急。','太迫切。','以至于听不到雪落下的声音。'];
const make = (body,i=0) => ({id:'voice/'+i,stream:'voice',mode:'debate',speaker:'1:0',body,startMs:i*1300,endMs:(i+1)*1300-100});
test('原标点、对仗、条件、数量与人工断行按同一 384 px 字栏排版',()=>{
  for(const [raw,lines] of [
    ['爱是自由的渺小，渺小的自由。',['爱是自由的渺小','渺小的自由']],
    ['爱是自由的渺小渺小的自由',['爱是自由的渺小','渺小的自由']],
    ['如果不确定，就先问服务对象',['如果不确定','就先问服务对象']],
    ['不是没人来，是来的人留不住',['不是没人来','是来的人留不住']],
    ['刚好说到这里\n就这样换行',['刚好说到这里','就这样换行']],
  ]) assert.deepEqual(candidateLayout(raw)?.lines,lines);
  for(const [text,quantity] of [['服务的满意率降到3.5%左右','百分之3点5'],['服务覆盖率提高3个百分点','3个百分点'],['今年预算采用10–20万元区间','10至20万元']])
    assert(candidateLayout(text).lines.some(l=>l.includes(quantity)));
  assert.deepEqual(candidateLayout('先核对每一个对象的反馈，再决定是否开放').lines,['先核对每一个对象的反馈','再决定是否开放']);
  assert.equal(candidateLayout('汉'.repeat(13)+'\n'+'字'.repeat(12)),null);
  assert.equal(candidateLayout('汉'.repeat(13)+'\n'+'字'.repeat(12),true).size,29);
  assert.equal(candidateLayout('汉'.repeat(14)+'\n字',true),null);
  for (const raw of ['房间里充满着不确定性。','我们可能无法接受明天的安排。']) {
    const [first, second] = candidateLayout(raw).lines;
    assert(!first.endsWith('无法') && !second?.startsWith('着不'));
  }
});
test('五类修辞、条件、对象、互动废话和低信息片段不会变成直接候选',()=>{
  for (const [body,line] of [
    ['缺爱的人不太擅长被爱。','缺爱的人不擅长被爱。'],
    ['我支持有条件地开放数据。','我支持开放数据。'],
    ['爱是自由的渺小，渺小的自由。','爱是渺小的自由。'],
    ['有效沟通才是解决矛盾的方式。','有效沟通是解决矛盾的方式。'],
    ['约两天开发工具，只用两小时生成报告。','约两天生成报告，只用两小时开发工具。']
  ]) { const row=make(body); const proof={status:'ready',quote:body,sources:[row.id]}; assert.equal(adaptQuote(proof,line,[row]),proof); }
  for(const s of ['我完全不知道什么意思。','还有更多的声音想不想听。','不要把医生小偷啊，Come on.']) assert.equal(presentationIssue(s),'skip');
  assert.equal(presentationIssue('沉默也是回答。'),null);
});
test('同人问因果保留程度与意象；短插话只产生待核线索，归属确认与原文修订跨重启生效',async t=>{
  const rows=snow.map(make);
  const direct=await extractQuote('unused',rows[3],rows.slice(0,3));
  assert.deepEqual(candidateLayout(direct.quote).lines,['缺爱的人为何不太擅长被爱','因为太迫切 听不到雪落声']);
  let app=await testApp(); t.after(()=>app.cleanup());
  const saved=rows.map((r,i)=>app.store.upsert({...r,speaker:i===2?'1:6':'1:0'}));
  const queue=new QuoteQueue(app.store,async()=>({status:'waiting'}),()=>{});
  queue.add(saved[3].id); await until(()=>app.store.cards.all().length);
  const card=app.store.cards.all()[0]; assert.equal(card.status,'review');
  assert(!card.refs.some(ref=>ref.id===rows[2].id));
  assert(!card.quote.includes('迫切')); assert.equal(app.store.screen().version,0);
  const send=(ver,op)=>app.call('publish',{kind:'candidate',id:card.id,rev:ver,op});
  assert.equal((await send(1,'try-unconfirmed')).status,409);
  const approved=(await (await app.call('cards/approve',{id:card.id,rev:card.rev})).json()).row;
  const posted=(await (await send(approved.rev,'after-review')).json()).screen;
  assert.deepEqual(posted.layout.lines,approved.layout.lines);
  await app.call('publish',{kind:'idle',op:'clear-stage'});
  await queue.stop();
  await app.cleanup(true); app=await testApp({dir:app.dir});
  app.store.upsert({...rows[2],speaker:'1:6',body:'对方说的不是这个问题。'});
  assert.equal((await send(approved.rev,'after-revision')).status,409);
  assert.equal((await app.call('publish',{kind:'history',op:'replay-after-revision',version:posted.version,currentVersion:app.store.screen().version})).status,409);
});
test('多观点使用各自证据；选区补救不进入逐字稿；拒绝过期选区与跨轮拼接',async t=>{
  const body='签到只说明有人到场。复查才说明服务持续。';
  const network = globalThis.fetch;
  t.mock.method(globalThis,'fetch',async (input,options) => input !== modelEndpoint ? network(input,options) :
    Response.json({choices:[{message:{content:JSON.stringify({status:'ready',use:['E1'],line:'签到只说明有人到场。',more:[{status:'ready',use:['E2'],line:'复查才说明服务持续。'}]})}}]}));
  const result=await extractQuote('test',make(body));
  assert.deepEqual([result.quote,result.more?.[0]?.quote],['签到只说明有人到场。','复查才说明服务持续。']);
  const app=await testApp({generate:async (r)=>({status:'ready',quote:r.body,sources:[r.id]})});t.after(()=>app.cleanup());
  const row=app.store.upsert(make(body));
  const queue=new QuoteQueue(app.store,async()=>result,()=>{});
  queue.add(row.id);await until(()=>app.store.cards.all().length);
  assert.equal(app.store.cards.all()[0].origin,'additional');await queue.stop();
  const a=app.store.upsert(make('我的建议是先听服务对象。',1));const b=app.store.upsert({...make('再决定怎样做。',2),speaker:'1:1'});
  const refs=[sourceRef(a),sourceRef(b)];
  assert((await (await app.call('transcript/extract',{refs})).json()).needsReview);
  const selected=(await (await app.call('transcript/extract',{refs,confirmed:true})).json()).row;
  assert.equal(selected.origin,'selection');assert.equal(app.store.segments().length,3);assert.equal(app.store.screen().version,0);
  app.store.upsert({...make('这不是我的建议。',1),speaker:'1:0'});
  assert.equal((await app.call('transcript/extract',{refs,confirmed:true})).status,409);
});
test('跨段数量比较保留对象与可能性，非接续陈述不强行配对',async t=>{
  t.mock.method(globalThis,'fetch', async()=>Response.json({choices:[{message:{content:'{"status":"skip"}'}}]}));
  const first=make('等待时间缩短了2天。'), next=make('但随之而来的覆盖人数可能增加30人。',1);
  const card=await extractQuote('fixture',next,[first]);
  assert.equal(card.quote,'等待时间缩短了2天，覆盖人数可能随之增加30人。');
  assert.equal(card.sources.length,2);
  assert.equal((await extractQuote('fixture',{...next,body:'另一个项目的覆盖人数增加30人。'},[first])).status,'skip');
});
test('没有办法接受后的宾语不会作为单独的正面立场发出',async()=>{
  const first=make('各位好，为什么我说把分数当成了目标，你会没有办法接受？');
  const second=make('尝试也是有价值的。',1);
  assert.equal((await extractQuote('unused',first)).status,'waiting');
  const closed=await extractQuote('unused',second,[first]);
  assert.equal(closed.quote,'把分数当目标，为何无法接受尝试也有价值？');
  assert.deepEqual(closed.sources,[first.id,second.id]);
  assert.equal(presentationIssue('当你意识到材料是不够的。'),'waiting');
});
