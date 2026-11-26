import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { clock, maxQuote, quoteText, speakerName } from '../public/format.js';
import { EditorCards } from './editor-cards.js';
import { incompleteCard } from './quote-integrity.js';
import { candidateLayout } from './quote-fit.js';
import { correctionTargets, isCorrection } from './speech-cues.js';

const selectSegment = `SELECT s.rowid AS sequence, s.id, s.speaker, s.startMs, s.endMs, s.body, s.rev, s.quote, s.problem, s.overrideRole,
  tim.finalAt, tim.startedAt, tim.modelMs, tim.verifyMs, tim.finishedAt, c.later AS correctedBy, c.confirmed AS confirmedCorrection,
  CASE WHEN s.status='ready' AND c.later IS NOT NULL THEN CASE c.confirmed WHEN 1 THEN 'withdrawn' ELSE 'checking' END
  WHEN s.status='ready' AND EXISTS (
    SELECT 1 FROM quote_replacements x JOIN segments later ON later.id=x.later
    LEFT JOIN speech_details ld ON ld.id=later.id
    WHERE x.earlier=s.id AND x.earlierRev=s.rev AND x.laterRev=later.rev AND later.status='ready'
    AND NOT EXISTS (SELECT 1 FROM speech_corrections b WHERE b.earlier IN
      (SELECT later.id UNION ALL SELECT value FROM json_each(ld.sources)))
  ) THEN 'merged' ELSE s.status END AS status, coalesce(s.overrideRole, r.role, '待确认') AS role,
  d.stream, d.mode, d.sources AS sourceIds, d.latencyMs, d.review, qe.excerpt AS quoteEvidence,
  e.correctedBody, coalesce(e.excluded, 0) AS excluded, coalesce(e.version, 0) AS editVersion
  FROM segments s LEFT JOIN editorial_timing tim ON tim.id=s.id AND tim.rev=s.rev LEFT JOIN speakers r ON r.speaker = s.speaker
  LEFT JOIN transcript_edits e ON e.id = s.id LEFT JOIN speech_details d ON d.id = s.id
  LEFT JOIN quote_evidence qe ON qe.id=s.id AND qe.rev=s.rev
  LEFT JOIN speech_corrections c ON c.rowid=(SELECT b.rowid FROM speech_corrections b
    WHERE b.earlier IN (SELECT s.id UNION ALL SELECT value FROM json_each(d.sources))
    ORDER BY b.confirmed DESC,b.rowid DESC LIMIT 1)`;
const order = ' ORDER BY s.startMs, s.endMs, s.rowid';
export const contextSize = 6;

function displayScreen(screen) {
  if (screen.kind !== 'quote') return screen;
  const text = quoteText(screen.text);
  return text ? { ...screen, text, layout:screen.layout || candidateLayout(screen.text) } : { kind: 'idle', version: screen.version, publishedAt: screen.publishedAt };
}

// Unknown speakers can only be joined in the explicitly selected single-guest mode.
export function sameTurn(a, b) {
  if (a && b && a.mode === 'debate') {
    const before = a.correctedBody ?? a.body ?? '', now = b.correctedBody ?? b.body ?? '';
    if (/[？?]$/u.test(before) && /^(?:不对[，,]|不是[，,]|(?:我方|我们)(?:说的是|从未说|并没|主张|回应)|对方辩友(?:刚才|明显|显然))/u.test(now)) return false;
  }
  return Boolean(a && b && a.stream && a.stream === b.stream && a.mode === b.mode &&
    a.speaker === b.speaker && (a.speaker || a.mode === 'speech') &&
    a.status !== 'unconfirmed' && b.status !== 'unconfirmed' &&
    a.startMs <= b.startMs && b.startMs - a.endMs <= 6500);
}

