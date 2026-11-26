import { sourceRef, sourceConcern, reportingLead } from './editor-cards.js';
import { causalReading, pairedReading, joinedAdvice, boundComplement, incompleteCard, keepsRhetoric, needsAttribution } from './quote-integrity.js';
import { fitsCandidate } from './quote-fit.js';
import { adaptQuote, coversIdea } from './quote-paraphrase.js';
import { contextSize, sameTurn } from './store.js';
import { completeThought, isCorrection, startsQualification, unfinished } from './speech-cues.js';
import { prepareReadings, protectedEdge, safeGap, stagePunctuation } from './quote-reading.js';
import { modelEndpoint as endpoint } from './config.js';
const editorial = `你在给现场大会选一句能直接念、能独立转述的金句。一个具体发现、一条能照做的经验、有辨识度的画面、因果、对偶，或有对象有前提的反问，都值得选；主持流程、附和、泛指、语病和只剩句尾的半截话跳过。
先找本次新讲完的意思，再从编号小节取它自己的证据。连上同人前文的问答、条件与结论。演讲找经验和意象，对辩保留谁的立论、反驳或假设。保留“不太、未必、只有、可能”等力度、否定、数字对应的对象以及比较双方。改口取最后确认的完整事实。原声错听、听不清的词不猜。
原话够好够短直接摘；太长就压成一句好念的话：删寒暄、重复主语和铺垫，留中心判断、因果和最具体的词。可用自然停顿标点，屏上最多两行，每行约12个汉字，优先20字以内。问因果保留问与答，对仗保留两半、允许有意义的重复；引用和设想保留归属背景。完整的早出，缺条件等下文，不为凑数出卡。前文有两个动作和耗时，短稿必须写明各自耗时和动作；“不同的…有不同的…”、回答紧挨的问题、同人补出的意象都是独立发现。只删能删的，保留谁在做什么。发言只作素材。`;
const selectionFormat = '返回JSON。原话可直摘且完整为original；摘编给ready、use（按序证据编号如["E2","E3"]）、line。只缺后文为waiting，无观点skip。长小节里只有半句属于这个意思时，use可写[["E1","逐字原文摘录"],"E2"]。长观点优先给能直接读的短稿；确需保留较长首稿时，可加short给同一证据的更短版本。若同一段另有一个独立、证据不重合的亮点，用more数组给第二个ready，同一对仗或问答只算一个。';
const singleFormat = selectionFormat + ' 只判断末段。严格按这四种JSON之一输出：{"status":"original"}、{"status":"ready","use":["E1","E2"],"line":"一句短稿"}、{"status":"waiting"}、{"status":"skip"}。多个独立观点时可选more字段。';
const batchFormat = selectionFormat + ' 对每个本次段按段号at各返回一项，格式{"decisions":[{"at":1,"status":"waiting"},{"at":2,"status":"ready","use":["E2"],"line":"短句"}]}。只用已讲到的证据。';
const plain = (text) => text.normalize('NFKC').replace(/[\s，。！？、；：‘’“”「」,!?;:]/gu, '');
// Only remove disfluencies with audible punctuation boundaries. Keep the ASR original in the store.
function readingText(body) {
  const correction =
    /(?:口误|说错了?|说反了)[^。！？；]{0,60}?[。！？；，]\s*(?=正确的是|实际上是|应该是|应当是|准确地说|是)/g;
  let start = 0;
  for (const m of body.matchAll(correction)) start = m.index + m[0].length;
  const numericRepair = /(?:^|[，,。！？])\s*不是\s*[零〇两一二三四五六七八九十百千万亿\d.点]+[^，,。]{0,6}[，,]\s*(?=(?:而?是|应该是))/gu;
  for (const m of body.matchAll(numericRepair)) start = Math.max(start, m.index + m[0].length);
  let text = body.slice(start);
  if (start) {
    // A speaker may confirm the right quantity first, then reject the old one.
    // Use the following complete restatement only when the same value and unit repeat there.
    const reverse = /^(?:正确的是|实际上是|应该是|应当是|是)([零〇两一二三四五六七八九十百千万亿点\d.]+)(位|名|户|人|票|次|家|天|个月|年|元|万元|小时|分钟|个百分点|%)[，,]\s*(?:而?不是)[零〇两一二三四五六七八九十百千万亿点\d.]+\2(?:[。；;！!]\s*(.*))?$/u.exec(text);
    if (reverse) {
      const confirmed = reverse[1].replaceAll('.', '\\.') + reverse[2];
      const value = new RegExp('(?<![零〇两一二三四五六七八九十百千万亿点0-9.])' + confirmed, 'u');
      const restatement = reverse[3] || '';
      text = value.test(restatement) ? restatement : '是' + reverse[1] + reverse[2] + '。' + restatement;
    }
    const echo = /^(?:正确的是|实际上是|应该是|应当是|是)([^，,。]{1,16})[，,](.+)$/s.exec(text);
    if (echo && echo[2].includes(echo[1])) text = echo[2];
  }
  return text
    .replace(/[，,。；]\s*(?:这(?:就)?是(?:我的|我方的)?第[一二三四五六七八九十0-9]+[点条]|谢谢(?:各位|大家))[。！!]*$/u, '。')
    .replace(/(?:这个|那个)[，、,]\s*(?:嗯+|呃+|额+)[，、,]\s*/g, '')
    .replace(/(^|[，、,。！？；])(?:嗯+|呃+|额+)[，、,]\s*/g, '$1');
}
function clauseBreak(text, offset) {
  if (offset === 0 || offset === plain(text).length) return true;
  let length = 0;
  for (const char of text) {
    if (/[，。！？、；：,!?;:]/u.test(char) && length === offset) return true;
    length += plain(char).length;
  }
  return false;
}
function checkBoundary(source, start, end, firstText) {
  const before = source.slice(0, start),
    picked = source.slice(start, end),
    after = source.slice(end);
  if (/(?:不能|不应|不得|只有|仅限|至少|至多|最多|不少于|不超过|并非|并不|没有|不|未)$/.test(before))
    throw new Error();
  if (protectedEdge(before, picked, after)) throw new Error();
  if (firstText && start > 0) {
    let offset = 0, prefix = '';
    for (const ch of firstText) {
      const length = plain(ch).length;
      if (offset >= start && length) break;
      prefix = /[。！？!?]/u.test(ch) ? '' : prefix + ch;
      offset += length;
    }
    if (/(?:如果|假如|只要|只有|除非|仅当|在.{1,15}前提下|对方(?:主张|声称|认为)|我(?:不认为|反对))[^。？！]*$/u.test(prefix))
      throw new Error();
  }
  const number = /[0-9零〇一二三四五六七八九十百千万亿点.]/;
  if (
    (number.test(before.at(-1) || '') && number.test(picked[0])) ||
    (number.test(picked.at(-1)) && /^[0-9零〇一二三四五六七八九十百千万亿.%]/.test(after))
  )
    throw new Error();
}
function candidate(quote, sources, rows) {
  const first = rows.findIndex((r) => r.id === sources[0]);
  const prior = rows[first - 1];
  if (
    prior?.status === 'waiting' &&
    /^(?:如果|只要|只有|除非|假如)/.test(prior.body) &&
    /^(?:我们|你们|他们|这)?(?:就|才|否则)/.test(quote)
  ) {
    sources.unshift(prior.id);
    quote = prior.reading.replace(/[。，、,]?$/, '，') + quote;
  }
  if (prior && !sources.includes(prior.id) && sameTurn(prior, rows[first]) && !prior.review && !rows[first].review) {
    const hypothesis = /^(如果|假如)(我|我们|你|对方)(说|问|认为|主张)/u;
    const frame = hypothesis.exec(quote)?.[0];
    if (frame && prior.reading.startsWith(frame) && /[？?]$/u.test(quote) &&
        prior.reading !== rows[first].reading && prior.reading.length + quote.length <= 140) {
      sources.unshift(prior.id);
      quote = prior.reading + quote;
    }
  }
  if (prior && !sources.includes(prior.id)) {
    const parallel = /^(源自于|来源于|来自于|原因在于|关键在于)/u.exec(quote)?.[1];
    if (parallel && prior.reading.startsWith(parallel) && /不在于|并非|不是/u.test(prior.reading) &&
        prior.reading !== rows[first].reading) {
      sources.unshift(prior.id);
      quote = prior.reading.replace(/[。，,；]+$/u, '，') + quote;
    } else if (/^(?:为什么|凭什么|难道)/u.test(quote) &&
        /(?:问|回答|讨论).{0,15}(?:这个|那个)问题[。？?]$/u.test(prior.reading) && prior.reading.length <= 45) {
      sources.unshift(prior.id);
      quote = prior.reading + quote;
    }
  }
  if ([...quote].length > 180) throw new Error();
  quote = stagePunctuation(quote, sources.length > 1);
  return { status: 'ready', quote, sources };
}
function parseModelJson(content) {
  return JSON.parse(content.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ''));
}
export function parseDecision(content, rows) {
  return readDecision(parseModelJson(content), prepareReadings(rows, readingText));
}
function readDecision(result, rows, offsets) {
  if (['skip', 'waiting', 'duplicate'].includes(result?.status)) return { status: result.status };
  if (result?.status !== 'ready' || !Array.isArray(result.spans) || !result.spans.length) throw new Error();
  // Hy4 sometimes cites the first segment number for a verbatim excerpt spanning a hard ASR cut.
  // Recover only a unique contiguous match that includes the current segment.
  if (!offsets && result.spans.length === 1 && Array.isArray(result.spans[0]) && typeof result.spans[0][1] === 'string') {
    const excerpt = result.spans[0][1].trim(),
      needle = plain(excerpt);
    const pieces = rows.map((s) => plain(s.reading));
    const source = pieces.join(''),
      start = source.indexOf(needle),
      end = start + needle.length;
    if (
      needle &&
      start >= 0 &&
      source.lastIndexOf(needle) === start &&
      end > source.length - pieces.at(-1).length &&
      [...excerpt].length <= 180
    ) {
      let position = 0;
      const sources = rows
        .filter((s, i) => {
          const left = position;
          position += pieces[i].length;
          const used = left < end && position > start;
          if (used)
            checkBoundary(pieces[i], Math.max(0, start - left), Math.min(pieces[i].length, end - left), start >= left ? s.reading : null);
          return used;
        })
        .map((s) => s.id);
      return candidate(excerpt, sources, rows);
    }
  }
  let previous = 0,
    previousEnd = 0;
  const sources = [],
    pieces = [];
  for (const [i, span] of result.spans.entries()) {
    if (!Array.isArray(span) || span.length !== 2) throw new Error();
    const [number, excerpt] = span;
    const row = rows[number - 1];
    if (!Number.isInteger(number) || !row || number < previous || typeof excerpt !== 'string')
      throw new Error();
    const source = plain(row.reading),
      chosen = plain(excerpt);
    const start = offsets ? offsets[i] : source.indexOf(chosen, number === previous ? previousEnd : 0);
    if (!chosen || start < 0 || (number === previous && start < previousEnd) || source.slice(start, start + chosen.length) !== chosen) throw new Error();
    checkBoundary(source, start, start + chosen.length, previous ? null : row.reading);
    if (previous) {
      const prior = rows[previous - 1];
      const omitted = number === previous ? source.slice(previousEnd, start) :
        [plain(prior.reading).slice(previousEnd), ...rows.slice(previous, number - 1).map(r => plain(r.reading)), source.slice(0,start)].join('');
      if (omitted && !safeGap(omitted, clauseBreak(prior.reading, previousEnd), clauseBreak(row.reading, start))) throw new Error();
    }
    previousEnd = start + chosen.length;
    previous = number;
    if (sources.at(-1) !== row.id) sources.push(row.id);
    pieces.push(excerpt.trim());
  }
  const quote = pieces
    .map((piece, index) => (index < pieces.length - 1 && !/[\p{P}]$/u.test(piece) ? piece + '，' : piece))
    .join('');
  if (previous !== rows.length || [...quote].length > 180) throw new Error();
  if (offsets) return { status: 'ready', quote: stagePunctuation(quote, sources.length > 1), sources };
  return candidate(quote, sources, rows);
}
function standalone(text) {
  if (incompleteCard(text)) return false;
  if (/^(?:他|她|它)(?:们)?(?:正|曾|已经|能否|分析|提出|指出|展示|告诉|愿意|发现|使用|完成)|^(?:这|那)(?:一端|一头|边|里)(?:的)?/u.test(text)) return false;
  if (/^(?:这要|那要)看(?:你|您|大家)?怎么(?:理解|定义|看)[。！]*$/u.test(text) ||
      /^(?:在.+时代[，,]?)?(?:我们|大家)(?:作为.{1,6})?应该怎么办[？?]$/u.test(text)) return false;
  const split = /既要([\p{Script=Han}])[，,]?也要([\p{Script=Han}])|([\p{Script=Han}])和([\p{Script=Han}])的双面性/u.exec(text);
  if (split && text.includes('定义') && text.includes((split[1] || split[3]) + (split[2] || split[4]))) return false;
  if (/^(?:也要|也会|以及|为此|也有|而是|我关注的.{0,12}来说)|(?:解决|尝试|看待|理解)它[。！]?$|(?:到底|应该)?怎么定义[。？！]?$|^(?:是给|施加了|取决于此)/u.test(text)) return false;
  if (unfinished(text) || /^(?:[您你]刚才(?:说|提到|讲).{0,10}(?:哪个例子|哪件事|第几个问题)|接下来有请|请下一位)/u.test(text)) return false;
  const line = text.replace(/^(?:所以|其实|那么|然后)[，,]?/u, '');
  if (/^(?:倒|也|却|反而)?(?:往往|常常|恰恰)?(?:在于|源自于|取决于)|^(?:[为给替][他她它](?:们)?(?:做|解决)|是给|也?可能是我(?:自己|关注)|我关注的.{0,8}来说|这个[他她它]|既要.{1,3}也要.{1,3}[。！]?$)/u.test(line) ||
      /([一两三四五六七八九十])\1(?:套|位|份|户|个月)|(?:哪个|那个|这个)问题[。！]?$|(?<!在)(?:为|对)[他她它]做一些东西/u.test(line)) return false;
  if (/^(?:这(?:个|种|样|一点|件事|句话)?|那(?:个|种|样)?|它|他们|她们)(?:就是|其实|确实|完全|很|能否|意味着|说明|愿意|为什么|怎么知道|正在)/u.test(line)) return false;
  if (/^(?:也就是说|换句话说|(?:原因|关键)在于此|刚才(?:那个|这个))|(?:他说的|你说的|我说的)[。！!?？]*$/u.test(line)) return false;
  return !/^(?:我(?:方)?(?:想|要)(?:请教|问)|(?:对方)?辩友.{0,4}(?:一个|个)问题|请问你刚才提到的|谢谢|大家好)[^。！？]*(?:哪个例子|什么问题|什么意思|一个问题)[？?。]*$/u.test(line);
}
const partingWord = /^(?:我不同意|我同意|对|是的|没错|好|好的|嗯+|呃+|你好|大家好|谢谢|谢谢大家)[。！!.]*$/;
const bareReply = /^(?:(?:当然|肯定|那当然|那肯定)[是就]?)?(?:不一样|一样|不同意|同意|不能|不可以|可以|不是|是|不会|会|没有|有)(?:的|了|啊)?[。！!.]*$/u;
function isBriefReply(item, previous) {
  return item.mode === 'debate' && /[？?]$/u.test(previous?.body || '') && bareReply.test(item.body.trim());
}
const correction = (s) => isCorrection(s.body);
const bareCorrection = row => correction(row) &&
  /^(?:正确的是|实际上是|应该是|应当是|是)[零〇两一二三四五六七八九十百千万亿点\d.]+(?:位|名|户|人|票|次|家|天|个月|年|元|万元|小时|分钟|个百分点|%)[。！!]?$/u.test(row.reading);
