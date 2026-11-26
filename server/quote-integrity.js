// These tests apply to the exact cited thought, never to all speech in the window.
const flat = text => text.normalize('NFKC').replace(/[\p{P}\s]/gu, '');
export const reported = /(?:他|她|他们|对方|有人|[\p{Script=Han}]{2,6}(?:老师|学长))可能(?:会)?(?:说|问)|(?:假如|假设|如果)(?:换作|我是|我扮演)|(?:转述|引用|模仿)(?:一下)?(?:他|她|对方|前面|一位)|(?:按照|转述)(?:对方|他人)的(?:说法|看法)/u;
export function needsAttribution(rows) {
  return rows.some(row => reported.test(row.correctedBody ?? row.body ?? '') || row.review);
}
export function incompleteCard(value) {
  const s = flat(value);
  const vague = /^(?:(?:其实|所以|但是|那|我想说))*我(?:自己)?(?:真的|完全|也|都|还)?(?:不(?:太)?知道|没(?:有)?听懂)(?:这|那|你说的|他说的)?(?:是)?(?:什么|啥)(?:意思|情况)$/u;
  const audience = /^(?:(?:大家|你们|各位)(?:还)?|还有)?(?:更多的?(?:声音|故事|分享|内容|问题))?(?:大家|你们|各位)?想不想(?:继续)?(?:听|看|知道)(?:啊|呀|呢|吗)?$/u;
  const broken = /(?:^|[，。！？,!?])(?:不要|别)把[^，。！？,!?]{1,12}(?:啊|呀)?[，。！？,!? ]+come\s*on[！!.。]?$/iu;
  return /^(?:[^，。！？]{1,8})这(?:一)?块(?:有些?|很|比较)(?:特殊|特别|复杂|重要)(?:的)?$/u.test(s) ||
    /^(?:其实)?没有什么(?:宏大的?|万能的?|通用的?)(?:生存法则|标准答案|秘诀|通用法则)$/u.test(s) || vague.test(s) || audience.test(s) || broken.test(value.trim());
}
// A mirrored construction carries meaning in both directions, even if both sides
// use the same two nouns. Keep their order and the repeated anchor in a paraphrase.
export function keepsRhetoric(source, line) {
  const mirror = /([\p{Script=Han}]{2,5})的([\p{Script=Han}]{2,5})[，,；;、。]\s*\2的\1/u.exec(source);
  if (mirror && !flat(line).includes(mirror[1]+'的'+mirror[2]+mirror[2]+'的'+mirror[1])) return false;
  const interrogative = /为何|为什么|凭什么|怎么(?:会|能|知道)|难道|是否|能否|[吗呢][？?]/u;
  return !interrogative.test(source) || interrogative.test(line) || /[？?]/u.test(line);
}
const numberFact = /(?:\d+(?:[.]?\d+)?|[零〇两一二三四五六七八九十百千万亿]+)(?:个小时|小时|分钟|天|年|元|户|人|家|票|个百分点|%)/gu;
const actions = /开发|报告|培训|报名|完成|复查|预约|签到|提交|安装|生产|销售|测试|登记|审核|上线|交付|反馈|使用|发放|申请|诊断|领取/gu;
export function keepsFactBindings(source, line) {
  const clauses = text => text.split(/[，,。；;！？!?\n]/u);
  const original = clauses(source);
  if (new Set(source.match(numberFact) || []).size < 2) return true;
  for (const clause of original) {
    const nums = clause.match(numberFact) || [];
    const verbs = (clause.match(actions) || []).filter(w => original.filter(s => s.includes(w)).length === 1);
    if (nums.length !== 1 || !verbs.length) continue;
    const n = nums[0].replace(/个小时/u,'小时');
    const ac = clauses(line).find(s => s.replace(/个小时/gu,'小时').includes(n));
    if (!ac || !verbs.some(w => ac.includes(w))) return false;
  }
  return true;
}
// A closed why/because/result pattern has a source-preserving abbreviated reading.
// Remove redundant pronouns only when the cause explicitly refers to that subject.
export function causalReading(rows) {
  const values = rows.map(r => r.reading ?? r.correctedBody ?? r.body);
  const raw = values.join('');
  const found = /(?:^|[，,。！？?：:])(?:那)?(?:为什么|为何)([^，,。！？?]{2,15}?)(不太|并不|不|未必|很难|总是|往往)([^，,。！？?]{1,8})[。？?，,]\s*因为(?:他|她|他们|她们)?([^，,。！?？]{2,9})[，,。！?？]\s*(?:([^，,。！？?]{2,6})[，,。！?？]\s*)?(?:以至于|以致|以至)([^，,。；;！？?]{3,18})[。！?？]?$/u.exec(raw);
  if (!found || /[你我]|如果|除非|至少|仅|更正|可能/u.test(found[1] + found[4] + (found[5] || ''))) return null;
  const [,subject,scope,verb,cause,echo,consequence] = found;
  // Keep a second, different reason. Drop only a repeated intensifier + synonymous urgency.
  if (echo && !(flat(cause) === flat(echo) || /^太(?:焦急|着急|急切|迫切)$/u.test(cause) && /^太(?:焦急|着急|急切|迫切)$/u.test(echo))) return null;
  const question = subject + '为何' + scope + verb;
  const reason = echo || cause;
  const compact = consequence.replace(/([\p{Script=Han}]{1,3})落下的声音$/u,'$1落声');
  const source = found[0].replace(/^[，,。！？?：:]/u,'');
  let offset = raw.length - source.length, cursor = 0;
  const sources = rows.filter((_,i) => (cursor += values[i].length) > offset).map(r => r.id);
  return {status:'ready', quote:question+'？因为'+reason+'， '+compact+'。', quoteEvidence:source, sources};
}

