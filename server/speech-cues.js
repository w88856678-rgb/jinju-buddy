// These cues schedule an editorial decision. Hy4 decides whether the final text contains a complete, attributable idea.
const endMark = /[。！？!?…]+$/u;
const condition = /^(?:如果|假如|假设|只要|只有|除非|即使|虽然|之所以)/u;
const consequence = /(?:就|才|否则|那么|也会|也能|但|是因为|又怎么|又怎能|怎么能)/u;
const ownCorrection = /(?:^|[，,。；;！？!?]\s*)(?:(?:对不起|抱歉|不好意思|等等|不对)[，,、\s]*)?(?:(?:(?:刚才|刚刚|前面|之前|上面|上句|上句话|这里|方才|前一句)[，,\s]*)?(?:我(?:们)?(?:刚才|刚刚|前面|之前)?(?:的(?:表述|说法|数字))?)?(?:口误|说错(?:了|啦)?|说反了|说多了|说少了|收回(?:刚才|上一句|前面)|更正(?:一下|刚才|前面|为|[，,。])|纠正一下|改口|讲错了)|(?:准确(?:地|点)说|准确来说|更准确地说|不对[，,]\s*(?:是|应该|应为|实际)))/u;
const numericRepair = /(?:^|[。！？，,])\s*不是\s*([零〇两一二三四五六七八九十百千万亿\d.点]+[^，,。]{0,6})[，,]\s*(?:而?是|应该是)/u;
const selfRevision = /(?:^|[，,。；;！？!?])\s*(?:我(?:们)?(?:刚才|刚刚|前面|之前)?(?:说得不(?:对|准)|表述有误|的意思说反了|要(?:收回|更正)|改一下)|(?:更正|纠正)[，,：:]|(?:不[，,]\s*)?应更正为)/u;
export function isCorrection(text) {
  return ownCorrection.test(text) || selfRevision.test(text) || numericRepair.test(text);
}
export function startsQualification(text) {
  return isCorrection(text) || /^(?:等一下|不对|但是|但其实|不过|除非|前提是|我补充个条件)/u.test(text);
}
export function unfinished(text) {
  const stripped = text.trim().replace(/[，,。！？!?…]+$/u, '');
  const clause = stripped.split(/[。！？!?]/u).at(-1).trim();
  if (/^(?:一旦|只有当|当(?:你|我|他|她|发现|意识到|一个|一位))[^，,。！？!?]+$/u.test(clause) &&
      !/(?:就会|就能|就要|才能|才会|也会|也能|便可|便会|请先)/u.test(clause) && !/[？?]$/u.test(text)) return true;
  const onlyCount = /^只有(?:这|那|其中)?[\d零〇两一二三四五六七八九十百千万亿]+(?:户|人|名|个|家|件|位|例|次|票|天|年|成|条|种|%|％)/u.test(clause);
  return /[，,、：:]$/u.test(text.trim()) ||
    /(?:[两\d一二三四五六七八九十]+个?(?:月|年|周|天)的|或者对|以及对|是因为|违背了?|取决于|要么|换句话说|也就是说|那么|但是|而是|前提是|之所以|代表着|在于|如果|除非|因为|所以)$/u.test(clause) ||
    (condition.test(clause) && !onlyCount && !consequence.test(clause) && !/[？?]$/u.test(text));
}
export function completeThought(row) {
  if (row.review || row.mode === 'debate' && !row.speaker || unfinished(row.body)) return false;
  // A final declarative sentence can be as short as “沉默也是回答”。 Worth is the editor's decision.
  return endMark.test(row.body) && row.body.replace(/[\s\p{P}]/gu, '').length >= 3;
}

const digits = '零一二三四五六七八九';
function decimal(token) {
  let total = 0, section = 0, digit = 0;
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
  token = token.replace(/两/gu, '二').replace(/〇/gu, '零');
  if (![...token].some(c => units[c])) return [...token].map(c => digits.indexOf(c)).join('');
  for (const c of token) {
    const unit = units[c];
    if (!unit) digit = digits.indexOf(c);
    else if (unit < 10000) { section += (digit || 1) * unit; digit = 0; }
    else { total += (section + digit || 1) * unit; section = digit = 0; }
  }
  return String(total + section + digit);
}
const normalized = text => text.normalize('NFKC').replace(/(?<=\d)\.(?=\d)/gu, '点').replace(/[\s\p{P}]/gu, '')
  .replace(/[零〇两一二三四五六七八九十百千万亿]+(?=点[零〇一二三四五六七八九\d])/gu, decimal)
  .replace(/[零〇两一二三四五六七八九十百千万亿]+(?=户|人|个|元|次|家|年|月|天|票|例|倍|万|%)/gu, decimal);
function containsFact(body, word) {
  let at = body.indexOf(word);
  while (at !== -1) {
    if (!(/^\d/u.test(word) && /[\d点]/u.test(body[at - 1] || '')) &&
        !(/\d$/u.test(word) && /[\d点]/u.test(body[at + word.length] || ''))) return true;
    at = body.indexOf(word, at + 1);
  }
  return false;
}

// Prior rows are newest first and already scoped to the same stream, mode and speaker.
// Prefer what was explicitly taken back. A self-contained correction must not clear an unrelated card.
export function correctionTargets(row, prior) {
  if (!prior.length || !isCorrection(row.body)) return [];
  const oldWords = [...row.body.matchAll(/(?:说成(?:了)?|讲成(?:了)?|误报为|而不是|不是)([^，,。；;！？!?]{1,32})/gu)]
    .map(m => {
      const phrase = normalized(m[1]);
      // Interim ASR can still have no comma between the wrong quantity and its replacement.
      return /^(?:\d+(?:点\d+)?)(?:个百分点|公里|公斤|个月|小时|%|户|人|名|位|个|元|次|家|年|月|天|票|例|倍|件)/u.exec(phrase)?.[0] || phrase;
    }).filter(Boolean);
  const assertion = normalized(row.body.replace(ownCorrection, ''));
  const grams = text => new Set(Array.from(text.matchAll(/(?=(.{3}))/gu), m => m[1]));
  const facts = grams(assertion);
  const scored = prior.filter(s => !/^(?:好[的吧]?|谢谢(?:大家)?|嗯+|呃+|是的|我不同意|我(?:刚才)?口误)[。！!]*$/u.test(s.body)).map(source => {
    const body = normalized(source.body);
    const explicit = oldWords.some(word => containsFact(body, word));
    const topic = [...grams(body)].filter(part => facts.has(part)).length;
    return { source, body, explicit, topic };
  });
  const named = scored.filter(s => s.explicit).sort((a, b) => b.topic - a.topic);
  if (named.length) {
    const best = named[0];
    return named.filter(s => s === best || s.body === best.body).map(s => s.source.id);
  }
  if (oldWords.length) return [];
  const related = scored.filter(s => s.topic >= 2).sort((a, b) => b.topic - a.topic);
  if (related.length) return [related[0].source.id];
  const marker = ownCorrection.exec(row.body) || selfRevision.exec(row.body);
  if (marker && row.body.slice(0, marker.index).replace(/[\s\p{P}]/gu, '').length >= 5) return [];
  const last = scored[0]?.source;
  return last && row.startMs - last.endMs <= 30000 && !/说成|而不是/u.test(row.body) ? [last.id] : [];
}