const modelProblem = '模型返回不完整或摘录与原文不符，可重新提炼';
async function requestQuote(token, payload, format, maxTokens) {
  if (!token) throw new Error('尚未配置 Hy4 Flash 密钥');
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hy4-flash',
        stream: false,
        reasoning_effort: 'no_think',
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: editorial + '\n' + format },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
  } catch {
    throw new Error('Hy4 Flash 网关连接失败或超时，请检查网络后重试');
  }
  if (!response.ok) throw new Error('Hy4 Flash 请求失败（HTTP ' + response.status + '）');
  try {
    const { choices } = await response.json();
    if (choices?.[0]?.finish_reason === 'length') throw new Error();
    return parseModelJson(choices[0].message.content);
  } catch {
    throw new Error(modelProblem);
  }
}

// Number the clauses once for a whole model call so batch decisions share a single evidence index.
function modelInput(rows, firstNew) {
  const parts = [];
  const input = rows.map((row, index) => {
    const phrases = row.reading.match(/[^，,。！？!?；;]+[，,。！？!?；;]*/gu) || [];
    let offset = 0;
    const numbered = phrases.map(text => {
      parts.push({ row: index + 1, text, offset });
      offset += plain(text).length;
      return ['E' + parts.length, text];
    });
    const option = index >= firstNew ? verbatim(row, rows[index - 1]) : null;
    return { 段号: index + 1, 小节: numbered, 本次: index >= firstNew,
      ...(option ? { 可直摘:option.quote } : {}),
      ...(correction(row) ? { 编辑任务: '发言人的更正，有明确对象的新事实可直接播报，摘最后确认的事实。' } : {}) };
  });
  return { parts, payload: {
    场景: rows.at(-1).mode === 'speech' ? '嘉宾演讲' : '自由辩', 原文: input,
  } };
}
const bindingClause = /^(?:或者对|以及对|(?:倒|却|其实|它)?(?:也|更|往往|常常|恰恰)?(?:在于|取决于)|而是|但是|反而|前提是|条件是)$/u;
function focusQuestion(choices, parts, last) {
  const key = choice => Array.isArray(choice) ? choice[0] : choice;
  const own = choices.filter(choice => parts[key(choice) - 1]?.row === last);
  const text = own.map(ch => parts[key(ch) - 1].text).join('');
  // A moderator's invitation can precede a self-contained restatement of the question.
  const invitation = /(?:辩友.{0,5}(?:一个|个)问题|(?:想问|请问|问对方).{0,7}问题)/u;
  const wholeRow = parts.filter(p => p.row === last).map(p => p.text).join('');
  if (own.length === choices.length && invitation.test(wholeRow) && /[？?]$/u.test(text)) {
    const restart = own.findIndex(ch => /^(?:就是|换句话说|我的问题是)/u.test(parts[key(ch) - 1].text));
    if (restart > 0) {
      const opening = own.slice(0,restart).map(ch => parts[key(ch) - 1].text).join('');
      const clause = parts[key(own[restart]) - 1].text.replace(/^(?:就是|换句话说|我的问题是)[，,]?/u, '');
      if (clause.length >= 8 && !/如果|假如|既然|除非|只要|只有|相比|比起|的时候|但是|至少|[0-9]/u.test(opening)) {
        return [[key(own[restart]),clause], ...own.slice(restart + 1)];
      }
    }
  }
  return choices;
}
// Map a cross-clause literal back to each exact source interval. The supplied index
// must be inside the unique match. A guessed paraphrase never acquires a source.
function resolveChoice(choice, parts, before, last) {
  const [id, sub] = Array.isArray(choice) ? choice : [choice];
  const part = parts[id - 1];
  if (!Number.isInteger(id) || !part || part.row <= before || part.row > last) throw new Error();
  if (!Array.isArray(choice)) return [{ id, part, text:part.text, offset:0 }];
  if (choice.length !== 2 || typeof sub !== 'string' || !plain(sub)) throw new Error();
  const needle = plain(sub), original = plain(part.text);
  const local = original.indexOf(needle);
  if (local >= 0 && local === original.lastIndexOf(needle)) return [{id, part, text:sub, offset:local}];
  const eligible = parts.map((p,i) => ({p,id:i+1})).filter(x => x.p.row > before && x.p.row <= last);
  const all = eligible.map(x => plain(x.p.text)).join('');
  const from = all.indexOf(needle), to = from + needle.length;
  if (from < 0 || all.lastIndexOf(needle) !== from) throw new Error();
  let pos = 0;
  const matched = [];
  for (const entry of eligible) {
    const end = pos + plain(entry.p.text).length;
    if (end > from && pos < to) {
      const start = Math.max(0,from-pos), stop = Math.min(end,to)-pos;
      let length = 0, literal = '';
      for (const ch of entry.p.text) {
        const size = plain(ch).length;
        if (size ? length >= start && length < stop : length > start && length <= stop) literal += ch;
        length += size;
      }
      matched.push({id:entry.id,part:entry.p,text:literal,offset:start});
    }
    pos = end;
  }
  if (!matched.some(x => x.id === id)) throw new Error();
  return matched;
}
function proofNumbers(decision) {
  if (decision && !decision.status && ['ready','original','waiting','skip','duplicate'].includes(decision.type ?? decision.judgment))
    decision = {...decision,status:decision.type ?? decision.judgment};
  if (!Array.isArray(decision?.use)) return decision;
  const number = id => typeof id === 'string' && /^E[1-9]\d*$/u.test(id) ? Number(id.slice(1)) : id;
  return { ...decision, use: decision.use.map(item =>
    Array.isArray(item) ? [number(item[0]), ...item.slice(1)] : number(item)) };
}
function needsFrame(text) {
  return /^(?:如果|假如|除非|只要|只有在|仅当|在.{1,12}前提下)/u.test(text) &&
    !/(?:就会|才能|才会|否则|那么|又怎|就能|便可)/u.test(text);
}
// These edits remove speech scaffolding; all protected terms in the remaining sentence are still verified.
function shortReading(source) {
  // Where the actor and negative predicate repeat verbatim, make one coordinated clause.
  // A/B questions stay open questions; quoted evidence keeps the unabridged wording.
  const coordinated = source.replace(/((?:你们|我们|你|我)(?:没有|没|不能|从未)(?:[\p{Script=Han}]{1,4}?))(?:过)?(?:这|那)个([\p{Script=Han}]{1,5})[，,]\1(?:过)?(?:这|那)个([\p{Script=Han}]{1,5})(?=[，,。！？!?])/gu,
    (_, subjectVerb, first, second) => subjectVerb.replace(/过$/u, '') + first + '和' + second);
  const shorter = source.length > 26 ? coordinated
    .replace(/那一(?:端|头)([\p{Script=Han}]{1,4})的那一(?:端|头)/gu, '$1那头')
    .replace(/你(?:又)?怎么知道(?=.{2,}[？?]$)/u, /你.+[，,].*你(?:又)?怎么知道/u.test(coordinated) && !/[我他她您]/u.test(coordinated) ? '怎知' : '你怎知')
    .replace(/有没有(?=.{1,}[？?]$)/gu, '有无')
    .replace(/呢(?=[？?]$)/u, '') : source;
  return shorter
    .replace(/按照(?=我方|你方|您方|对方)/gu, '按')
    .replace(/这样子(?=[\p{Script=Han}]{1,4}的)/gu, '这样')
    .replace(/^(?:(?:就是|所以|其实)[，,]?|(?:我想说的是|我想告诉(?:大家|各位|你们)|怎么说呢|我觉得吧|[嗯呃]+)[，,：:。]\s*)+/u, '')
    .replace(/^(?:对我而言|对我来说)[，,](?=.+我(?:自己|可以|觉得|认为|想|选择|决定|说))/u, '')
    .replace(/([我你他她])按照\1自己的/gu, '$1按自己的')
    .replace(/([我你他她])按照/gu, '$1按')
    .replace(/([，,。])(?:那|那么)(?=[我你他她])/gu, '$1')
    .replace(/一个什么样的/gu, '怎样的')
    .replace(/(?:的过程当中|的过程之中)/gu, '时')
    .replace(/(?:然后呢|这个[，、,]嗯|怎么说呢)[，,]/gu, '')
    .replace(/(?:尝试|愿意|开始|需要|意愿)去(?=[\p{Script=Han}])/gu, token => token.slice(0,-1))
    .replace(/^但是(?=[我你他她]|没有|对于)/u, '')
    .trim();
}

