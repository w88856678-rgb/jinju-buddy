import http from 'node:http';
import https from 'node:https';
import { createReadStream, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir, networkInterfaces } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { readQr } from './qr.js';
import { config, credentials, hasAsr, providers, root } from './config.js';
import { candidateLayout } from './quote-fit.js';
import { incompleteCard } from './quote-integrity.js';
import { sourceConcern, reportingLead, sourceRef } from './editor-cards.js';
import { Store } from './store.js';
import { QuoteQueue, extractQuote, extractQuoteBatch } from './quotes.js';
import { bridgeAudio } from './asr.js';
import { demoAllowance } from './public-demo.js';
import { quoteText, roles } from '../public/format.js';
import { quoteDeadline } from '../public/show-timing.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const controlRow = row => row.quote ? { ...row, quote:quoteText(row.quote), draftText:row.quote, layout:candidateLayout(row.quote),
  ...(row.status==='ready' && incompleteCard(row.quote) ? {status:'skip',problem:'离开上下文无法独立成句'} : {}) } : row;
const publicDir = join(root, 'public');
const browserQrDecoder = fileURLToPath(import.meta.resolve('jsqr'));
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp',
  '.otf': 'font/otf',
  '.png': 'image/png',
};
const safeEqual = (a, b) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const loopback = (s) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(s);
const validSpeaker = (value) => typeof value === 'string' && /^[1-9]\d*:[0-9]$/.test(value);
const sendWs = (ws, message) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};
const sameOrigin = (req) => {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
};
function localOperator(req) {
  return (
    loopback(req.socket.remoteAddress) &&
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '') &&
    !Object.keys(req.headers).some((k) => k === 'forwarded' || k.startsWith('x-forwarded-'))
  );
}
async function body(req, max) {
  const chunks = [];
  let total = 0;
  for await (const part of req) {
    total += part.length;
    if (total > max) throw fail(413, '文件或文字过大');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, '请使用 JSON 请求');
  const bytes = await body(req, 40000);
  try {
    const value = JSON.parse(bytes);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw fail(400, '请求内容无法读取');
  }
}
function json(res, object, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(object));
}
function staticFile(res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) throw fail(404, '找不到文件');
  res.writeHead(200, {
    'Content-Type': mime[extname(file)] || 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Cache-Control': /\.(webp|otf)$/.test(file) ? 'public, max-age=86400' : 'no-cache',
  });
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}
function localIps() {
  const networks = Object.entries(networkInterfaces()).sort(([a], [b]) =>
    a === 'en0' ? -1 : b === 'en0' ? 1 : a.localeCompare(b)
  );
  return networks.flatMap(([, list]) =>
    list
      .filter(
        (v) =>
          v.family === 'IPv4' && !v.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v.address)
      )
      .map((v) => v.address)
  );
}
function opId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value)) throw fail(400, '缺少有效的发送编号');
  return value;
}
function textField(content, max, hint) {
  if (typeof content !== 'string' || !content.trim() || [...content.trim()].length > max)
    throw fail(400, hint);
  return content.trim();
}