const stop = /[，,。！？!?；;]+$/u;
const compressParticles = s => s.replace(/从来不/gu,'从不').replace(/一开始(?:心中)?就/gu,'本就')
  .replace(/不在于/gu,'不在').replace(/往往在于/gu,'往往在').replace(/愿意为/gu,'愿为')
  .replace(/(?:这|那)(?=条|个|种)(?:条|个|种)(?=[\p{Script=Han}]{2,})/gu,'')
  .replace(/(?:有多|多么)(?=[\p{Script=Han}]{2}的)/u,'').replace(/(?:伟大|宏大)的(?=叙事|目标|理想)/gu,x=>x.slice(0,-1));
// Only close constructions whose two halves are explicit. Cited text stays intact.
export function pairedReading(rows) {
  if (rows.length < 2) return null;
  const last = rows.at(-1);
  const raw = (last.reading ?? last.body).trim();
  const earlier = rows.at(-2);
  const prior = (earlier.reading ?? earlier.body).trim();
  const make = (quote, used, proof) => ({status:'ready',quote,quoteEvidence:proof,sources:used.map(r=>r.id)});
  // Two explicitly connected, quantified changes are one comparison. Copy both
  // subjects, directions, numbers and units; never infer this link from proximity.
  const measure = /^([\p{Script=Han}]{2,8}?)(可能会?|或许会?|预计会?|大约|最多|至少|仅)?(降低|提升|提高|放大|缩小|增加|减少|缩短|延长)(了)?([0-9]+(?:[.点][0-9]+)?|[零〇两一二三四五六七八九十百千万亿]+)(倍|个百分点|[%％]|天|小时|户|人|元)[。！]?$/u;
  const connective = /^(?:但是|但|而)?随之而来(?:带来)?的/u.exec(raw);
  if (connective && measure.test(prior)) {
    const second = measure.exec(raw.slice(connective[0].length));
    if (second && !/如果|除非|据称|对方|我方|并不|没有/u.test(prior+raw)) {
      const [,noun,modal='',verb,aspect='',amount,unit]=second;
      return make(prior.replace(stop,'')+'，'+noun+modal.replace(/^(可能|或许|预计)会$/u,'$1')+'随之'+verb+aspect+amount+unit+'。',[earlier,last],prior+raw);
    }
  }
  const paired = /(?:演绎了|举例说明了|举出|看到|提到|展示了)(不同的[\p{Script=Han}]{2,6})[。！]?$/u.exec(prior);
  if (paired && /^也有不同的[\p{Script=Han}]{2,6}[。！]?$/u.test(raw) && !/并非|并不|没有|未必|如果|不曾/u.test(prior))
    return make(paired[1]+'，'+raw,[earlier,last],prior+raw);
  // Answer a question with the speaker's own repeated explanation.
  const prefix = /^(源自于|来源于|原因在于|关键在于)(我[^，。！？]{2,22}不在于[^，。！？]{1,12})[。！]?$/u.exec(prior);
  if (prefix && raw.startsWith(prefix[1]+'我') && /^(?:源自于|来源于|原因在于|关键在于)我(?:一开始|最初|本来|起初).{0,8}(?:没有|不曾|从未)/u.test(raw)) {
    const original = compressParticles(prefix[2]);
    const left = original.replace(/^我(.{1,4})的意义不在(.+)$/u,'$2不是我的$1意义');
    const right = compressParticles(raw.slice(prefix[1].length).replace(/一开始心中就/u,'心中本就'));
    return make(left+'，'+right,[earlier,last],prior+raw);
  }
  // A negative contrast can straddle a complete ASR row containing only its hinge.
  const earlier2 = rows.at(-3);
  if (earlier2 && /^(?:倒|却|而)?往往在于[。！]?$/u.test(prior)) {
    const first = (earlier2.reading ?? earlier2.body).replace(/^(?:所以我们说|其实我想说的是)[，,]?/u,'').replace(stop,'');
    const head = /^(.{2,8}?)(从来不|并不|不)在于(?:它有多|有多|它的)?(.{2,9})$/u.exec(first);
    const tail = /^(?:它|他)?(愿意为.{2,10})[。！]$/u.exec(raw);
    if (head && tail) {
      const subject = head[1].replace(/^(.{2,4})的(温度|价值|意义|质量|成效|力量)$/u,'$1$2');
      const left = subject + head[2].replace('从来不','从不') + '在于' + compressParticles(head[3]);
      return make(left+'，往往在于'+tail[1].replace(/^愿意为多小的/u,'愿为小')+'。',[earlier2,earlier,last],first+'。'+prior+raw);
    }
  }
  return null;
}