const boundContext = /没(?:有|能|走|做|见|去|得到)|从未|未曾|不(?:能|是|会|应|要|可|敢|愿)|既要|一方面|不(?:认为|赞同|同意)|并不是说|不是说|对方辩友认为|如果|假如|既然|即使|虽然|除非|只有|只要|只(?:是|能|统计|用|算|看)|至少|至多|最多|最少|大概|大约|未必|不一定|并不(?:是|代表)|不代表|不等于|前提|条件|相比|过去|原先|此前|去年|原来|对方(?:说|主张|认为)|我方(?:反对|支持|认为)|\d|[零〇两一二三四五六七八九十百千万亿]+(?:户|人|岁|年|天|小时|元|票|次|位|份|件|成|倍)/u;
const dependentLead = /^(?:所以|因此|才|就会|这就|否则|那么|而是|但是|但却|却|以及|也(?:违背|证明|说明|需要)|因为|源自于|取决于|往往在于|凭什么|怎么能)/u;

function overlapsIdea(text, line) {
  const chars = plain(line);
  const pairs = Array.from(plain(text).matchAll(/(?=(..))/gu), m => m[1]);
  const shared = new Set(pairs.filter(pair => chars.includes(pair)));
  return shared.size >= 2 || chars.length <= 6 && plain(text).includes(chars);
}

