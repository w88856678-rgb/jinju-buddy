export function quoteText(value) {
  if (typeof value !== 'string') return '';
  // Spell out numeric notation before removing punctuation so 3.5% keeps its value.
  return value
    .replace(/\p{Nd}{1,3}(?:[,，]\p{Nd}{3})+(?!\p{Nd})/gu, (n) => n.replace(/[,，]/gu, ''))
    .replace(/(?<=\p{Nd})[:：](?=\p{Nd})/gu, '∶')
    .replace(/(?<=\p{Nd})[/／](?=\p{Nd})/gu, '∕')
    .replace(/(?<=\p{Nd})[.．](?=\p{Nd})/gu, '点')
    .replace(/(\p{Nd}[%％]?)(?:\s*[–—~～至到-]\s*)(?=[+\-－]?\p{Nd})/gu, '$1至')
    .replace(/(?<![\p{Nd}\p{Script=Latin}])[-－](?=\p{Nd})/gu, '负')
    .replace(/(\p{Nd}+(?:点\p{Nd}+)?)[ \t]*[%％]/gu, '百分之$1')
    .replace(/(?<=\p{Script=Latin})['’](?=\p{Script=Latin})/gu, '')
    .replace(/(?<=[\p{Script=Latin}\p{Nd}])[\p{P}~～]+(?=[\p{Script=Latin}\p{Nd}])/gu, ' ')
    .replace(/[\p{P}~～][\uFE0E\uFE0F]?/gu, '')
    .replace(/[^\S\r\n]+/gu, ' ')
    .trim();
}

const columnWidth = 384;
const segmenter = (granularity) => typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh-CN', { granularity }) : null;
const words = segmenter('word');
const graphemes = segmenter('grapheme');

// Mark candidates in the unpunctuated string. Prefix/suffix agreement ignores commas
// inside decimal notation and lets raw ASR punctuation stay out of audience copy.
function breakHints(raw, text) {
  const hints = new Map();
  for (const match of raw.matchAll(/[，,。！？!?；;：:、]+/gu)) {
    const prefix = quoteText(raw.slice(0, match.index));
    const suffix = quoteText(raw.slice(match.index + match[0].length));
    if (prefix && suffix && text.startsWith(prefix) && text.endsWith(suffix) &&
        prefix.length + suffix.length === text.length) {
      hints.set(prefix.length, /[。！？!?；;]/u.test(match[0]) ? 6 : 5);
    }
  }
  return hints;
}
const digit = '(?:\\d+(?:点\\d+)?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零一二三四五六七八九]+)?)';
const unit = '(?:个百分点|个百分比|个小时|平方公里|千瓦时|公斤|千克|公里|万元|亿元|小时|分钟|个月|周岁|美元|人民币|毫秒|秒|米|人|户|份|岁|倍|票|元|年|月|天|成)';
const number = '(?:负|正)?(?:百分之)?' + digit;
const quantities = new RegExp(number + '(?:' + unit + ')?(?:[至∶∕比]' + number + ')?(?:' + unit + ')?', 'gu');
const familyNames = /(?:[A-Z][a-zA-Z]*(?:[ \t]+[A-Z][a-zA-Z]*)+|[\p{Script=Latin}]+|\d+[A-Za-z]+|(?:北京|上海|浙江|香港|清华|北京师范|马来亚|台北科技)大学)/gu;
function splitHints(text, raw) {
  const breaks = breakHints(raw, text);
  const blocked = new Set();
  const phrases = /什么样的?|怎么样|个百分点|能不能|会不会|值不值得|愿不愿意|有没有|不太|未必|除非|以至于|百分之/gu;
  for (const pattern of [quantities, familyNames, phrases]) for (const m of text.matchAll(pattern)) {
    for (let at = m.index + 1; at < m.index + m[0].length; at++) blocked.add(at);
  }
  for (const match of text.matchAll(/(?:来自|就读于|毕业于|任职于|代表)([\p{Script=Han}]{2,8}?(?:大学|研究院|研究所|基金会|博物馆))/gu)) {
    const start = match.index + match[0].length - match[1].length;
    for (let at = start + 1; at < start + match[1].length; at++) blocked.add(at);
  }
  // Repeated words on either side of a caesura, including an unpunctuated chiasmus.
  for (const m of text.matchAll(/([\p{Script=Han}]{2,5})\1/gu)) breaks.set(m.index + m[1].length, 7);
  const wordStarts = new Set(words ? Array.from(words.segment(text), entry => entry.index) : []);
  return { breaks, blocked, wordStarts };
}
function splitLine(text, at, hints, width) {
  const left = text.slice(0, at).trimEnd(), right = text.slice(at).trimStart();
  if (!left || !right || hints.blocked.has(at)) return;
  const widths = [width(left), width(right)];
  if (Math.max(...widths) > columnWidth) return;
  const pair = /^(?:但是|可是|而是|却|因为|所以|因此|才会|就会|那就|就先|否则|以至于)/u.test(right) ||
    /^(?:虽然|如果|假如|只要|只有|除非|不是|之所以)/u.test(left) && /^(?:也|就|才|是|而|但)/u.test(right);
  const weakEnd = /(?:无法|没法|不能|不愿|未能|不肯|不敢)$/u.test(left) ||
    /^着(?=不|一|这|那|同|各|新|旧)/u.test(right) ||
    !hints.breaks.has(at) && /(?:因为|所以|不是|如果|而是|以至于|为什么|就|与|把|被|第|百分之|的|地|得)$/u.test(left);
  const inWord = !hints.wordStarts.has(at) && !/\s/u.test(text[at - 1] + text[at]);
  let priority = hints.breaks.get(at) || 0;
  // Ignore a spurious comma within a segmented word, even where it balances the lines.
  if (inWord && priority < 7) priority = 0;
  if (pair || /(?:在|从).{2,9}(?:之中|之后|以前|中|里|时)$/u.test(left) &&
      /^(?:成为|开始|看到|发现|找到|学会|得到|完成|产生)/u.test(right)) priority = Math.max(priority, 5);
  const score = (weakEnd ? 1600 : 0) + (inWord ? 800 : 0) - priority * 1200 + Math.abs(widths[0] - widths[1]);
  return { lines: [left, right], score, tier:weakEnd ? 0 : priority>=5 ? 3 : inWord ? 1 : 2 };
}
export function fitLedText(raw, measureAtSize, compact = false) {
  const text = quoteText(raw);
  if (!text || text.length > 650) return null;
  const explicit = text.split(/\r\n?|\n/u).map(line => line.trim());
  if (explicit.length > 2 || explicit.some(line => !line)) return null;
  const hints = splitHints(text, raw);
  const sizes = [[40, 52], [36, 46], [32, 42]];
  if (compact) sizes.push([30, 40], [29, 39]);
  let fallback;
  for (const [size, leading] of sizes) {
    if (size<32 && fallback) break;
    const width = line => measureAtSize(line, size);
    if (explicit.length === 2) {
      if (size < 40 && explicit.every(line => width(line) <= columnWidth)) return { size, leading, lines: explicit };
      continue;
    }
    if (width(text) <= columnWidth) return { size, leading, lines: [text] };
    if (size === 40 || width(text) > columnWidth * 2 + size) continue;
    let best;
    const positions = graphemes ? graphemes.segment(text) : text.matchAll(/\P{Mark}\p{Mark}*/gu);
    for (const { index } of positions) {
      if (!index) continue;
      const option = splitLine(text, index, hints, width);
      if (option && (!best || option.tier > best.tier || option.tier === best.tier && option.score < best.score)) best = option;
    }
    if (best && (!fallback || best.tier > fallback.tier)) {
      fallback = {tier:best.tier,layout:{size,leading,lines:best.lines}};
      if (best.tier===3) break;
    }
  }
  return fallback?.layout || null;
}
