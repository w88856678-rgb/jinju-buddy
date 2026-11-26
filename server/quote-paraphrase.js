import { isCorrection, unfinished } from './speech-cues.js';

import { keepsRhetoric, keepsFactBindings } from './quote-integrity.js';

const plain = text => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');
// Normalize only equivalent grammatical forms for verification. Card and evidence keep their own words.
function reading(text) {
  return text.normalize('NFKC')
    .replace(/(?<=\d)(?:%|％)?\s*[-–—~～至到]\s*(?=[负+-]?\d)/gu, matched => matched.includes('%') ? '%范围至' : '范围至')
    .replace(/(?<![\dA-Za-z])[-－](?=\d)/gu, '负')
    .replace(/(?<=\d)[:：∶](?=\d)/gu, '∶')
    .replace(/(?<=\d)[/／∕](?=\d)/gu, '∕')
    .replace(/有没有|有无/gu, '是否有')
    .replace(/能不能|能否/gu, '是否能')
    .replace(/会不会/gu, '是否会')
    .replace(/是不是/gu, '是否是')
    .replace(/有条件地/gu,'有条件').replace(/无条件地/gu,'无条件')
    .replace(/为何/gu,'为什么').replace(/是怎么样|怎么样/gu,'怎样')
    .replace(/从来不/gu,'从不').replace(/愿为/gu,'愿意为')
    .replace(/怎知/gu, '怎么知道')
    .replace(/起初|最初|本来就|本就|一开始/gu, '起初')
    .replace(/担责/gu, '承担责任')
    .replace(/养孩子/gu, '养育孩子')
    .replace(/为什么(?:大家)?(?:一定|非)要|何必/gu, '为何一定要')
    .replace(/没(?!(?:有|收|落|入|过|食))/gu, '没有')
    .replace(/(?:我想(?:请教|问)(?:大家|您|你|各位)?(?:一?个)?问题|我想说的是|怎么说呢|换句话说|对方辩友(?:一?个)?问题)[，,。：:]\s*/gu, '')
    .replace(/(?:只|仅仅|仅)(?=(?:用|花|剩|能|有|需|要|限))/gu, '只');
}
const facts = /(?:百分之)?(?:\d+(?:[.,]\d+)*|[零〇两一二三四五六七八九十百千万亿]+(?:点[零一二三四五六七八九]+)?)(?:个百分点|个小时|小时|分钟|平方公里|公里|公斤|万元|亿元|个月|[%％户人名位元岁次年天票例倍家项张份台套层成万亿])|第[零〇两一二三四五六七八九十百千万亿]+|[零〇两一二三四五六七八九十百千万亿]+(?=比[零〇两一二三四五六七八九十])|(?<=比)[零〇两一二三四五六七八九十百千万亿]+|\d+(?:\.\d+)?|[A-Za-z]+[A-Za-z\d-]*/gu;
const operators = /[≤≥≠=<>±∶∕]|不太|不怎么|并非总是|有条件(?:地)?|无条件(?:地)?|即使|尽管|尚未|自称|据称|仅在|只在|才(?=是|能|会)|起初|范围至|负(?=\d)|是否|仅有|只能|只用|只需|只花|只剩|只占|没法|限制在|不足|不到|不超(?:过)?|不等于|不代表|反而|大约|大概|约莫|约(?=[零〇两一二三四五六七八九十百千万亿\d])|将近|差不多|并不是|并没有|并不能|并不|不需要|不必|无需|不用|不能够|不能|无法|不可能|不一定|不应当|不应该|不应|不敢|不是|并非|没有|从未|不得|不可|不|未必|未经|未|除非|如果|假如|假设|只要|只有|仅当|至少|起码|至多|最多|仅限|仅仅|仅|所有|全部|任何|绝对|一定|必然|也许|可能|往往|通常|必须|可以|或许|反对|支持|赞成|否认|承认/gu;
const canonical = new Map([
  ['并不是','不是'],['并非','不是'],['并没有','没有'],['并不','不'],['并不能','不能'],
  ['不能够','不能'],['无法','不能'],['不必','无需'],['不需要','无需'],['不用','无需'],
  ['不应该','不应'],['不应当','不应'],['假如','如果'],['起码','至少'],['至多','最多'],
  ['也许','可能'],['或许','可能'],['您方','你方'],['赞成','支持'],['大约','约'],['约莫','约'],['大概','约'],['由于','因为'],['源自于','因为'],['源自','因为'],['来源于','因为'],['来自于','因为'],['您','你'],['咱们','我们'],
]);
const people = /我方|对方|你方|您方|他们|她们|我们|你们|咱们|我|你|您|他(?!人)|她/gu;
const sides = /我方|对方|你方|您方|反对|支持|赞成|否认|承认/gu;
const logic = /因为|由于|源自于?|来源于|来自于|因此|所以|导致|必定|意味着|证明|造成|必然|说明|相比|高于|低于|高过|低过|超过|少于|多于|大于|小于|增加|减少|上升|下降/gu;
function signature(text, pattern) {
  return [...text.normalize('NFKC').matchAll(pattern)].map(m => {
    if (pattern === facts) return m[0].replace(/^(两|一|二|三|四|五|六|七|八|九|十)\1(?=天|小时|户|人)/u, '$1').replace(/个小时$/u, '小时');
    return canonical.get(m[0]) || m[0];
  });
}
function collapseAdjacent(tokens) {
  return tokens.filter((token, i) => token !== tokens[i - 1]);
}
function inOrder(wanted, available) {
  let i = 0;
  for (const token of available) if (i < wanted.length && token === wanted[i]) i++;
  return i === wanted.length;
}
function commonLength(a, b) {
  const previous = new Uint16Array(b.length + 1);
  for (const char of a) {
    let diagonal = 0;
    for (let j = 0; j < b.length; j++) {
      const above = previous[j + 1];
      previous[j + 1] = char === b[j] ? diagonal + 1 : Math.max(above, previous[j]);
      diagonal = above;
    }
  }
  return previous[b.length];
}
// A shorter fallback must still convey the point Hy4 chose. Two shared words in a dangling tail are insufficient.
export function coversIdea(line, excerpt) {
  const wanted = plain(reading(line)), actual = plain(reading(excerpt));
  return wanted.length > 0 && commonLength(actual, wanted) >= wanted.length * 0.58;
}
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
function words(text) {
  return [...segmenter.segment(text)]
    .filter(s => s.isWordLike && (s.segment.length > 1 || /^[甲乙丙丁]$/u.test(s.segment))).map(s => s.segment);
}
function changedSubject(source, line) {
  const predicates = /改变|证明|决定|承担|导致|反对|支持|要求|依靠|取代|取消|资助|帮助|影响/gu;
  return [...line.matchAll(predicates)].some(m => {
    const at = source.indexOf(m[0]);
    if (at < 0 || at !== source.lastIndexOf(m[0])) return false;
    const subject = t => words(t.split(/[，。！？；,!?;]/u).at(-1).replace(/(?:就|会|能够|可以|可能|一定|也|都|才|来|去|将)+$/u, '')).at(-1);
    const oldSubject = subject(source.slice(0,at)), newSubject = subject(line.slice(0,m.index));
    return oldSubject && newSubject && oldSubject !== newSubject && source.includes(newSubject) &&
      !line.slice(0,m.index).split(/[，。！？；,!?;]/u).at(-1).includes(oldSubject);
  });
}
// Keep the predicates attached to numbers, positions and negations on the same side of each marker.
// A word shared only by the opposite side is a stronger signal of a reversal than overall text overlap.
function movedAcrossMarker(source, line, pattern) {
  const before = [...source.matchAll(pattern)], after = [...line.matchAll(pattern)];
  return after.some((m, i) => {
    const original = before[i];
    if (!original) return true;
    const left = source.slice(0, original.index), right = source.slice(original.index + original[0].length);
    const newLeft = words(line.slice(0, m.index)), newRight = words(line.slice(m.index + m[0].length));
    return newLeft.some(w => right.includes(w) && !left.includes(w)) ||
      newRight.some(w => left.includes(w) && !right.includes(w));
  });
}
// A repeated subject or negative predicate can govern two coordinated objects in a short line.
// Accept the contraction only if the very same predicate still governs both original objects.
function coordinatedReading(source, line) {
  return source.replace(/((?:你们|我们|他们|我|你|他|她)?(?:没有|不能|不应|不许)[\p{Script=Han}]{1,5}?)(?:这[个种]|那[个种])?([\p{Script=Han}]{1,5})[，,。]\s*\1(?:这[个种]|那[个种])?([\p{Script=Han}]{1,5})(?=[，,。！？!?])/gu,
    (all, prefix, first, second) => {
      const predicate = prefix.replace(/^(?:你们|我们|他们|我|你|他|她)/u, '').replace(/过$/u, '');
      const objects = [first, second].map(s => s.replace(/^(?:过)?(?:这个|那个|这种|那种)/u, ''));
      const coord = line.match(/[^，,。！？!?]*(?:和|或|与|及|、)[^，,。！？!?]*/gu) || [];
      return coord.some(c => c.includes(predicate) && objects.every(o => o && c.includes(o)))
        ? prefix + objects.join('和') : all;
    });
}
function sameActors(source, line) {
  const participants = text => collapseAdjacent(signature(text, people));
  const original = participants(source), edited = participants(line);
  // An attribution such as “按你方的定义” does not also attribute “你方想要的结果”.
  // A subject can carry across coordinated predicates, but a party owning a separate
  // condition or expectation must still be named with that claim.
  const role = name => name === '您方' ? '你方' : name;
  const owner = /(我方|对方|你方|您方)(?:自己|所)?(想要|期待|希望|要求|主张|负责|承担)/gu;
  const owned = [...source.matchAll(owner)];
  if (owned.some(([,side,verb]) => line.includes(verb) &&
      ![...line.matchAll(owner)].some(([,who,action]) => role(who) === role(side) && action === verb))) return false;
  const personal = /(我|我们|你|你们)(?:自己)?的?(?:人生|生活|工作)?(?:的)?(意义|价值|立场|选择|经验|判断|建议|看法)/u.exec(source);
  if (personal && line.includes(personal[2])) {
    const scope = line.slice(0, line.indexOf(personal[2]));
    if (!scope.includes(personal[1])) return false;
  }
  if (original.join('|') === edited.join('|')) return true;
  // Generic second person in a question may be implicit. A speaker's personal stance cannot be omitted.
  return /[？?]$/u.test(line) && original.length === 1 && original[0] === '你' && !edited.length;
}
// A new named object cannot be licensed by a high character-overlap score elsewhere in the line.
function groundedWords(source, line) {
  const grammar = /^(?:怎么|为何|为什么|难道|凭什么|如此|那些|这些|自己|自身|一个|一种|一样|同样|之中|当中|来自|因为|因此|所以|成为|而是|只会|怎会|时候|可能|可以|是否|而言|来说|还是|以及|怎样|这个|那个|原本|没有|有无)$/u;
  return words(line).every(word => {
    if (source.includes(word) || grammar.test(word)) return true;
    // Productive compounds often simply remove 的、个、过 from the speaker's phrase.
    const compact = source.replace(/[的了过个这那之]/gu, '');
    return compact.includes(word) || [...word].length === 2 && [...word].some(c => /[的是在所将就来后时对为有]/u.test(c)) && [...word].every(c => /[的是在所将就来后时对为有]/u.test(c) || source.includes(c));
  });
}
export function adaptQuote(excerpt, proposed, rows) {
  if (typeof proposed !== 'string' || excerpt.status !== 'ready') return excerpt;
  const line = proposed.trim();
  let source = excerpt.quote;
  // A short ASR clause can start at the predicate. Only restore an explicit subject
  // from the immediately preceding clause of the very same cited segment.
  const predicate = /^(?:只能|不能|可以|必须|需要|能够|才会|会让|意味着|说明|证明)/u.exec(source)?.[0];
  const subjectEnd = predicate ? line.indexOf(predicate) : -1;
  if (subjectEnd > 0) {
    const subject = line.slice(0, subjectEnd);
    const row = excerpt.sources.length === 1 && rows.find(r => r.id === excerpt.sources[0]);
    const reading = row && (row.reading || row.body);
    const head = source.split(/[，。！？；,!?;]/u)[0];
    const start = reading ? reading.indexOf(head) : -1;
    const lead = start > 0 && reading.slice(0,start).match(/(?:^|[。！？；，,])([^。！？；，,]{1,18}[，,])$/u)?.[1];
    if (!lead || !lead.includes(subject) || start !== reading.lastIndexOf(head)) return excerpt;
    source = lead + source;
  }
  const edited = reading(line);
  const claim = coordinatedReading(reading(source), edited);
  const a = plain(claim), b = plain(edited);
  if (plain(source) === plain(line) || b.length < 2 || b.length > 100 || b.length > a.length + 6 ||
      /[\r\n<>{}\[\]“”「」]|^(?:金句|摘编|发言人|观点是)[：:]/u.test(line) ||
      unfinished(line) || /[？?]$/u.test(source) !== /[？?]$/u.test(line)) return excerpt;
  const evidenceRows = rows.filter(r => excerpt.sources.includes(r.id));
  if (!evidenceRows.length || evidenceRows.some(r => r.review || isCorrection(r.body) ||
      (r.mode === 'debate' && !r.speaker))) return excerpt;
  const same = pattern => signature(claim, pattern).join('|') === signature(edited, pattern).join('|');
  if (!keepsRhetoric(source, line) || !keepsFactBindings(source, line) || !same(facts) || !same(operators) || !sameActors(claim, edited) ||
      !inOrder(signature(edited, logic), signature(claim, logic)) ||
      movedAcrossMarker(claim, edited, facts) || movedAcrossMarker(claim, edited, sides) ||
      movedAcrossMarker(claim, edited, /并不|不能|没有|未曾|反而|除非|只有|至少|至多|最多/gu)) return excerpt;
  if (!groundedWords(claim, edited) || changedSubject(claim, edited) || commonLength(a, b) < b.length * 0.64 ||
      edited.split(/[，。！？；,!?;]/u).map(plain).some(c => c.length >= 4 && commonLength(a,c) < c.length * 0.60)) return excerpt;
  return { ...excerpt, quote: /[。？！!?]$/u.test(line) ? line : line + '。', quoteEvidence: source };
}