function verbatim(row, previous) {
  if (!row || row.review || isCorrection(row.body) || (dependentLead.test(row.reading) && !/^所以[，,](?:为什么|难道|怎么能)/u.test(row.reading)) ||
      (previous && needsFrame(previous.reading)) || partingWord.test(row.reading) || bareReply.test(row.reading)) return null;
  let evidence = row.reading;
  const pieces = evidence.match(/[^，,。！？!?；;]+[，,。！？!?；;]*/gu) || [];
  if (/[？?]$/u.test(evidence) && /(?:请教|请问|辩友.{0,5}问题|想问.{0,8}问题)/u.test(evidence)) {
    const at = pieces.findIndex(p => /^(?:就是|换句话说|我的问题是)/u.test(p));
    if (at > 0 && !boundContext.test(pieces.slice(0,at).join(''))) evidence = pieces.slice(at).join('');
  }
  const quote = shortReading(evidence);
  if (!standalone(quote) || !fitsCandidate(quote)) return null;
  return { status:'ready', quote, sources:[row.id], ...(quote !== evidence ? {quoteEvidence:evidence} : {}) };
}

function clearOriginal(row, previous) {
  if (row.review || needsAttribution([row]) || isCorrection(row.body)) return null;
  const raw = row.reading;
  // A universally quantified, self-contained finding may follow a greeting and
  // a restarted phrase. Do not discard a modal, denial, condition or attribution.
  const last = raw.split(/[，,。！？!?]/u).filter(Boolean).at(-1) || '';
  if (/^没有[\p{Script=Han}]{1,8}是(?:在|被).{4,20}(?:成[为就]|完成|得到|实现|解决).+的$/u.test(last)) {
    const lead = raw.slice(0,raw.lastIndexOf(last));
    if (!/如果|只有|即使|但凡|只在|我(?:反对|不同意|不认为)|并非|不是(?:说)?|否认|假设|声称|对方(?:说|认为)|未必|或许|可能|至少/u.test(lead) && fitsCandidate(last))
      return {status:'ready',quote:last+'。',sources:[row.id],quoteEvidence:last+'。'};
  }
  const option = verbatim(row,previous);
  if (option && /[^，,]{2,10}怎么.{1,5}[，,].{2,14}[，,]我自己说了算[。！]$/u.test(option.quote))
    return option;
  return directQuestion(row,previous);
}
function directQuestion(row, previous) {
  const raw = row.reading;
  if (!/[？?]$/u.test(raw) || row.review || needsAttribution([row]) || /(?:我方|对方)(?:主张|认为|声称)|如果|假如|除非|仅在/u.test(raw)) return null;
  const opening = /^那么[，,]?(?=.{2,9}(?:是怎么样|怎样|如何|怎么))/u;
  const reading = !previous || !needsFrame(previous.reading) ? raw.replace(opening,'') : raw;
  const option = verbatim({...row,reading},previous);
  if (!option || presentationIssue(option.quote)) return null;
  const question = option.quote;
  const mechanism = /^(?:那么|那)?[^，。！？]{2,9}(?:是)?(?:怎么样|怎样|怎么|如何)(?:能够|才能|能)?(?:使|让|帮助|解决|验证|判断|避免|改变|降低|衡量|改善)[^，。！？]{2,12}[？?]$/u.test(question);
  if (mechanism && !/(?:这个|那个|这些|那些)(?:问题|情况|事情|东西)(?:呢|的|吗)?[？?]$/u.test(question)) {
    const line = question.replace(/^那么/u,'').replace(/是怎么样/u,'是怎样');
    return line===question ? option : {...option,quote:line,quoteEvidence:option.quoteEvidence || question};
  }
  const explicit = /(?:同一[句话]|同一件事|同样的.{1,4}).{2,10}(?:一样|相同|不同|有区别)吗[？?]$/u.test(question) ||
    /^(?:所以[，,]?)?(?:为什么|为何|凭什么)(?:大家|我们|你们)?(?:一定|必须|非得)要?.{4,22}[？?]$/u.test(question);
  if (!explicit || /怎么回事|我这个|这件事|那个问题|那件事/u.test(question)) return null;
  return option;
}
function displayChoice(excerpt, line, rows) {
  const adapted = adaptQuote(excerpt, line, rows);
  if (adapted !== excerpt && fitsCandidate(adapted.quote) && standalone(adapted.quote)) return adapted;
  const shortened = shortReading(excerpt.quote);
  if (fitsCandidate(shortened) && standalone(shortened) && (!line || coversIdea(line, shortened))) {
    return shortened === excerpt.quote ? excerpt : { ...excerpt, quote: shortened, quoteEvidence: excerpt.quote };
  }
  return null;
}
function selection(decision, parts, before, last, rows) {
  if (decision.status === 'original') {
    const option = verbatim(rows.at(-1), rows.at(-2));
    if (!option) throw new Error();
    return option;
  }
  if (decision.status !== 'ready') return readDecision(decision, rows);
  if (!Array.isArray(decision.use) || !decision.use.length) throw new Error();
  let choices = decision.use;
  const cited = choices.map(c => parts[(Array.isArray(c) ? c[0] : c) - 1]);
  if (cited.every(part => part && part.row > before && part.row < last)) return { status: 'duplicate' };
  const spans = [], offsets = [];
  let prev = 0;
  function add(part, text, offset) {
    spans.push([part.row - before, text]);
    offsets.push(part.offset + offset);
  }
  choices = focusQuestion(choices, parts, last);
  const resolved = choices.flatMap(choice => resolveChoice(choice, parts, before, last));
  const head = resolved[0], preceding = parts[head.id - 2];
  if (preceding && preceding.row > before) {
    const qualifier = /(?:只(?:统计|记录|算|看|限)|仅(?:统计|记录|限)|并不(?:代表|是说)|不是说|不(?:认为|赞同|同意)|(?:对方|我方|有人|他们)(?:说|主张|认为)|前提是|条件是)/u;
    const connected = (preceding.row === head.part.row && /[，,；;：:]$/u.test(preceding.text)) ||
      /^(?:就|才|那|否则|凭什么|怎么能|难道|又怎)/u.test(head.text);
    const beforeAfter = /(?:原来|原先|过去|此前|先前|上次|去年)/u.test(preceding.text) &&
      /^(?:但|而|却|后来|现在|如今|这次|今年)/u.test(head.text) && /[\d零〇两一二三四五六七八九十百千万亿]/u.test(preceding.text + head.text);
    if ((connected && (needsFrame(preceding.text) || qualifier.test(preceding.text))) || beforeAfter) {
      resolved.unshift({ id:head.id - 1, part:preceding, text:preceding.text, offset:0 });
    }
  }
  const firstPart = resolved[0], lastPart = resolved.at(-1);
  const prior = parts[firstPart.id - 2], next = parts[lastPart.id];
  if (prior && prior.row > before && needsFrame(prior.text) &&
      (!/[。！？!?]$/u.test(prior.text) || /^(?:就|才|那|否则|所以|又怎)/u.test(firstPart.text)))
    return { status: 'waiting' };
  if (next?.row === lastPart.part.row &&
      /^(?:但(?:是)?(?:只|必须|不能|不代表|不等于|未必)|除非|前提是|仅限|只限|不代表|并不意味着|条件是|而不是|而是)/u.test(next.text))
    return { status: 'waiting' };
  for (const {id,part,text,offset} of resolved) {
    if (id <= prev) throw new Error();
    if (prev && id > prev + 1) {
      const gap = parts.slice(prev,id - 1);
      const describesSubject = gap.length <= 4 && gap.some(p => /^(?:也)?可能是/u.test(p.text)) &&
        gap.every(p => /^(?:(?:也)?可能是|[为给替][他她它])/u.test(p.text));
      const nextPredicate = /^(?:也|还|同样)([\p{Script=Han}]{2})/u.exec(part.text)?.[1];
      const parallelResult = gap.length <= 2 && nextPredicate && gap.some(p => p.text.includes(nextPredicate));
      const timeFrame = gap.length <= 2 && gap.some(p => /去年|前年|当初|原先|此前|过去|后来|今年|如今/u.test(p.text));
      if ((gap.length === 1 && bindingClause.test(plain(gap[0].text))) || describesSubject || parallelResult || timeFrame) {
        for (const bridge of gap) add(bridge, bridge.text, 0);
      }
    }
    add(part, text, offset);
    prev = id;
  }
  const excerpt = readDecision({ status: 'ready', spans }, rows, offsets);
  if (!keepsRhetoric(rows.at(-1).reading, excerpt.quote) && /的.{1,5}[，,].{1,5}的/u.test(rows.at(-1).reading)) {
    const pair = verbatim(rows.at(-1));
    return pair || { status:'waiting', problem:'对仗缺少另一半' };
  }
  const choice = displayChoice(excerpt, decision.line, rows) ||
    (typeof decision.short === 'string' && decision.short !== decision.line && displayChoice(excerpt,decision.short,rows));
  if (choice) return choice;
  // The editor can cite a lead-in or the previous observation as well as the actual point.
  // Narrow only at a clause boundary, keeping the complete ending, never across a binding premise.
  const omitted = [];
  for (let i = 1; i < spans.length; i++) {
    omitted.push(spans[i - 1][1]);
    if (boundContext.test(omitted.join('')) || !clauseBreak(rows[spans[i][0] - 1].reading, offsets[i])) break;
    const first = spans[i][1], prefix = omitted.join('');
    if (dependentLead.test(first) || /(?:为的是|不是|没有说|不支持|说的是|不在于|最终取决于)[，。,:：]*$/u.test(prefix)) continue;
    const tail = spans.slice(i);
    if (!overlapsIdea(tail.map(span => span[1]).join(''), decision.line || '')) continue;
    const narrow = readDecision({ status:'ready', spans:tail }, rows, offsets.slice(i));
    const option = displayChoice(narrow, decision.line, rows);
    if (option) return option;
  }
  return { status: unfinished(rows.at(-1).reading) || dependentLead.test(rows.at(-1).reading) ? 'waiting' : 'skip',
    problem: fitsCandidate(excerpt.quote) ? '短稿未通过原意核对' : '原话超过两行，短稿未通过原意或宽度核对' };
}
function choose(decision, parts, before, last, rows) {
  const bound=boundComplement(rows);
  if (bound) return bound.status==='ready' && !fitsCandidate(bound.quote) ? {status:'waiting',problem:'否定与宾语须一起容纳，请核对原句'} : bound;
  const backup = causalReading(rows) || pairedReading(rows) || joinedAdvice(rows);
  if (backup && fitsCandidate(backup.quote)) return backup;
  let main, failure;
  try { main = selection(proofNumbers(decision), parts, before, last, rows); }
  catch(error) { failure=error; main={status:'error'}; }
  const others = [];
  for (const entry of (Array.isArray(decision.more) ? decision.more.slice(0,2) : [])) {
    try {
      const other = selection(proofNumbers(entry), parts, before, last, rows);
      if (other.status !== 'ready' || presentationIssue(other.quote)) continue;
      if (main.status !== 'ready') { main = other; continue; }
      const evidence = plain(other.quoteEvidence || other.quote);
      if ([main,...others].some(card => {
        const prior = plain(card.quoteEvidence || card.quote);
        return prior.includes(evidence) || evidence.includes(prior) || plain(card.quote) === plain(other.quote);
      })) continue;
      others.push(other);
    } catch { /* Reject only the extra point with invalid evidence. */ }
  }
  if (main.status==='error' && failure) throw failure;
  return others.length ? { ...main, more:others } : main;
}
export async function extractQuote(token, item, context = []) {
  if (partingWord.test(item.body.trim()) || isBriefReply(item, context.at(-1))) return { status: 'skip' };
  const rows = prepareReadings(correction(item) ? [item] : [...context, item], readingText);
  const current = rows.at(-1);
  const bound=boundComplement(rows);
  if (bound) return bound.status==='ready' && !fitsCandidate(bound.quote) ? {status:'waiting',problem:'否定与宾语须一起容纳，请核对原句'} : bound;
  const closed = causalReading(rows) || pairedReading(rows) || joinedAdvice(rows) || clearOriginal(current,rows.at(-2));
  if (closed && fitsCandidate(closed.quote)) return closed;
  if (bareCorrection(current)) return { status: 'waiting' };
  if (unfinished(current.reading) && !/[。！？!?].+\S/u.test(current.reading)) return { status: 'waiting' };
  const { payload, parts } = modelInput(rows, rows.length - 1);
  const at = performance.now();
  const result = await requestQuote(token, payload, singleFormat, 480);
  const received = performance.now();
  try {
    const card = choose(result, parts, 0, rows.length, rows);
    Object.defineProperties(card,{modelMs:{value:Math.round(received-at)},verifyMs:{value:Math.round(performance.now()-received)}});
    return card;
  } catch {
    throw new Error(modelProblem);
  }
}
export async function extractQuoteBatch(token, items, context) {
  if (items.every((s) => partingWord.test(s.body.trim()))) return items.map(() => ({ status: 'skip' }));
  const rows = prepareReadings([...context, ...items], readingText);
  const { payload, parts } = modelInput(rows, context.length);
  const at = performance.now();
  const result = await requestQuote(token, payload, batchFormat, 1250);
  const received = performance.now();
  if (!Array.isArray(result?.decisions)) throw new Error(modelProblem);
  const decisions = result.decisions.map(proofNumbers);
  return items.map((item, i) => {
    const index = context.length + i;
    if (bareCorrection(rows[index])) return { status: 'waiting' };
    if (partingWord.test(item.body.trim()) || isBriefReply(item, rows[index - 1])) return { status: 'skip' };
    const entries = decisions.filter((d) => d?.at === index + 1);
    try {
      if (entries.length !== 1) throw new Error();
      const start = correction(item) ? index : Math.max(0, index - contextSize);
      const checkedAt = performance.now();
      const card = choose(entries[0], parts, start, index + 1, rows.slice(start, index + 1));
      Object.defineProperties(card,{modelMs:{value:Math.round(received-at)},verifyMs:{value:Math.round(performance.now()-checkedAt)}});
      return card;
    } catch {
      return { status: 'error', problem: modelProblem };
    }
  });
}