export function createApp(options = {}) {
  const cfg = { ...config, ...options.config };
  const keys = options.credentials || credentials;
  const base = '/e/' + cfg.id;
  const publicDemo = cfg.publicDemo === true && cfg.id === 'public-demo';
  const activityDir = publicDemo ? join(cfg.dir, 'open-rehearsal') : cfg.dir;
  const store = new Store(activityDir);
  const allowance = publicDemo ? demoAllowance(store) : null;
  const keyFile = join(activityDir, 'control.key');
  try {
    writeFileSync(keyFile, randomBytes(24).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const operatorKey = readFileSync(keyFile, 'utf8').trim();
  if (operatorKey.length < 16) throw new Error('控台口令文件为空或过短');
  const session = createHmac('sha256', operatorKey)
    .update('control-session:' + cfg.id)
    .digest('hex');
  const cookie = 'buddy_' + cfg.id;
  const guestSession = publicDemo
    ? createHmac('sha256', operatorKey).update('public-rehearsal:' + cfg.id).digest('hex')
    : null;
  const authorized = (req) => (req.headers.cookie || '').split(';').some((part) => {
    const value = part.trim();
    return safeEqual(value, cookie + '=' + session) ||
      (publicDemo && safeEqual(value, cookie + '=' + guestSession));
  });
  function setSession(req, res, value) {
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', cookie + '=' + value + '; Path=' + base +
      '/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : ''));
  }
  const failureLogins = new Map();
  const stages = new Map(),
    controls = new Set();
  const qrTargets = new Map();
  function cacheTarget(id, target) {
    qrTargets.set(id, target);
    if (qrTargets.size > 8) qrTargets.delete(qrTargets.keys().next().value);
  }
  async function qrTarget(id) {
    const bytes = store.image(id);
    if (!bytes) throw fail(404, '找不到二维码');
    if (!qrTargets.has(id)) cacheTarget(id, (await readQr(Buffer.from(bytes))).target);
    return qrTargets.get(id);
  }
  let audio = { ...store.get('lastCapture', {}), state: 'idle', partial: '' },
    endAudio = null,
    shuttingDown = false;
  const presence = () => {
    const ackVersion = store.screen().version;
    const acknowledged = new Map();
    for (const last of stages.values()) {
      if (last) acknowledged.set(last.version, { ...last, count: (acknowledged.get(last.version)?.count || 0) + 1 });
    }
    return {
      ackVersion,
      online: stages.size,
      displayed: acknowledged.get(ackVersion)?.count || 0,
      acknowledgements: [...acknowledged.values()],
    };
  };
  const privateEvent = (msg) => {
    for (const ws of controls) sendWs(ws, msg);
  };
  const presenceEvent = () => {
    if (!shuttingDown && controls.size) privateEvent({ type: 'presence', ...presence() });
  };
  const segmentEvent = row => {
    privateEvent({type:'segment',row:controlRow(row)});
    if (!row.extra) for (const card of store.cards.affected(row.id)) privateEvent({type:'segment',row:controlRow(card)});
  };
  const generate = options.generate || ((s,c)=>extractQuote(keys().token,s,c,allowance?.modelRequest));
  const queue = new QuoteQueue(
    store,
    generate,
    segmentEvent,
    {
      ...options.quoteTiming,
      generateBatch: options.generateBatch || (!options.generate ? (items, context) => extractQuoteBatch(keys().token, items, context, allowance?.modelRequest) : null),
    }
  );
  const ingest = ({ invalidated = [], correctionUpdates = [], ...row }) => {
    segmentEvent(row);
    correctionUpdates.forEach(segmentEvent);
    if (row.status === 'unconfirmed') return;
    for (const changed of [row, ...invalidated]) store.replacedRows(changed.id).forEach(segmentEvent);
    if (row.status === 'collecting') queue.collect(row);
    else queue.add(row.id);
    for (const updated of invalidated) {
      segmentEvent(store.segment(updated.id));
      queue.add(updated.id);
    }
  };
  const notifyAudio = (state) => {
    audio = state;
    privateEvent({ type: 'audio', audio });
  };
  let expiryTimer;
  function presentation(screen = store.screen()) {
    const cue = store.get('buddyCue');
    return cue ? { ...screen, buddyCue: cue } : screen;
  }
  function stageState(screen = store.screen()) {
    const { candidate, ...published } = screen;
    return { name: cfg.name, screen: presentation(published), serverNow: Date.now() };
  }
  function scheduleExpiry(screen) {
    clearTimeout(expiryTimer);
    if (screen.kind !== 'quote') return;
    const expire = () => {
      const active = store.screen();
      if (active.version !== screen.version || active.kind !== 'quote') return;
      if (quoteDeadline(active) > Date.now()) return scheduleExpiry(active);
      updateDisplay(() => store.expireQuote(active.version));
    };
    const remaining = quoteDeadline(screen) - Date.now();
    if (remaining <= 0) expire();
    else {
      expiryTimer = setTimeout(expire, remaining);
      expiryTimer.unref();
    }
  }
  function updateDisplay(change) {
    const previous = store.screen().version;
    const screen = change();
    if (screen.version !== previous) {
      scheduleExpiry(screen);
      for (const ws of stages.keys()) sendWs(ws, { type: 'screen', ...stageState(screen) });
    }
    const state = { screen: presentation(screen), history: store.history(), ...store.qrState() };
    privateEvent({ type: 'screen', ...state, ...presence(), serverNow: Date.now() });
    return state;
  }
  function snapshot() {
    const auth = keys();
    return {
      name: cfg.name,
      publicDemo,
      screen: presentation(),
      serverNow: Date.now(),
      history: store.history(),
      ...store.qrState(),
      rows: store.segments().map(controlRow),
      editorCards: store.cards.all().filter(c=>c.status!=='withdrawn').map(controlRow),
      mapping: store.mapping(),
      liveTranscriptBoundary: store.liveTranscriptBoundary(),
      audio,
      ...presence(),
      asrReady: hasAsr(auth),
      providers: providers(auth),
      modelReady: Boolean(auth.token),
      lan: ['127.0.0.1', '::1'].includes(server.address()?.address) ? null : localIps()[0] || null,
    };
  }
  async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
    );
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const get = req.method === 'GET';
    if (get && ['/', '/control', '/stage'].includes(path)) {
      res.writeHead(302, { Location: base + (path === '/stage' ? '/stage' : '/control') });
      return res.end();
    }
    if (get && path === '/static/jsqr.js') return staticFile(res, browserQrDecoder);
    if (get && /^\/static\/(?:assets\/)?[a-z0-9-]+\.(js|css|webp|png)$/.test(path))
      return staticFile(res, join(publicDir, path.slice(8)));
    if (get && /^\/fonts\/TencentSans-W[37]\.otf$/.test(path)) {
      return staticFile(
        res,
        join(
          cfg.fontDir || process.env.BUDDY_FONT_DIR || join(homedir(), 'Library', 'Fonts'),
          path.split('/').pop()
        )
      );
    }
    if (!path.startsWith(base + '/')) throw fail(404, '没有找到这场活动');
    const route = path.slice(base.length);
    if (get && route === '/api/time') return json(res, { serverNow: Date.now() });
    if (get && ['/control', '/stage'].includes(route))
      return staticFile(res, join(publicDir, route.slice(1) + '.html'));
    if (get && route === '/api/stage') return json(res, stageState());
    if (get && /^\/qr\/[a-f0-9]{64}\.png$/.test(route)) {
      const bytes = store.image(route.slice(4, -4));
      if (!bytes) throw fail(404, '找不到二维码');
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Content-Length': bytes.byteLength,
      });
      return res.end(Buffer.from(bytes));
    }
    if (!route.startsWith('/api/')) throw fail(404, '没有找到这个页面');
    if (!get && (!sameOrigin(req) || req.method !== 'POST')) throw fail(403, '只接受本活动控台操作');
    if (route === '/api/login' && !get) {
      const { password, local, guest } = await jsonBody(req);
      if (guest === true && publicDemo) {
        setSession(req, res, guestSession);
        return json(res, { ok: true });
      }
      const auto = local && cfg.localControl && localOperator(req);
      if (!auto) {
        if (local || typeof password !== 'string') throw fail(401, '请输入本场控台口令');
        const address = req.socket.remoteAddress;
        const entry = failureLogins.get(address) || { attempts: 0, until: Date.now() + 60000 };
        if (entry.until <= Date.now()) {
          entry.attempts = 0;
          entry.until = Date.now() + 60000;
        }
        if (entry.attempts >= 12) throw fail(429, '请稍后再试');
        if (!safeEqual(password, operatorKey)) {
          entry.attempts++;
          failureLogins.set(address, entry);
          throw fail(401, '控台口令不正确');
        }
        failureLogins.delete(address);
      }
      setSession(req, res, session);
      return json(res, { ok: true });
    }
    if (!authorized(req)) throw fail(401, '此操作需要本场控台权限');
    if (get && route === '/api/services') return json(res, { asrReady: hasAsr(keys()), providers: providers(keys()) });
    if (get && route === '/api/control') return json(res, snapshot());
    if (get && route === '/api/qr/target') return json(res, { target: await qrTarget(url.searchParams.get('image') || '') });
    if (get && route === '/api/transcript') {
      const name = encodeURIComponent(cfg.name + '-完整逐字稿.txt');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': "attachment; filename=transcript.txt; filename*=UTF-8''" + name,
      });
      return res.end(store.transcript(cfg.name));
    }
    if (get) throw fail(404, '请求不存在');
    if (route === '/api/qr/inspect') {
      return json(res, await readQr(await body(req, 8 * 1024 * 1024)));
    }
    if (route === '/api/qr') {
      const op = opId(req.headers['x-operation-id']);
      const version = req.headers['x-qr-revision'];
      const file = await body(req, 8 * 1024 * 1024);
      const { target, png } = await readQr(file, true);
      const expected = version === undefined ? undefined : Number(version);
      const state = updateDisplay(() => store.publish(op, null, png, expected));
      cacheTarget(createHash('sha256').update(png).digest('hex'), target);
      return json(res, state);
    }
    const data = await jsonBody(req);
    if (route === '/api/qr/remove' || route === '/api/qr/restore') {
      const op = opId(data.op);
      if (!Number.isSafeInteger(data.qrRevision) || data.qrRevision < 0) throw fail(400, '缺少二维码版本');
      const action = route.endsWith('/remove') ? 'remove' : 'restore';
      return json(res, updateDisplay(() => store.changeQr(op, action, data.qrRevision)));
    }
    if (route === '/api/publish') {
      const op = opId(data.op);
      if (data.kind === 'greet') return json(res, updateDisplay(() => store.greet(op, data.currentVersion)));
      if (data.kind === 'history') {
        const item = store.history().find((s) => s.version === data.version);
        if (item?.kind === 'qr') await qrTarget(item.image);
        return json(res, updateDisplay(() => store.replay(op, data.version, data.currentVersion)));
      }
      let content;
      let revision;
      if (data.kind === 'quote')
        content = { kind: 'quote', text: data.text, ...(data.compact === true ? { compact:true } : {}) };
      else if (data.kind === 'candidate') {
        content = {
          kind: 'quote',
          text: data.text,
          ...(data.compact === true ? { compact:true } : {}),
          candidate: { id: String(data.id), rev: data.rev },
        };
      } else if (data.kind === 'qr' && store.get('lastQr')) {
        const id = store.get('lastQr');
        revision = data.qrRevision ?? store.get('qrRevision', 0);
        await qrTarget(id);
        content = { kind: 'qr', image: id };
      } else if (data.kind === 'idle') content = { kind: 'idle' };
      else throw fail(400, '没有可展示的内容');
      return json(res, updateDisplay(() => store.publish(op, content, null, revision)));
    }
    if (route === '/api/paste') {
      const body = textField(data.text, 4000, '请粘贴 1 至 4000 字的发言原文');
      const speaker = validSpeaker(data.speaker) ? data.speaker : null;
      const id = data.op ? 'paste-' + opId(data.op) : undefined;
      if (id && store.segment(id)) return json(res, { id }, 202);
      const row = store.paste(body, speaker, id, data.mode === 'speech' ? 'speech' : 'debate');
      ingest(row);
      return json(res, { id: row.id }, 202);
    }
    if (route === '/api/assign') {
      if (!roles.includes(data.role) || !validSpeaker(data.speaker)) throw fail(400, '发言人或阵营无效');
      store.assign(data.speaker, data.role);
      privateEvent({ type: 'mapping', mapping: store.mapping() });
      return json(res, { ok: true });
    }
    if (route === '/api/override') {
      if (!(data.role === null || roles.includes(data.role)) || !store.segment(String(data.id)))
        throw fail(400, '发言记录或阵营无效');
      store.override(data.id, data.role);
      segmentEvent(store.segment(data.id));
      return json(res, { ok: true });
    }
    if (route === '/api/cards/approve') {
      const card = store.cards.approve(String(data.id),data.rev);
      store.cards.replaceAlternatives(card).forEach(segmentEvent);
      segmentEvent(card);
      return json(res,{row:controlRow(card)});
    }
    if (route === '/api/transcript/extract') {
      const refs = data.refs;
      const selected = store.cards.resolve(refs,true);
      const frame = reportingLead(store.neighbors(selected[0]),selected,selected.map(r=>r.body).join(''));
      const reason = sourceConcern(selected) || (frame ? '前文引述了他人的意见，请核对归属。' : '');
      const witnesses = frame && !selected.some(r=>r.id===frame.id) ? [sourceRef(frame)] : [];
      if (reason && data.confirmed !== true) return json(res,{needsReview:true,reason,context:[...(witnesses.length ? [frame.correctedBody ?? frame.body] : []),...selected.map(r=>r.sourceBody)].join('\n')});
      // Only the operator can authorize treating these selected pieces as one speaker.
      const rows = selected.map(r=>({...r,speaker:'operator-selected',review:null}));
      let output;
      try { output = await generate(rows.at(-1),rows.slice(0,-1)); }
      catch (error) { throw fail(error.status || 503,error.message || '提炼服务暂时不可用，请重试'); }
      store.cards.resolve(refs,true);
      const result = typeof output === 'string' ? {status:'ready',quote:output} : output;
      if (result?.status !== 'ready' || !candidateLayout(result.quote) || incompleteCard(result.quote))
        return json(res,{status:result?.status || 'skip',reason:result?.problem || (result?.status==='waiting'?'还缺少下文，可扩大选区。':'这段未得到能独立上屏的短稿，可调整选区。')});
      let card = store.cards.save(result,refs,'selection',reason,witnesses);
      if (reason && data.confirmed && card.status === 'review') card = store.cards.approve(card.id,card.rev);
      store.cards.replaceAlternatives(card).forEach(segmentEvent);
      segmentEvent(card);
      return json(res,{row:controlRow(card)});
    }
    if (route === '/api/transcript/clear-live') {
      if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw fail(400, '缺少实时逐字稿版本');
      const boundary = store.clearLiveTranscript(data.revision, (audio.partials || []).map(row => row.id));
      privateEvent({ type: 'liveTranscriptCleared', boundary });
      return json(res, boundary);
    }
    if (route === '/api/transcript/edit') {
      const row = store.segment(String(data.id));
      if (!row || typeof data.excluded !== 'boolean') throw fail(400, '发言记录无效');
      const text = textField(data.text, 4000, '校订文字应为 1 至 4000 字');
      const updated = store.editTranscript(row, text, data.excluded, data.rev, data.editVersion);
      if (updated.invalidated) ingest(updated);
      else segmentEvent(updated);
      return json(res, { row: controlRow(store.segment(row.id)) });
    }
    if (route === '/api/retry') {
      store.retry();
      privateEvent({ type: 'snapshot', ...snapshot() });
      queue.recover();
      return json(res, { ok: true });
    }
    throw fail(404, '请求不存在');
  }
  const listener = (req, res) =>
    handler(req, res).catch((e) => {
      if (res.headersSent || res.destroyed) return;
      json(res, { error: e.status ? e.message : '后台操作失败，请重试' }, e.status || 500);
      if (!e.status) console.error('请求处理失败', e.name);
    });
  if (Boolean(cfg.tlsKey) !== Boolean(cfg.tlsCert)) throw new Error('HTTPS 需要同时配置证书和私钥');
  const server = cfg.tlsKey
    ? https.createServer({ key: readFileSync(cfg.tlsKey), cert: readFileSync(cfg.tlsCert) }, listener)
    : http.createServer(listener);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 20000, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const role = url.searchParams.get('role');
    if (
      url.pathname !== base + '/live' ||
      !['stage', 'control', 'mic'].includes(role) ||
      !sameOrigin(req) ||
      (role !== 'stage' && !authorized(req))
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.alive = true;
      ws.on('pong', () => {
        ws.alive = true;
      });
      ws.on('error', () => {});
      if (role === 'stage') {
        stages.set(ws, null);
        sendWs(ws, { type: 'screen', ...stageState() });
        presenceEvent();
        ws.on('message', (raw, binary) => {
          if (binary) return;
          try {
            const m = JSON.parse(raw);
            if (m.type === 'hidden' && stages.get(ws)) {
              stages.set(ws, null);
              presenceEvent();
              return;
            }
            if (
              m.type === 'displayed' &&
              m.version === store.screen().version &&
              stages.get(ws)?.version !== m.version
            ) {
              stages.set(ws, store.screen());
              presenceEvent();
            }
          } catch {
            /* Ignore invalid acknowledgements. */
          }
        });
        ws.on('close', () => {
          stages.delete(ws);
          presenceEvent();
        });
      } else if (role === 'control') {
        controls.add(ws);
        sendWs(ws, { type: 'snapshot', ...snapshot() });
        ws.on('close', () => controls.delete(ws));
      } else {
        const auth = keys();
        const provider = url.searchParams.get('provider') || 'tencent';
        const mode = url.searchParams.get('mode') === 'speech' ? 'speech' : 'debate';
        if (endAudio || provider !== 'tencent' || !hasAsr(auth)) {
          sendWs(ws, {
            type: 'error',
            message: endAudio ? '已有控台在收音' : provider !== 'tencent' ? '本场仅使用腾讯云识别，请刷新控台' : '请先填写后台腾讯云语音服务的配置',
          });
          ws.close(1000);
          return;
        }
        try {
          const chargeAudio = allowance?.startAudio();
          notifyAudio({ state: 'connecting', partial: '', provider, mode });
          endAudio = bridgeAudio({
            mode,
            chargeAudio,
            client: ws,
            keys: auth,
            store,
            addSegment: ingest,
            onSpeech: row => queue.speech(row),
            onCorrection: segmentEvent,
            notify: notifyAudio,
            dial: options.dialAsr,
            finish: () => {
              endAudio = null;
              queue.flush();
            },
          });
        } catch (error) {
          notifyAudio({ state: 'idle', partial: '', message: error.status === 429 ? error.message : '腾讯云识别配置有误，请核对后台凭证' });
          sendWs(ws, { type: 'error', message: audio.message });
          ws.close(1000);
        }
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, 15000);
  heartbeat.unref();
  scheduleExpiry(store.screen());
  queue.recover();
  return {
    server,
    store,
    base,
    stop: async () => {
      shuttingDown = true;
      clearTimeout(expiryTimer);
      clearInterval(heartbeat);
      endAudio?.();
      for (const ws of wss.clients) ws.terminate();
      await Promise.all([new Promise((r) => wss.close(r)), new Promise((r) => server.close(r))]);
      await queue.stop();
      store.db.close();
    },
  };
}