export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'activity.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=4000;
      CREATE TABLE IF NOT EXISTS editorial_timing(id TEXT PRIMARY KEY,rev INTEGER,finalAt INTEGER,startedAt INTEGER,modelMs INTEGER,verifyMs INTEGER,finishedAt INTEGER);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS removed_qr(slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS speakers(speaker TEXT PRIMARY KEY, role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS segments(
        id TEXT PRIMARY KEY, speaker TEXT, startMs INTEGER NOT NULL, endMs INTEGER NOT NULL,
        body TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending',
        quote TEXT, problem TEXT, overrideRole TEXT
      );
      CREATE TABLE IF NOT EXISTS quote_evidence(id TEXT PRIMARY KEY, rev INTEGER NOT NULL, excerpt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quote_replacements(
        earlier TEXT, earlierRev INTEGER, later TEXT, laterRev INTEGER, PRIMARY KEY(earlier,later)
      );
      CREATE INDEX IF NOT EXISTS quote_later ON quote_replacements(later);
      CREATE TABLE IF NOT EXISTS speech_details(
        id TEXT PRIMARY KEY, stream TEXT, mode TEXT, sources TEXT, latencyMs INTEGER, review TEXT
      );
      CREATE INDEX IF NOT EXISTS segment_time ON segments(startMs, endMs);
      CREATE TABLE IF NOT EXISTS transcript_edits(
        id TEXT PRIMARY KEY, correctedBody TEXT, excluded INTEGER NOT NULL, version INTEGER NOT NULL
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(speech_details)').all().some(c => c.name === 'review'))
      this.db.exec('ALTER TABLE speech_details ADD COLUMN review TEXT');
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='speech_corrections'").get()) {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS speech_corrections(
          earlier TEXT NOT NULL, later TEXT NOT NULL, confirmed INTEGER NOT NULL, PRIMARY KEY(earlier,later));
          CREATE INDEX IF NOT EXISTS correction_later ON speech_corrections(later);`);
        for (const row of this.db.prepare("SELECT id,body FROM segments WHERE status<>'unconfirmed'").all())
          if (isCorrection(row.body)) this.updateCorrection(this.segment(row.id), true);
      });
    }
    this.cards = new EditorCards(this);
    // An interim hypothesis cannot be resumed after its microphone connection has gone away.
    this.db.exec('DELETE FROM speech_corrections WHERE confirmed=0');
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db
      .prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  screen() {
    return displayScreen(this.get('screen', { kind: 'idle', version: 0 }));
  }
  transaction(change) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = change();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  once(op, change) {
    return this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(op)) {
        change();
        this.db.prepare('INSERT INTO operations VALUES(?)').run(op);
      }
      return this.screen();
    });
  }
  qrState() {
    return {
      lastQr: this.get('lastQr'),
      qrRevision: this.get('qrRevision', 0),
      canRestoreQr: Boolean(this.db.prepare('SELECT 1 FROM removed_qr WHERE slot=1').get()),
    };
  }
  checkQrRevision(expected) {
    if (expected !== this.get('qrRevision', 0))
      throw Object.assign(new Error('二维码已在其他操作中更新，请核对后重试'), { status: 409 });
  }
  saveScreen(content) {
    if (content.kind === 'quote') {
      const text = quoteText(content.text);
      if (!text || [...text].length > maxQuote)
        throw Object.assign(new Error('请输入 1 至 320 字的金句'), { status: 400 });
      const layout = content.layout || candidateLayout(content.text, content.compact === true);
      if (!layout) throw Object.assign(new Error('超出 LED 两行，请精简后再发送。'), {status:400});
      content = { ...content, text, layout };
    }
    const previous = this.screen();
    const same = (item, other) => item.kind === other.kind && item.text === other.text && JSON.stringify(item.layout?.lines) === JSON.stringify(other.layout?.lines) && item.image === other.image && Boolean(item.adapted) === Boolean(other.adapted);
    const history = this.get('screenHistory', []).map(displayScreen)
      .filter((item) => !same(item, previous) && !same(item, content));
    if (!same(previous, content)) history.unshift(previous);
    this.set('screenHistory', history.slice(0, 6));
    this.set('screen', { ...content, version: previous.version + 1, publishedAt: Date.now() });
  }
  history() {
    const exists = this.db.prepare('SELECT 1 FROM images WHERE id=?');
    return this.get('screenHistory', []).filter((s) => s.kind !== 'qr' || exists.get(s.image)).map(displayScreen);
  }
  replay(op, version, currentVersion) {
    return this.once(op, () => {
      const item = this.history().find((s) => s.version === version);
      if (!item || this.screen().version !== currentVersion)
        throw Object.assign(new Error('发布记录已更新，请核对后再恢复'), { status: 409 });
      if (item.candidate) this.checkCandidate(item.candidate, true);
      const { version: ignored, publishedAt, ...content } = item;
      this.saveScreen(content);
    });
  }
  publish(op, content, image, expectedRevision) {
    return this.once(op, () => {
      if (content?.candidate) {
        const row = this.checkCandidate(content.candidate);
        const text = content.text === undefined ? row.quote : content.text;
        if (!candidateLayout(text, content.compact === true)) throw Object.assign(new Error('候选超出 LED 两行或没有可显示文字，请编辑后发送。'), { status: 400 });
        const adapted = row.quoteEvidence || quoteText(text) !== quoteText(row.quote);
        content = { ...content, text, ...(adapted ? { adapted: true } : {}) };
      }
      if (expectedRevision !== undefined) this.checkQrRevision(expectedRevision);
      if (image) {
        const id = createHash('sha256').update(image).digest('hex');
        this.db.prepare('INSERT OR IGNORE INTO images VALUES(?,?)').run(id, image);
        this.db.exec('DELETE FROM removed_qr');
        this.set('lastQr', id);
        this.set('qrRevision', this.get('qrRevision', 0) + 1);
        content = { kind: 'qr', image: id };
      }
      this.saveScreen(content);
    });
  }
  checkCandidate(ref, fromHistory = false) {
    const row = ref.id.startsWith('editor-') ? this.cards.get(ref.id) : this.segment(ref.id);
    let message;
    if (row?.correctedBy) message = row.confirmedCorrection ? '发言人已更正，这条旧候选不能发送' : '正在核对发言人的改口，请稍候';
    else if (row && (!row.extra && incompleteCard(row.quote || '') || row.status === 'review')) message = '请先核对候选和原发言';
    else if (!row || row.rev !== ref.rev || (row.status !== 'ready' && !(fromHistory && row.status === 'merged')))
      message = '候选已更新，请核对后再发';
    if (message) throw Object.assign(new Error(message), { status: 409 });
    return row;
  }
  changeQr(op, action, expectedRevision) {
    return this.once(op, () => {
      this.checkQrRevision(expectedRevision);
      const id = this.get('lastQr');
      if (action === 'remove') {
        if (!id) throw Object.assign(new Error('当前没有可删除的二维码'), { status: 409 });
        const moved = this.db
          .prepare('INSERT OR REPLACE INTO removed_qr SELECT 1, id, bytes FROM images WHERE id=?')
          .run(id);
        if (!moved.changes) throw new Error('缺少二维码图片');
        this.db.prepare('DELETE FROM images WHERE id=?').run(id);
        this.set('lastQr', null);
        const screen = this.screen();
        if (screen.kind === 'qr' && screen.image === id) this.saveScreen({ kind: 'idle' });
      } else {
        const removed = this.db.prepare('SELECT id FROM removed_qr WHERE slot=1').get();
        if (id || !removed) throw Object.assign(new Error('当前没有可恢复的二维码'), { status: 409 });
        this.db.exec('INSERT INTO images SELECT id, bytes FROM removed_qr; DELETE FROM removed_qr;');
        this.set('lastQr', removed.id);
      }
      this.set('qrRevision', expectedRevision + 1);
    });
  }
  image(id) {
    return this.db.prepare('SELECT bytes FROM images WHERE id=?').get(id)?.bytes;
  }
  timeOffset() {
    let start = this.get('start');
    if (start === null) {
      start = Date.now();
      this.set('start', start);
    }
    return Math.max(0, Date.now() - start);
  }
  nextGroup() {
    const next = this.get('group', 0) + 1;
    this.set('group', next);
    return next;
  }
  segment(id) {
    return this.db.prepare(selectSegment + ' WHERE s.id=?').get(id);
  }
  segments() {
    return this.db.prepare(selectSegment + order).all();
  }
  context(item) {
    return this.db
      .prepare(
        selectSegment +
          ` WHERE (s.startMs, s.rowid) < (?, (SELECT rowid FROM segments WHERE id=?))
          ORDER BY s.startMs DESC, s.rowid DESC LIMIT ?`
      )
      .all(item.startMs, item.id, contextSize)
      .reverse();
  }
  neighbors(item) {
    if (!item.stream || (!item.speaker && item.mode !== 'speech')) return [];
    const prior = this.context(item).reverse();
    const adjacent = [];
    let next = item;
    for (const row of prior) {
      if (item.startMs - row.endMs > 40000 || row.correctedBy || !sameTurn(row, next)) break;
      adjacent.unshift(row);
      next = row;
    }
    return adjacent;
  }
  following(row, limit = 3) {
    return this.db.prepare(selectSegment + `
      WHERE (s.startMs, s.rowid) > (?, (SELECT rowid FROM segments WHERE id=?))
      ORDER BY s.startMs, s.rowid LIMIT ?`).all(row.startMs, row.id, limit);
  }
  affected(row) {
    if (!row.stream) return [];
    // A revision can introduce a new speaker between previously joined fragments.
    return this.following(row, contextSize).filter((s) => s.stream === row.stream && s.status !== 'unconfirmed');
  }
  replacedRows(id) {
    return this.db.prepare('SELECT earlier FROM quote_replacements WHERE later=?').all(id)
      .map(r => this.segment(r.earlier));
  }
  invalidate(id) {
    this.db.prepare("UPDATE segments SET rev=rev+1,status=CASE WHEN status='collecting' THEN status ELSE 'pending' END,quote=NULL,problem=NULL WHERE id=?").run(id);
    this.db.prepare("UPDATE speech_details SET sources=NULL,latencyMs=NULL WHERE id=?").run(id);
    return this.segment(id);
  }
  updateCorrection(row, confirmed) {
    const old = this.db.prepare('SELECT earlier,confirmed FROM speech_corrections WHERE later=?').all(row.id);
    if (!confirmed && old.some(link => link.confirmed)) return [];
    let targets = [];
    if (row.stream && (row.speaker || row.mode === 'speech') && isCorrection(row.body)) {
      let speaker = row.speaker;
      if (!confirmed && !speaker && row.mode === 'speech') {
        // Tencent usually labels an interim as -1. A single recent speaker in a talk
        // can be held temporarily. Only the final callback can confirm a withdrawal.
        const recent = this.db.prepare(`SELECT DISTINCT s.speaker FROM segments s
          JOIN speech_details d ON d.id=s.id WHERE d.stream=? AND d.mode=?
          AND s.endMs>=? AND s.startMs<=? AND s.id<>? AND s.status<>'unconfirmed' LIMIT 2`)
          .all(row.stream, row.mode, row.startMs - 30000, row.startMs, row.id);
        if (recent.length === 1) speaker = recent[0].speaker;
      }
      // A resumed Tencent connection can keep its voice group. Anonymous speech is local to one stream.
      const resumed = Boolean(row.speaker && row.stream !== 'paste');
      const prior = this.db.prepare(`SELECT s.id,COALESCE(e.correctedBody,s.body) AS body,s.endMs FROM segments s JOIN speech_details d ON d.id=s.id LEFT JOIN transcript_edits e ON e.id=s.id
        WHERE (d.stream=? OR (? AND d.stream<>'paste')) AND d.mode=? AND s.speaker IS ?
        AND (s.startMs,s.rowid)<(?,COALESCE((SELECT rowid FROM segments WHERE id=?),9223372036854775807)) AND s.status<>'unconfirmed'
        ORDER BY s.startMs DESC,s.rowid DESC`).all(row.stream, Number(resumed), row.mode, speaker, row.startMs, row.id);
      targets = correctionTargets(row, prior);
      if (!confirmed && !targets.length && old.length) {
        // “刚才我口误，说成了…” is still developing. Keep the hold within this
        // speaker's scope until the hypothesis retracts or names a different fact.
        const eligible = new Set(prior.map(s => s.id));
        targets = old.filter(link => eligible.has(link.earlier)).map(link => link.earlier);
      }
    }
    if (old.length === targets.length && old.every(x => x.confirmed === Number(confirmed) && targets.includes(x.earlier))) return [];
    this.db.prepare('DELETE FROM speech_corrections WHERE later=?').run(row.id);
    const put = this.db.prepare('INSERT INTO speech_corrections VALUES(?,?,?)');
    for (const target of targets) put.run(target, row.id, Number(confirmed));
    const touched = [...new Set([...old.map(x => x.earlier), ...targets])];
    const json = JSON.stringify(touched);
    const dependents = this.db.prepare(`SELECT id FROM speech_details d WHERE d.sources IS NOT NULL AND EXISTS
      (SELECT 1 FROM json_each(d.sources) WHERE value IN (SELECT value FROM json_each(?)))`).all(json);
    for (const d of dependents) touched.push(d.id);
    for (const later of new Set(touched))
      touched.push(...this.db.prepare('SELECT earlier FROM quote_replacements WHERE later=?').all(later).map(link => link.earlier));
    return [...new Set(touched)];
  }
  draftCorrection(row) {
    return this.transaction(() => this.updateCorrection(row, false).map(id => this.segment(id)));
  }
  upsert({ id, speaker = null, startMs, endMs, body, stream = null, mode = 'debate', provisional = false, collecting = false, review = null }) {
    return this.transaction(() => {
      const row = this.segment(id);
      if (row && (row.status === 'unconfirmed') === provisional && row.body === body && row.speaker === speaker && row.startMs === startMs && row.endMs === endMs)
        return null;
      // A later correction can also release an earlier idea that the batch left waiting.
      const revisit = row ? this.neighbors(row).filter(s => ['waiting', 'skip', 'duplicate'].includes(s.status)) : [];
      const previousNeighbors = row ? [...revisit, ...this.affected(row)].map(s => s.id) : [];
      const hold = collecting && (!row || row.status === 'collecting' || row.status === 'unconfirmed');
      const status = provisional ? 'unconfirmed' : hold ? 'collecting' : 'pending';
      this.db
        .prepare(
          `INSERT INTO segments(id,speaker,startMs,endMs,body,status) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET speaker=excluded.speaker, startMs=excluded.startMs, endMs=excluded.endMs,
        body=excluded.body, rev=segments.rev+1, status=excluded.status, quote=NULL, problem=NULL`
        )
        .run(id, speaker, startMs, endMs, body, status);
      this.db.prepare(`INSERT INTO speech_details(id,stream,mode,review) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET stream=excluded.stream,mode=excluded.mode,review=excluded.review,sources=NULL,latencyMs=NULL`)
        .run(id, stream, mode, review);
      const saved = this.segment(id);
      if (!provisional) {
        const changed = new Set([...previousNeighbors, ...this.affected(saved).map(s => s.id)]);
        if (changed.size) saved.invalidated = [...changed].map(key => this.invalidate(key));
      }
      const changedBlocks = new Set(this.updateCorrection(provisional ? { ...saved, body: '' } : saved, !provisional));
      // Reconcile a late final, or a revision that changes the text or owner of earlier evidence.
      if (!provisional && stream) {
        const later = this.db.prepare(`SELECT s.id,s.body FROM segments s JOIN speech_details d ON d.id=s.id
          WHERE ((d.stream=? AND s.startMs>=?) OR s.id IN (SELECT later FROM speech_corrections WHERE earlier=?))
          AND s.id<>? AND s.status<>'unconfirmed'`).all(stream, startMs, id, id);
        for (const next of later.filter(s => isCorrection(s.body))) {
          for (const changed of this.updateCorrection(this.segment(next.id), true)) changedBlocks.add(changed);
        }
      }
      if (changedBlocks.size) saved.correctionUpdates = [...changedBlocks].map(key => this.segment(key));
      return saved;
    });
  }
  paste(body, speaker, id = randomUUID(), mode = 'debate') {
    const ms = this.timeOffset();
    return this.upsert({ id, speaker, startMs: ms, endMs: ms, body, stream: speaker ? 'paste' : id, mode });
  }
  settle(id, rev, status, quote, problem, sources = [], latencyMs = null, replaces = [], quoteEvidence = null, coveredBy = null) {
    return this.transaction(() => {
      const changed = (
        this.db
          .prepare('UPDATE segments SET status=?, quote=?, problem=? WHERE id=? AND rev=?')
          .run(status, quote, problem, id, rev).changes > 0
      );
      if (changed) this.db.prepare('UPDATE speech_details SET sources=?,latencyMs=? WHERE id=?')
        .run(JSON.stringify(sources), latencyMs, id);
      if (changed && quoteEvidence && status === 'ready') {
        this.db.prepare('INSERT OR REPLACE INTO quote_evidence(id,rev,excerpt) VALUES(?,?,?)').run(id, rev, quoteEvidence);
      } else if (changed) {
        this.db.prepare('DELETE FROM quote_evidence WHERE id=?').run(id);
      }
      if (changed && (replaces.length || coveredBy)) {
        const link = this.db.prepare('INSERT OR REPLACE INTO quote_replacements VALUES(?,?,?,?)');
        for (const s of replaces) link.run(s.id, s.rev, id, rev);
        if (coveredBy) link.run(id, rev, coveredBy.id, coveredBy.rev);
      }
      return changed;
    });
  }
  recordTiming(id,rev,finalAt,startedAt,modelMs,verifyMs) {
    this.db.prepare('INSERT OR REPLACE INTO editorial_timing VALUES(?,?,?,?,?,?,?)').run(id,rev,finalAt,startedAt,modelMs,verifyMs,Date.now());
  }
  release(id) {
    return this.db.prepare("UPDATE segments SET status='pending' WHERE id=? AND status='collecting'").run(id).changes > 0;
  }
  pending() {
    return this.db.prepare("SELECT id FROM segments WHERE status IN ('pending','collecting') ORDER BY startMs,rowid").all();
  }
  retry() {
    this.db.exec("UPDATE segments SET status='pending',problem=NULL WHERE status='error'");
  }
  mapping() {
    return Object.fromEntries(
      this.db
        .prepare('SELECT speaker, role FROM speakers')
        .all()
        .map((r) => [r.speaker, r.role])
    );
  }
  assign(speaker, role) {
    this.db.prepare('INSERT OR REPLACE INTO speakers VALUES(?,?)').run(speaker, role);
  }
  override(id, role) {
    this.db.prepare('UPDATE segments SET overrideRole=? WHERE id=?').run(role, id);
  }
  editTranscript(row, text, excluded, rev, editVersion) {
    const correctedBody = text === row.body ? null : text;
    if (row.rev !== rev || row.editVersion !== editVersion) {
      if ((row.rev === rev || row.rev === rev + 1) && correctedBody === row.correctedBody && excluded === Boolean(row.excluded)) return row;
      throw Object.assign(new Error('这段发言已有更新，请核对最新原文后再保存'), { status: 409 });
    }
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO transcript_edits VALUES(?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET correctedBody=excluded.correctedBody, excluded=excluded.excluded,
        version=transcript_edits.version+1`).run(row.id,correctedBody,Number(excluded));
      if (correctedBody === row.correctedBody || row.status === 'unconfirmed') return this.segment(row.id);
      const linked = this.db.prepare(`SELECT d.id FROM speech_details d,json_each(d.sources) src WHERE src.value=?`).all(row.id);
      const affected = new Set([...linked,...this.affected(row)].map(r=>r.id));
      affected.delete(row.id);
      const updated = this.invalidate(row.id);
      updated.invalidated = [...affected].map(id=>this.invalidate(id));
      updated.correctionUpdates = this.updateCorrection({...updated,body:text},true).map(id=>this.segment(id));
      return updated;
    });
  }
  liveTranscriptBoundary() {
    return this.get('liveTranscriptBoundary', { revision: 0, through: 0, draftIds: [] });
  }
  clearLiveTranscript(expectedRevision, draftIds) {
    return this.transaction(() => {
      const current = this.liveTranscriptBoundary();
      // A retry or an older dialog must not clear speech received after another desk's confirmation.
      if (expectedRevision < current.revision) return current;
      if (expectedRevision > current.revision)
        throw Object.assign(new Error('活动记录已更新，请刷新控台后重试'), { status: 409 });
      const { through } = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS through FROM segments').get();
      const next = { revision: current.revision + 1, through, draftIds };
      this.set('liveTranscriptBoundary', next);
      return next;
    });
  }
  transcript(name) {
    return (
      '\uFEFF' +
      name +
      ' · 完整逐字稿\n\n' +
      this.segments()
        .filter((s) => !s.excluded)
        .map(
          (s) =>
            '[' +
            clock(s.startMs) +
            '–' +
            clock(s.endMs) +
            '] ' +
            (s.status === 'unconfirmed' ? '〔临时稿待核对〕' : '') + speakerName(s.speaker) +
            '｜' +
            s.role +
            '　' +
            (s.correctedBody ?? s.body)
        )
        .join('\n') +
      '\n'
    );
  }
}