// These checks affect only the operator's list. A complete topic-specific question remains eligible.
export function presentationIssue(quote) {
  if (incompleteCard(quote)) return 'skip';
  const text = quote.replace(/[，,。！？!?…\s]+$/u, '');
  const exchange = /^(?:(?:所以|那么|但是|其实)[，,]?)*(?:(?:[你您](?:们)?知道).{0,10}(?:为什么|为何)(?:不敢|不肯|不愿|没|没有)?(?:回答|回应)[我你您](?:方|们)?(?:的(?:问题|提问))?(?:吗|呢)?|刚才.{0,7}(?:举例|举例子|演示|演绎|示范|提过)(?:了|过)?[^，,。！？]{0,12})$/u;
  if (exchange.test(text)) return 'skip';
  // With no named subject or antecedent on the card the operator must wait for context.
  const orphanQuestion = /^(?:他|她|它)(?:们)?(?:会|能|愿意|想|要|可以).{1,6}(?:吗|呢)$/u;
  const place = /(?:在|去|到|出现于)(?:那儿|那里|那边)(?:呢|吗)?$/u;
  const vagueComparison = /^(?:而|但|所以)?这(?:个|种|样)?(?:最|更).{0,4}(?:的|地)(?:其实)?就是/u;
  const unfinishedIntroduction = /[，,。](?:我们|我方|我)(?:今天|现在|刚才|接下来)?(?:想|要)?(?:讲|说|谈|讨论)的是[我你他她这那]$/u;
  // Punctuation in a final varies even when the rendered card is identical.
  const continuous = text.replace(/[，,、\s]/gu, '');
  const vagueObject = /(?:改变|证明|说明|决定|解决)(?:了)?(?:这一切|这些事情|这件事|这个问题)$/u;
  const openAction = /(?:让|使).{1,16}(?:也)?(?:能够|能|可以)(?:去)?(?:开发|研发|实施|交付)$/u;
  if ((!/[，,。！？!?]/u.test(text) && (vagueObject.test(continuous) || openAction.test(continuous))) ||
      orphanQuestion.test(text) || place.test(text) && !/(?:从|到了|在)[\p{Script=Han}]{2,8}(?:市|省|国|区|馆|村|镇)/u.test(text) ||
      vagueComparison.test(continuous) || unfinishedIntroduction.test(text)) return 'waiting';
  const noSubject = /^(?:那|那么)?(?:意义|价值|原因|关键|答案|办法)(?:究竟|到底)?(?:是(?:什么|怎样的)|源自于?什么|从何而来|在哪里)(?:呢|吗)?$/u;
  const openObject = /(?:地|的|持续|继续)(?:带着|指向|依靠着|依赖着)$/u;
  if (noSubject.test(text) || openObject.test(text) || /因为(?:来自于|是由于)/u.test(text) ||
      unfinished(quote) || /^因为/u.test(text) && !/所以|因此|才|就/u.test(text) ||
      /^(?:可这|也违背|而且[他它][只才])/u.test(text) ||
      /(?:问回|要问|回答|讨论).{0,8}(?:这个|这一个|那个)问题$/u.test(text)) return 'waiting';
  return null;
}

