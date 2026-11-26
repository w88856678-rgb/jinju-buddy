// These changes apply only to the editor's reading copy. The transcript and its source IDs stay intact.
const thing = /(?:技术|工具|软件|系统|产品|设备|机器|程序|模型|平台|算法|机制|制度|方案|政策)(?:的[\p{Script=Han}]{1,6})?[，,]?(?:\s*它|[^，,。！？]{0,12}(?:在于|取决于)它)/u;
const actor = /(?:这位|那位|小[王李张陈]|老师|医生|同事|嘉宾|工作人员|负责人|开发者|设计师|辩手|创始人|工程师|他本人|她本人|一个人|那些人)/u;
const numberChars = '0-9零〇两一二三四五六七八九十百千万亿点';
const doubledKeep = new RegExp('[' + numberChars + '好慢快常渐仅刚远往偏恰通明白轻重人个家天年回次层处种步亲妈爸叔婶爷奶婆公姥哥姐弟妹宝娃多少大小满深静紧牢每不再]', 'u');
const lexicon = new Intl.Segmenter('zh', {granularity: 'word'});

function repairStutter(body, evidence) {
  // Require both a clear modal/verb boundary AND a separate occurrence of the intact word.
  return body.replace(/((?:可以|能够|需要|尝试|应该|想要|开始|必须|已经|正在))([\p{Script=Han}])\2([\p{Script=Han}])/gu,
    (whole, lead, syllable, next) => {
      const word = syllable + next;
      if (doubledKeep.test(syllable) || [...lexicon.segment(word)].length !== 1) return whole;
      return evidence.replaceAll(syllable + word, '').includes(word) ? lead + word : whole;
    });
}

export function prepareReadings(rows, read) {
  rows = rows.map(row => row.correctedBody == null ? row : { ...row, body:row.correctedBody });
  return rows.map((row, i) => {
    let start = i;
    // Context is bounded to already confirmed, adjacent rows. Don't borrow from a later batch item.
    while (start > 0 && i - start < 6 && rows[start - 1].speaker === row.speaker &&
      rows[start - 1].stream === row.stream && (row.speaker || row.mode === 'speech')) start--;
    const prior = rows.slice(start,i).map(r => r.body).join('');
    let body = repairStutter(read(row.body), prior + row.body);
    // Mandarin tā is acoustically identical. Only resolve it for an explicitly named object
    // with an established 它, in a parallel clause with an unambiguous non-human predicate.
    if (thing.test(body)) body = body.replace(/([，,。])他(?=(?:也|还)?(?:不需要|不用|可以|需要|能够)?(?:上架|分发|部署|安装|加载|运行|开机))/gu,
      (match, stop, offset) => {
        const left = body.slice(0,offset);
        const antecedent = thing.exec(left);
        return antecedent && !actor.test(left.slice(antecedent.index)) ? stop + '它' : match;
      });
    if (row.mode === 'speech' && thing.test(prior + body)) {
      // A classification such as “它是一个软件” identifies the referent itself.
      // Human professions (e.g. 软件工程师) do not end at the product noun.
      body = body.replace(/(^|[，,。])他(?=(?:就)?是(?:一[个套款种])?[^，,。！？]{0,14}(?:软件|工具|系统|程序|平台|设备)(?:[，,。！？!?]|$))/gu, '$1它');
    }
    if (row.mode === 'speech' && /^他(?:愿意|能够|可以|会|能否|愿不愿意)/u.test(body)) {
      const comparison = /(?:常常|往往|更多|反而|更)?(?:在于|取决于)[。，,]?$/u.test(prior);
      const last = [...prior.matchAll(new RegExp(thing.source,'gu'))].at(-1);
      if (comparison && last && prior.length - last.index <= 70 && !actor.test(prior.slice(last.index)))
        body = '它' + body.slice(1);
    }
    return { ...row, reading: body };
  });
}

