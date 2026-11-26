import { createHmac, randomInt, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { isCorrection } from './speech-cues.js';

export function asrUrl(
  keys,
  voiceId,
  contextId,
  now = Math.floor(Date.now() / 1000),
  nonce = randomInt(1, 1e9),
) {
  const path = 'asr.cloud.tencent.com/asr/v2/' + keys.appId;
  const params = {
    engine_model_type: '16k_zh_en_speaker_2.0',
    secretid: keys.secretId,
    timestamp: now,
    expired: now + 3600,
    nonce,
    voice_id: voiceId,
    voice_format: 1,
    needvad: 1,
    result_mod: 1,
    enable_speaker_context: 1,
    speaker_diarization: 1,
    sentence_strategy: 0,
  };
  if (contextId) params.speaker_context_id = contextId;
  const pairs = Object.keys(params)
    .sort()
    .map((key) => [key, String(params[key])]);
  const query = pairs.map(([key, value]) => key + '=' + value).join('&');
  const signature = createHmac('sha1', keys.secretKey)
    .update(path + '?' + query)
    .digest('base64');
  return (
    'wss://' +
    path +
    '?' +
    new URLSearchParams(pairs).toString() +
    '&signature=' +
    encodeURIComponent(signature)
  );
}

const cloudErrors = {
  4001: '腾讯云未接受识别参数',
  4002: '腾讯云鉴权失败，请核对 AppID 和密钥',
  4003: '腾讯云语音识别服务尚未开通',
  4004: '腾讯云资源包已用尽，请检查后付费设置',
  4005: '腾讯云账户欠费，请先充值',
  4006: '腾讯云并发额度已满',
  4007: '腾讯云无法解码音频',
  4008: '音频发送中断，请重新开始收音',
};
const send = (socket, message) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

export function sentencesOf(message) {
  const data = message.sentences ?? message.result?.speaker_sentences;
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.sentence_list)) return data.sentence_list;
  return data.sentence_id == null ? [] : [data];
}
function integer(value) {
  if (value === null || value === undefined || value === '' || !Number.isSafeInteger(Number(value)))
    return -1;
  return Number(value);
}
export function bridgeAudio({
  client,
  keys,
  store,
  addSegment,
  onSpeech = () => {},
  onCorrection = () => {},
  notify,
  finish,
  mode = 'debate',
  dial = (url, options) => new WebSocket(url, { handshakeTimeout: 10000, ...options }),
}) {
  const previous = store.get('speakerContext');
  const resume = previous && Date.now() - previous.savedAt < 24 * 3600000 ? previous : null;
  const stream = randomUUID();
  const cloud = dial(asrUrl(keys, stream, resume?.id));
  const stable = new Map(), drafts = new Map();
  const stats = { receivedMs: 0, packets: 0, maxGapMs: 0, peakDb: -96, levelDb: -96, finalCount: 0 };
  let group = resume?.group,
    offset,
    ending = false,
    done = false,
    lastPacket = 0,
    lastEmit = 0,
    input,
    lastFinal,
    disconnectNote = '';
  let timer = setTimeout(() => close('连接腾讯云超时，请重新开始收音'), 13000);
  const db = (v) => Math.max(-96, Math.round(20 * Math.log10(v || 0.00001)));
  function update(state, message = '') {
    const partials = [...drafts.values()].sort((a, b) => a.startMs - b.startMs);
    notify({
      state,
      provider: 'tencent',
      mode,
      partial: partials.map((s) => s.body).join('\n'),
      partials,
      metrics: { ...stats, sincePacketMs: lastPacket ? Date.now() - lastPacket : null },
      input,
      message,
    });
    lastEmit = Date.now();
  }
  function close(problem) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(meter);
    for (const draft of drafts.values()) {
      const row = store.upsert({ ...draft, provisional: true });
      if (row) addSegment(row);
    }
    const leftovers = drafts.size;
    drafts.clear();
    const message = [
      problem || disconnectNote,
      leftovers ? '有 ' + leftovers + ' 段仅收到临时稿，请核对。' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    store.set('lastCapture', { provider: 'tencent', mode, input, metrics: stats, message, endedAt: Date.now() });
    send(client, problem ? { type: 'error', message } : { type: 'ended' });
    update('idle', message);
    if (cloud.readyState !== WebSocket.CLOSED) cloud.terminate();
    if (client.readyState === WebSocket.OPEN) client.close(1000);
    finish();
  }
  function end() {
    if (ending || done) return;
    if (offset === undefined) return close('收音在识别服务就绪前中断');
    ending = true;
    if (cloud.readyState === WebSocket.OPEN) send(cloud, { type: 'end' });
    update('draining');
    timer = setTimeout(() => close('未收到腾讯云结束确认，请核对最后一段'), 15000);
  }
  function ready() {
    if (offset !== undefined) return;
    clearTimeout(timer);
    group ??= store.nextGroup();
    if (!resume) store.set('speakerContext', null);
    offset = store.timeOffset();
    send(client, { type: 'ready' });
    update('recording');
  }
  function record(key, body, speaker, start, end, final) {
    if (typeof body !== 'string' || !body.trim() || key == null) return;
    const id = stream + '/' + key;
    const startMs = offset + Math.max(0, Number(start) || 0);
    const row = {
      id,
      stream,
      mode,
      body: body.trim(),
      speaker,
      startMs,
      endMs: Math.max(startMs, offset + (Number(end) || 0)),
    };
    if (!final) {
      if (!stable.has(id)) {
        const prior = drafts.get(id);
        drafts.set(id, row);
        if (prior?.body !== row.body || prior?.speaker !== row.speaker) {
          if (isCorrection(row.body) || (prior && isCorrection(prior.body)))
            store.draftCorrection(row).forEach(onCorrection);
          onSpeech(row);
        }
      }
      return;
    }
    const draft = drafts.get(id);
    drafts.delete(id);
    const signature = JSON.stringify(row);
    if (stable.get(id) === signature) return;
    stable.set(id, signature);
    stats.finalCount = stable.size;
    const letters = (s) => s.replace(/[\s\p{P}]/gu, '');
    if (draft) {
      const interim = letters(draft.body),
        finalText = letters(row.body);
      const tail = finalText.startsWith(interim) ? finalText.slice(interim.length) : '';
      if (
        interim.length >= 8 &&
        /(?:的|不能|只能|因为|应该|代表着|在于)$/.test(interim) &&
        tail.length > 0 &&
        tail.length <= 6
      )
        row.review = '核对句尾 · 定稿新增「' + tail + '」';
    }
    if (
      !row.review &&
      speaker &&
      lastFinal?.speaker &&
      lastFinal.id !== id &&
      lastFinal.speaker !== speaker &&
      row.startMs >= lastFinal.startMs &&
      row.startMs < lastFinal.endMs - 120
    )
      row.review = '发言时间有重叠，请核对归属';
    if (!lastFinal || row.startMs >= lastFinal.startMs) lastFinal = row;
    const saved = store.upsert({ ...row, collecting: true });
    if (saved) addSegment(saved);
  }
  function tencentMessage(m) {
    if (Number(m.code) !== 0) {
      if (resume && offset === undefined && Number(m.code) === 4001) store.set('speakerContext', null);
      return close(cloudErrors[m.code] || '腾讯云识别失败（' + integer(m.code) + '）');
    }
    ready();
    const contextId = m.speaker_context_id || m.sentences?.speaker_context_id;
    if (typeof contextId === 'string' && contextId)
      store.set('speakerContext', { id: contextId, group, savedAt: Date.now() });
    const list = sentencesOf(m);
    for (const s of list) {
      const key = integer(s.sentence_id),
        who = integer(s.speaker_id),
        type = integer(s.sentence_type);
      if (key < 0 || ![0, 1].includes(type)) continue;
      record(
        key,
        s.sentence ?? s.text,
        who >= 0 && who <= 9 ? group + ':' + who : null,
        s.start_time,
        s.end_time,
        type === 1,
      );
    }
    if (list.length) update(ending ? 'draining' : 'recording');
    if (Number(m.final) === 1) close();
  }
  const meter = setInterval(() => {
    if (offset !== undefined && !ending && !done && Date.now() - lastEmit >= 480) update('recording');
  }, 500);
  meter.unref();
  cloud.on('error', () => close('无法连接腾讯云语音识别，请检查后台网络和配置'));
  cloud.on('close', () => {
    if (!done) close('腾讯云连接已断开，请核对最后一段');
  });
  cloud.on('message', (buffer) => {
    if (done) return;
    let message;
    try {
      message = JSON.parse(buffer);
    } catch {
      return close('腾讯云返回了无法读取的消息');
    }
    tencentMessage(message);
  });
  client.on('message', (data, isBinary) => {
    if (done || ending) return;
    if (!isBinary) {
      try {
        const m = JSON.parse(data);
        if (m.type === 'end') end();
        if (m.type === 'input')
          input = {
            label: String(m.label || '').slice(0, 90),
            rate: Math.min(384000, Math.max(0, Number(m.rate) || 0)),
          };
      } catch {
        close('收音控制消息无效');
      }
      return;
    }
    if (offset === undefined || cloud.readyState !== WebSocket.OPEN) return close('识别服务尚未就绪，请重连');
    if (!data.length || data.length > 12800 || data.length % 2) return close('音频分片格式有误');
    if (cloud.bufferedAmount > 64000) return close('云端网络拥堵，请重新开始收音');
    const now = Date.now();
    if (lastPacket) stats.maxGapMs = Math.max(stats.maxGapMs, now - lastPacket);
    lastPacket = now;
    stats.receivedMs += data.length / 32;
    stats.packets++;
    let power = 0,
      peak = 0;
    for (let i = 0; i < data.length; i += 2) {
      const sample = data.readInt16LE(i) / 32768;
      peak = Math.max(peak, Math.abs(sample));
      power += sample * sample;
    }
    stats.levelDb = db(Math.sqrt(power / (data.length / 2)));
    stats.peakDb = Math.max(stats.peakDb, db(peak));
    cloud.send(data, { binary: true });
  });
  function disconnected() {
    if (ending || done) return;
    disconnectNote = '收音控台连接中断，请核对最后一段';
    end();
  }
  client.on('close', disconnected);
  client.on('error', disconnected);
  return () => close('后台服务已停止');
}