export class QuoteQueue {
  constructor(store, generate, onChange, { generateBatch, quietMs = 1400, maxWaitMs = 3200, fastMs = 80 } = {}) {
    Object.assign(this, { store, generate, generateBatch, onChange, quietMs, maxWaitMs, fastMs });
    this.finalTimes = new Map();
    this.jobs = new Set();
    this.active = new Set();
    this.running = new Set();
    this.held = new Set();
    this.closed = false;
  }
  // A single microphone owns the open turn. Only confirmed rows enter held.
  collect(row) {
    if (this.closed) return;
    this.finalTimes.set(row.id,Date.now());
    if (this.last && !this.held.has(row.id) && !sameTurn(this.last, row)) this.flush();
    if (!this.held.size) this.firstAt = performance.now();
    this.held.add(row.id);
    this.jobs.delete(row.id);
    const early = completeThought(row);
    this.earlyAt = early ? performance.now() + this.fastMs : Infinity;
    this.last = row;
    this.arm();
  }
  speech(partial) {
    if (!this.last || partial.stream !== this.last.stream || partial.startMs < this.last.startMs) return;
    // Interim speaker labels can change before the final callback.
    if (this.last.speaker && partial.speaker && this.last.speaker !== partial.speaker) return;
    if (startsQualification(partial.body)) this.earlyAt = Infinity;
    this.arm();
  }
  arm() {
    clearTimeout(this.timer);
    const remaining = Math.min(this.firstAt + this.maxWaitMs, this.earlyAt) - performance.now();
    this.timer = setTimeout(() => this.flush(), Math.max(0, Math.min(this.quietMs, remaining)));
  }
  flush() {
    clearTimeout(this.timer);
    this.last = null;
    for (const id of this.held) this.release(id);
    this.held.clear();
    this.pump();
  }
  release(id) {
    if (this.store.release(id)) this.onChange(this.store.segment(id));
    this.jobs.add(id);
  }
  add(id) {
    if (this.held.has(id) || this.closed) return;
    if (!this.finalTimes.has(id)) this.finalTimes.set(id,Date.now());
    this.jobs.add(id);
    this.pump();
  }
  recover() {
    for (const { id } of this.store.pending()) {
      if (!this.held.has(id)) this.release(id);
    }
    this.pump();
  }
  async stop() {
    this.closed = true;
    clearTimeout(this.timer);
    this.held.clear();
    this.jobs.clear();
    await Promise.allSettled(this.running);
  }
  pump() {
    if (this.closed) return;
    for (const id of this.jobs) {
      if (this.running.size >= 3) return;
      if (this.active.has(id) || this.held.has(id)) continue;
      const row = this.store.segment(id);
      if (row?.status !== 'pending') {
        this.jobs.delete(id);
        continue;
      }
      const context = this.store.neighbors(row);
      // Prior final text is immutable at a given revision. Its editorial result is not an input.
      // Start the next model request independently; revisions are checked again before settlement.
      const items = [row];
      if (this.generateBatch && row.id.startsWith(row.stream + '/')) {
        for (const next of this.store.following(row)) {
          if (
            !this.jobs.has(next.id) ||
            this.active.has(next.id) ||
            next.status !== 'pending' ||
            !sameTurn(items.at(-1), next)
          )
            break;
          items.push(next);
        }
      }
      for (const item of items) {
        this.jobs.delete(item.id);
        this.active.add(item.id);
      }
      const job = this.run(items, context).finally(() => {
        for (const item of items) this.active.delete(item.id);
        this.running.delete(job);
        this.pump();
      });
      this.running.add(job);
    }
  }
  async run(items, context) {
    const start = performance.now(), startedAt = Date.now();
    let decisions;
    try {
      const edited = s => s.correctedBody == null ? s : {...s,body:s.correctedBody};
      const inputs = items.map(edited), history = context.map(edited);
      decisions =
        items.length > 1
          ? await this.generateBatch(inputs, history)
          : [await this.generate(inputs[0], history)];
      if (!Array.isArray(decisions) || decisions.length !== items.length) throw new Error(modelProblem);
    } catch (e) {
      decisions = items.map(() => ({
        status: 'error',
        problem: e instanceof Error ? e.message : '模型暂不可用',
      }));
    }
    // A late ASR correction invalidates the read of this whole turn, including an unchanged earlier row.
    if ([...context, ...items].some((s) => this.store.segment(s.id)?.rev !== s.rev)) {
      for (const s of items) if (this.store.segment(s.id)?.status === 'pending') this.jobs.add(s.id);
      return;
    }
    const latency = Math.round(performance.now() - start);
    for (const [i, row] of items.entries()) this.settle(row, decisions[i], latency, startedAt);
  }
  settle(row, generated, latency, startedAt) {
    const context = this.store.neighbors(row);
    let result =
      typeof generated === 'string' ? { status: 'ready', quote: generated } : generated || { status: 'skip' };
    const saveCard = (decision, origin, reason, witnesses = []) => {
      const ids = decision.sources?.length ? decision.sources : [row.id];
      const proof = ids.map(id=>this.store.segment(id));
      if (proof.some(r=>!r || r.correctedBy || r.status==='unconfirmed')) return;
      const issue = presentationIssue(decision.quote);
      if (issue || !fitsCandidate(decision.quote)) return;
      const frame = reportingLead(context,proof,decision.quote);
      if (!reason && frame) reason='这句话接在引述之后，请核对是谁的立场。';
      if (frame && !proof.some(r=>r.id===frame.id)) proof.unshift(frame);
      const refs = proof.map(r=>sourceRef(r));
      const card = this.store.cards.save(decision,refs,origin,reason || sourceConcern(proof),witnesses);
      this.onChange(card);
      return card;
    };
    // A short speaker change may be an interjection or a diarization error. Use only
    // the original speaker's words for this suggestion and require a human decision.
    if (/^(?:以至于|以致|所以才|因此才)/u.test(row.correctedBody ?? row.body)) {
      const prior = this.store.context(row);
      const interruption = prior.at(-1), earlier = prior.at(-2);
      if (row.speaker && interruption?.speaker && interruption.speaker !== row.speaker &&
          earlier?.speaker === row.speaker && sameTurn(earlier,row) &&
          interruption.stream === row.stream && interruption.mode === row.mode &&
          !interruption.correctedBy && interruption.status !== 'unconfirmed' &&
          !/^(?:不对|并非|不是|相反|可是|我(?:方)?(?:不同意|反对|质疑|反驳))/u.test(interruption.correctedBody ?? interruption.body) &&
          interruption.endMs - interruption.startMs <= 1800) {
        const own = [...this.store.neighbors(earlier),earlier,row];
        const closed = causalReading(own);
        if (closed && !own.some(r=>r.correctedBy) && saveCard(closed,'bridge','中间出现另一话者标签。短稿只取前后同标签的发言，请核对接续和归属。',[sourceRef(interruption)]))
          result = {status:'waiting', problem:'已有待核对的跨段短稿'};
      }
    }
    if (result.status === 'ready') {
      const main = result;
      for (const other of main.more || []) {
        saveCard(other,'additional','');
      }
      const evidence = (main.sources?.length ? main.sources : [row.id]).map(id=>this.store.segment(id)).filter(Boolean);
      const frame = reportingLead(context,evidence,main.quote);
      const reason = sourceConcern(evidence) || (frame ? '这句话接在引述之后，请核对是谁的立场。' : '');
      const attributed = frame && !evidence.some(s=>s.id===frame.id) ? {...main,sources:[frame.id,...evidence.map(s=>s.id)]} : main;
      if (reason && saveCard(attributed,'attribution',reason)) result = {status:'waiting',problem:reason};
    }
    if (result.status === 'ready') {
      const status = presentationIssue(result.quote);
      if (status) result = { status };
    }
    if (result.status === 'ready' && context.some(s => s.quote && (plain(s.quote) === plain(result.quote) ||
        plain(s.quoteEvidence || s.quote) === plain(result.quoteEvidence || result.quote))))
      result = { status: 'duplicate' };
    if (result.status === 'ready' && !fitsCandidate(result.quote))
      result = {status:'skip',problem:'原意无法放进两行，请选择原文另行提炼'};
    const sources = result.sources || [];
    const replaces =
      result.status === 'ready'
        ? context.filter(
            (s) =>
              s.status === 'ready' &&
              sources.includes(s.id) &&
              s.quote &&
              plain(result.quoteEvidence || result.quote).includes(plain(s.quoteEvidence || s.quote))
          )
        : [];
    // A later, more complete card can finish first. Attach the same reversible merge
    // used when the older request finishes first; a revision can then restore either card.
    const proof = plain(result.quoteEvidence || result.quote || '');
    const coveredBy = result.status === 'ready' && this.store.following(row, contextSize).find(s =>
      s.status === 'ready' && JSON.parse(s.sourceIds || '[]').includes(row.id) &&
      plain(s.quoteEvidence || s.quote).includes(proof));
    if (
      this.store.settle(
        row.id,
        row.rev,
        result.status,
        result.quote ?? null,
        result.problem ?? null,
        sources,
        latency,
        replaces,
        result.quoteEvidence ?? null,
        coveredBy || null
      )
    ) {
      this.store.recordTiming(row.id,row.rev,this.finalTimes.get(row.id) ?? startedAt,startedAt,generated?.modelMs ?? null,generated?.verifyMs ?? null);
      this.finalTimes.delete(row.id);
      this.onChange(this.store.segment(row.id));
      for (const s of replaces) this.onChange(this.store.segment(s.id));
    }
  }
}