// Resolve an explicit “从…开始／用…解决它” recommendation only through examples of
// that same object. An intervening new assertion, speaker or qualification ends it.
export function joinedAdvice(rows) {
  if (rows.length < 2) return null;
  const raw = r => r.reading ?? r.body;
  const last = rows.at(-1), action = /^(尝试|可以|建议)?用([\p{Script=Latin}\d\p{Script=Han}]{1,8}?)去?(解决|处理|验证|检验)它[。！]?$/u.exec(raw(last));
  if (!action) return null;
  for (let i=rows.length-2;i>=Math.max(0,rows.length-5);i--) {
    const lead = /^(?:大家|我们|你)?(可以|不妨|建议)(?:尝试)?从(?:一个)?(非常)?小的(?:具体)?([\p{Script=Han}]{2,4})开始[。！]?$/u.exec(raw(rows[i]));
    if (!lead) continue;
    const examples = rows.slice(i+1,-1).map(raw);
    if (examples.some(t=>! /^(?:可能是|也可能是|比如|例如|为[他她它]做)/u.test(t) || /只有|如果|前提|未必|并非|不是|而是|反对|\d/u.test(t))) return null;
    const scope = examples.some(t=>/(?:我们|我)身边人/u.test(t)) ? '身边的' : '';
    const text = lead[1]+'从'+scope+'小'+lead[3]+'开始，'+(action[1]||'')+'用'+action[2]+action[3]+'它。';
    return {status:'ready',quote:text,sources:rows.slice(i).map(r=>r.id),quoteEvidence:rows.slice(i).map(raw).join('')};
  }
  return null;
}
const segments = new Intl.Segmenter('zh',{granularity:'word'});
export function suspiciousParallel(text) {
  const part = /(?:是我自己|是你自己|是他自己)[^，。！？]{1,8}[，,]([\p{Script=Han}]{2,3})是(?:别人|他人|自己|对方)的/u.exec(text);
  return Boolean(part && [...segments.segment(part[1])].every(w=>w.segment.length===1));
}

// A question can end an ASR row immediately before the object of a negated verb.
// Keep the question and its object in one evidence window. Falling back to an
// affirmative object alone would reverse who made the claim.
const openAttitude = /(?:没有办法|没法|无法|不能|不肯|不愿)(?:去)?(?:接受|相信|承认|认同|赞同|容忍)[？?。！!]?$/u;
export function boundComplement(rows) {
  const last=rows.at(-1), prior=rows.at(-2), read=r=>r.reading ?? r.correctedBody ?? r.body;
  const isOpen=s=>/(?:为什么|为何|凭什么|如果|假如|只有当|除非)/u.test(s) && openAttitude.test(s);
  if (isOpen(read(last))) return {status:'waiting',problem:'否定谓语还缺宾语，等待下文'};
  if (!prior || !isOpen(read(prior)) || /^(?:对方|我方|我不同意|不对|可是|然而)/u.test(read(last))) return null;
  const head=/(?:为什么|为何)(?:我说)?(把[^，。！？]{2,24})[，,](?:你|你们)(?:会)?(没有办法|没法|无法|不能|不肯|不愿)(?:去)?(接受|相信|承认|认同|赞同|容忍)[？?。！!]?$/u.exec(read(prior));
  if (head && /^[^，。！？；]{3,16}[。！]?$/u.test(read(last))) {
    const topic=head[1].replace(/当成了?(?=[\p{Script=Han}])/u,'当');
    const verb=head[2].replace(/^(?:没有办法|没法)$/u,'无法')+head[3];
    // Only collapse the nominal frame in a completed affirmative complement.
    const object = read(last).replace(stop,'').replace(/也是有(意义|价值|作用|道理|必要)的$/u,'也有$1');
    return {status:'ready',quote:topic+'，为何'+verb+object+'？',
      sources:[prior.id,last.id],quoteEvidence:read(prior)+read(last)};
  }
  return {status:'waiting',problem:'这段接在否定谓语之后，需要连同前句核对'};
}