const scope = /(?:不太|有条件|无条件|未必|尚未|自称|据称|只有|仅当|仅限|除非|即使|如果|假如|前提|条件是|限于|并非|并不|绝不|不代表|我方主张|对方(?:说|认为|主张)|据称|尚未证实)/u;
const precision = /(?:至少|至多|最多|最少|大约|不到|超过|不足|接近|近乎|将近|约)$/u;
export function protectedEdge(before, picked, after) {
  if (/(?:不太|有条件地?|无条件地?|即使|未必|尚未|自称|据称)$/u.test(before)) return true;
  if (precision.test(before) && new RegExp('^[' + numberChars + ']').test(picked)) return true;
  if (/(?:我|我们|他|她|他们|她们)(?:的)?$/u.test(before) && /^(?:人生|立场|经历|选择|判断|观点|经验|意义)/u.test(picked)) return true;
  if (/(?:不认为|不等于|不是|并非|不代表|不同意|不主张|没有说|不一定|未必|对方认为|对方主张|我反对|我质疑|有没有|是否|并未|还没有)$/u.test(before)) return true;
  if (/(?:是不是|应不应该|能不能|可不可以)$/u.test(before + picked) && after) return true;
  return false;
}

// Between two excerpts we may omit a complete aside or a parallel example, but not a
// qualification, new quantity, attribution, or the pivot of the argument.
export function safeGap(gap, atBreak, endsAtBreak) {
  if (/^(?:嗯|呃|额|啊|这个|那个|怎么说呢|也就是说|我想说的是|其实)*$/u.test(gap)) return true;
  if (scope.test(gap) || /[0-9零〇两一二三四五六七八九十百千万亿]|然而|可是|反而|但是|不等于|不支持|不同意|反对|否定/u.test(gap)) return false;
  return atBreak && endsAtBreak;
}

// A long card can quote one example from a repeated list leading into a contrast.
// Keep the full list whenever the items carry separate numbers, actors, or conditions.
export function shortenExamples(choices, parts) {
  const selected = choices.map(choice => {
    const [id, sub] = Array.isArray(choice) ? choice : [choice];
    const part = parts[id - 1];
    return { id, row: part?.row, text: sub ?? part?.text ?? '' };
  });
  const quote = selected.map(x => x.text).join('');
  if (quote.length < 65 || !/[，。；](?:但|可是|可这|却|而是|反而)/u.test(quote)) return choices;
  const keep = choices.slice();
  const predicate = text => /^(?:我|你|它)?(?:也|还)?(不需要|不用|想要|希望|例如|比如)/u.exec(text)?.[1];
  for (let i = 0; i < selected.length; i++) {
    const first = selected[i], verb = predicate(first.text);
    if (!verb) continue;
    let end = i + 1;
    while (end < selected.length && selected[end].row === first.row &&
      selected[end].id === selected[end - 1].id + 1 && predicate(selected[end].text) === verb) end++;
    const examples = selected.slice(i + 1, end);
    if (examples.length >= 2 && examples.every(x =>
      !/[我你他她它\d零〇两一二三四五六七八九十百千万亿]|至少|至多|不仅|同时|必须|否则|分别|才/u.test(x.text) &&
      !scope.test(x.text))) keep.fill(null, i + 1, end);
    i = end - 1;
  }
  return keep.filter(x => x !== null);
}

export function stagePunctuation(quote, multi) {
  let line = quote.trim().replace(/^(?:所以我们说|其实我想说的是|我想表达的是)[，,、 ]*/u, '');
  // A symmetric "you or I" digression can precede the actual demonstrative subject.
  line = line.replace(/^(?:可能)?(?:你|我)([\p{Script=Han}]{1,5}的)(?:或者|或)(?:我|你)\1((?:那|这)个[\p{Script=Han}]{1,8}[，,])(?=[它其])/u, '$2');
  // An answer sometimes repeats the predicate supplied by the moderator's question.
  const answer = /^(源自于|来源于|来自于|原因在于)(.{2,55}(?:不在于|并非|不是).{1,40}?)[。；，,]\1/u.exec(line);
  if (answer) line = line.slice(answer[1].length);
  if (multi) line = line
    // The next clause restarts the same object and abandons an ASR tail ("…的带着。").
    .replace(/([\p{Script=Han}]{2})(?:持续|继续|不断|一直)(?:地|的)(?:带着|对着|指着|拿着)[。；，](?=[^，。！？]{1,22}\1)/gu, '$1，')
    .replace(/(或者对|对于|在于|取决于|源自于|意味着)[。，,]+(?=[\p{Script=Han}\d])/gu, '$1')
    .replace(/[。；](?=(?:倒)?往往在于|源自于|也违背|因为|但(?:是)?|却)/gu, '，');
  return line.replace(/(不在于[^，。！？]{1,45}[，。；])倒(?=往往在于)/gu, '$1');
}
