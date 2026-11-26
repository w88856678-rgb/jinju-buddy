// Extra ideas and selected passages refer to transcript revisions. They never become
// transcript rows or enter ASR context. Source checks also protect historical replays.
import { createHash } from 'node:crypto';
import { needsAttribution, suspiciousParallel, reported } from './quote-integrity.js';
const conflict = message => Object.assign(new Error(message), {status:409});
const invalid = message => Object.assign(new Error(message), {status:400});
export const sourceRef = (row, start = 0, end = (row.correctedBody ?? row.body).length) =>
  ({id:row.id, rev:row.rev, start, end});
export class EditorCards {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS editor_cards(id TEXT PRIMARY KEY,card TEXT NOT NULL); CREATE TABLE IF NOT EXISTS editor_sources(source TEXT,card TEXT,PRIMARY KEY(source,card))');
  }
  resolve(refs, manual = false) {
    if (!Array.isArray(refs) || !refs.length || refs.length > 12) throw invalid('请选择 1 至 12 段定稿');
    const ids = new Set();
    let length = 0;
    const result = refs.map(ref => {
      if (!ref || typeof ref.id !== 'string' || ids.has(ref.id)) throw invalid('选区有重复或无效的发言');
      ids.add(ref.id);
      const row = this.store.segment(ref.id);
      if (!row || row.rev !== ref.rev || row.status === 'unconfirmed' || row.correctedBy)
        throw conflict('选中的发言已更新或正在更正，请重新选择');
      const body = row.correctedBody ?? row.body;
      if (!Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start < 0 || ref.end > body.length || ref.start >= ref.end) throw invalid('选区超出定稿范围');
      const selected = body.slice(ref.start,ref.end);
      if (manual && (/(?:不太|有条件地?|无条件地?|未必|尚未|并不|仅限|绝不|不|没|未)$/u.test(body.slice(0,ref.start)) ||
          /[\d点]$/u.test(body.slice(0,ref.start)) && /^[\d点]/u.test(selected) ||
          /[\d点]$/u.test(selected) && /^(?:[\d点]|%|％|个百分点|万|亿)/u.test(body.slice(ref.end))))
        throw invalid('请把否定、限定词或完整数字一起选入');
      if (manual) {
        const prefix=body.slice(0,ref.start).split(/[。！？!?]/u).at(-1);
        const tail=body.slice(ref.end).replace(/^[，,；;\s]+/u,'');
        if ((!reported.test(prefix) && /(?:如果|假如|除非|只有在|仅在|前提是|我(?:不认为|反对))[^。！？!?]*[，,；;]/u.test(prefix)) ||
            /^(?:但(?:是)?(?:只|不代表|并不|不能|未必)|除非|前提是|仅限|仅适用|不等于|而不是)/u.test(tail))
          throw invalid('选区缺少相关条件或限定，请一起选入');
      }
      length += selected.length;
      return {...row, body:selected, correctedBody:null, sourceBody:body};
    });
    if (manual && result.length>1) {
      const following=this.store.following(result[0],result.length-1);
      if (result.slice(1).some((row,i)=>following[i]?.id!==row.id) ||
          refs.some((ref,i)=>i>0 && ref.start!==0 || i<refs.length-1 && ref.end!==result[i].sourceBody.length))
        throw invalid('请选择连续的定稿文字');
    }
    if (manual && (length > 1600 || new Set(result.map(r=>r.stream)).size > 1 ||
        result.some((r,i)=>i && (r.startMs < result[i-1].startMs || r.startMs - result[i-1].endMs > 15000))))
      throw invalid('请选择同一轮发言中相邻的文字，最多 1600 字');
    return result;
  }
  save(result, refs, origin, reason = '', witnesses = []) {
    const rows = this.resolve(refs);
    // A source outside the cited words can still determine attribution (a short interruption).
    this.resolve(witnesses.length ? witnesses : refs);
    const key = JSON.stringify([origin,refs,result.quote,witnesses]);
    const id = 'editor-' + createHash('sha256').update(key).digest('hex').slice(0,32);
    const existing = this.get(id);
    if (existing) return existing;
    const last = rows.at(-1);
    const card = { id, rev:1, extra:true, origin, status:reason ? 'review' : 'ready', reason,
      startMs:last.startMs, endMs:last.endMs, speaker:last.speaker, role:last.role, mode:last.mode,
      refs, witnesses, sourceIds:JSON.stringify(rows.map(r=>r.id)), body:rows.map(r=>r.body).join('\n'),
      quote:result.quote, quoteEvidence:result.quoteEvidence || null };
    this.store.transaction(() => {
      this.db.prepare('INSERT INTO editor_cards VALUES(?,?)').run(id,JSON.stringify(card));
      const link = this.db.prepare('INSERT OR IGNORE INTO editor_sources VALUES(?,?)');
      for (const ref of [...refs,...witnesses]) link.run(ref.id,id);
    });
    return card;
  }
  verify(card) {
    try {
      this.resolve(card.refs);
      if (card.witnesses?.length) this.resolve(card.witnesses);
    } catch {
      return { ...card, status:'withdrawn', reason:'原发言已更新，请按新定稿核对。' };
    }
    return card;
  }
  get(id) {
    const item = this.db.prepare('SELECT card FROM editor_cards WHERE id=?').get(id);
    return item && this.verify(JSON.parse(item.card));
  }
  all() {
    return this.db.prepare('SELECT card FROM editor_cards').all().map(r=>this.verify(JSON.parse(r.card)));
  }
  affected(id) {
    return this.db.prepare('SELECT card FROM editor_sources WHERE source=?').all(id).map(r=>this.get(r.card));
  }
  replaceAlternatives(chosen) {
    if (chosen.origin !== 'selection' || chosen.status !== 'ready') return [];
    const ids = new Set(chosen.refs.map(r=>r.id));
    const flat = value => value.replace(/[\p{P}\s]/gu,'');
    const grams = value => new Set([...flat(value).matchAll(/(?=(..))/gu)].map(m=>m[1]));
    const picked = grams(chosen.quote), gone = [];
    const contenders = new Set(chosen.refs.flatMap(ref=>this.db.prepare('SELECT card FROM editor_sources WHERE source=?').all(ref.id).map(r=>r.card)));
    for (const id of contenders) {
      if (id===chosen.id) continue;
      const old=this.get(id);
      if (old.status!=='review' || !old.refs.every(ref=>ids.has(ref.id))) continue;
      const other=grams(old.quote);
      const overlap=[...other].filter(g=>picked.has(g)).length;
      if (!other.size || overlap/Math.max(other.size,picked.size)<0.60) continue;
      const replaced={...old,status:'merged',rev:old.rev+1};
      this.db.prepare('UPDATE editor_cards SET card=? WHERE id=?').run(JSON.stringify(replaced),id);
      gone.push(replaced);
    }
    return gone;
  }
  approve(id, rev) {
    const card = this.get(id);
    if (!card || card.rev !== rev || card.status !== 'review') throw conflict('候选或原发言已更新，请重新核对');
    const approved = {...card, rev:card.rev+1, status:'ready', reviewed:true};
    this.db.prepare('UPDATE editor_cards SET card=? WHERE id=?').run(JSON.stringify(approved),id);
    return approved;
  }
}
export function sourceConcern(rows) {
  if (new Set(rows.map(r=>r.speaker)).size > 1 || rows.some(r=>!r.speaker && r.mode==='debate' && r.stream !== r.id))
    return '所选文字跨话者标签或归属未明。只有确认这些话属于同一人、同一立场时才继续。';
  if (rows.some(r=>(/([\p{Script=Han}])\1{2,}.{0,3}(?:\d|[零〇两一二三四五六七八九十百千万亿]+(?:户|人|秒|元|次|天))/u).test(r.sourceBody ?? r.correctedBody ?? r.body)))
    return '数字附近有连续重复音节，请听原声核对数量和单位。';
  if (rows.some(r=>suspiciousParallel(r.sourceBody ?? r.correctedBody ?? r.body))) return '并列主语的识别用词存疑，请听原声核对。';
  if (needsAttribution(rows.map(r=>({...r,body:r.sourceBody ?? r.body})))) return '这段含转述、设想或待核词，请确认发言归属和用词。';
  return '';
}

// Resolve a dangling quote introduction on the same turn (“对方认为，…”).
// Claiming the quotation as one's own requires an operator's attribution check.
export function reportingLead(previous, selected, quote) {
  if (/对方(?:说|主张|认为|声称|提出)|据.{1,10}(?:称|说)|我(?:方)?(?:反驳|反对|不同意)/u.test(quote)) return null;
  const first = selected[0];
  if (!first) return null;
  const preceding = previous.filter(r=>r.startMs<=first.startMs && !selected.some(s=>s.id===r.id)).slice(-2);
  const frame = /(?:对方|有人|他|她)(?:的(?:观点|主张|看法|意思)是|(?:给出|提出)的(?:方案|解释|方向|结论)是|(?:主张|声称|认为|说))[，,：:。]?$|(?:他|她)可能会(?:说|问)[，,：:。]?$/u;
  const embedded = /(?:我听到|转述|援引|引用)(?:对方|他|她|有人)(?:的说法|的观点|说|认为)/u;
  return [...preceding,...selected].reverse().find(r=>frame.test(r.correctedBody ?? r.body) || embedded.test(r.correctedBody ?? r.body)) || null;
}
