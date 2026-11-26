import { api, base, connect, decorate, imageUrl, op } from './ui.js';
import { LiveTranscript } from './live-transcript.js';
import { clock, maxQuote, quoteText, roles } from './format.js';
import { createScene } from './scene.js';
import { fontReady, layoutQuote, overflowHint, stageLook } from './led-layout.js';
import { ledQr } from './led-qr.js';
import { Microphone } from './microphone.js';
decorate();
const el = (id) => document.getElementById(id);
const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (label, cls, fn) => {
  const b = node('button', cls, label);
  b.type = 'button';
  b.onclick = fn;
  return b;
};
const option = (label, value) => new Option(label, value);
const rows = new Map(),
  cards = new Map();
const liveText = new LiveTranscript(el('live-text'), el('clear-live'));
const clearLiveDialog = el('clear-live-dialog');
let clearRevisionAtOpen = 0;
const preview = createScene(el('preview'), true);
let fontLoaded = false, shareHost;
let checkingMic = false;
let pausedByOperator = false;
const mic = new Microphone(updateRecording, (message) => toast(message, true));
let live,
  connected = false,
  screen = { version: -1, kind: 'idle' },
  online = 0,
  displayed = 0,
  ackVersion = -1,
  acknowledgements = [],
  history = [];
let mapping = {},
  audio = { state: 'idle' },
  lastQr,
  qrRevision = -1,
  canRestoreQr = false,
  confirmingRevision,
  pendingQr,
  asrReady,
  modelReady,
  shareUrl,
  selectedFile,
  savedTarget,
  savedQrError,
  decodingFile = '',
  fileRevision = 0;
let pendingSend,
  pendingPaste,
  publishing = false,
  toastTimer,
  toastVersion,
  viewScheduled = false,
  transcriptLimit = 70,
  candidateLimit = 24;
const draftKey = base + '/draft',
  pasteKey = base + '/paste-draft';
function saveDraft(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {}
}
function loadDraft(key) {
  try {
    return sessionStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
function quoteHint(value, compact = false) {
  const text = quoteText(value);
  if (!text && value.trim()) return '请在金句中输入文字。';
  if ([...text].length > maxQuote) return '超过 320 字，请缩短后再发送。';
  if (fontLoaded && text && !layoutQuote(value,compact)) return overflowHint;
  return '';
}
const validQuote = (value,compact=false) => fontLoaded && Boolean(value.trim()) && !quoteHint(value,compact);

// Leave the selection and IME alone while typing. Clean the draft on blur or send.
function bindQuoteField(field, update) {
  field.oninput = () => { field.sourceValue = field.value; update(); };
  const finish = () => {
    const raw = field.sourceValue && quoteText(field.sourceValue) === field.value ? field.sourceValue : field.value;
    field.sourceValue = raw;
    const text = quoteText(raw);
    if (text !== field.value) {
      field.value = text;
      update();
    }
    return text;
  };
  field.onchange = finish;
  return finish;
}
const timeOf = (ms) => (ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '');
const screenName = (s) => (s.kind === 'quote' ? s.text : s.kind === 'qr' ? '总结二维码' : '待场画面');
let pasteDraft;
try {
  pasteDraft = JSON.parse(loadDraft(pasteKey));
} catch {}
let pasteSpeaker = pasteDraft?.speaker || '';
function savePaste() {
  saveDraft(
    pasteKey,
    JSON.stringify({ text: el('source').value, speaker: pasteSpeaker, open: !el('paste-form').hidden })
  );
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  toastVersion = undefined;
  const t = el('toast');
  t.textContent = message;
  t.dataset.error = String(error);
  t.hidden = false;
  toastTimer = setTimeout(
    () => {
      t.hidden = true;
    },
    error ? 6500 : 3300
  );
}
function publishFeedback(version) {
  if (version !== screen.version) return;
  toast(receiptText());
  toastVersion = version;
}
function receiptText() {
  if (!connected) return '控台重连，画面待核对';
  if (!online) return screen.version > 0 ? '已保存，大屏离线' : '等待投影电脑连接';
  const shown = ackVersion === screen.version ? displayed : 0;
  if (!shown) return '已保存，等待大屏显示';
  if (shown < online) return '部分大屏已显示';
  return '大屏已显示';
}
function updatePresence() {
  const top = !connected
    ? '控台重连中'
    : online
      ? online === 1
        ? '大屏已连接'
        : online + ' 块大屏已连接'
      : '大屏未连接';
  el('connection').textContent = top;
  el('connection-dot').classList.toggle('online', connected && online > 0);
  const shown = ackVersion === screen.version ? displayed : 0;
  el('screen-dot').classList.toggle('online', connected && online > 0 && shown === online);
  el('screen-status').textContent = receiptText();
  if (toastVersion !== undefined && !el('toast').hidden) {
    if (toastVersion === screen.version) el('toast').textContent = receiptText();
    else el('toast').hidden = true;
  }
  el('receipt-count').textContent = connected && online ? shown + ' / ' + online + ' 屏回执' : '';
  const old = connected && online ? acknowledgements.filter((s) => s.version < screen.version) : [];
  el('last-ack').textContent = old.map((s) => s.count + ' 屏上次回执 · ' + screenName(s)).join('　');
  el('last-ack').hidden = !old.length;
  el('manual-send').disabled = publishing || !validQuote(el('quote').sourceValue || el('quote').value,el('manual-compact').checked);
  el('undo-screen').disabled = !history.some(replayable) || publishing;
  const current = rows.get(screen.candidate?.id);
  const correctionNote = el('screen-correction');
  correctionNote.hidden = !current?.correctedBy;
  correctionNote.textContent = current?.confirmedCorrection
    ? '发言人已更正大屏上的原话，请核对并手动换屏。' : '大屏原话可能有改口，正在等定稿。';
  el('clear').disabled = screen.kind === 'idle' || publishing;
  for (const item of cards.values()) item.sync();
  el('history-list')
    .querySelectorAll('button')
    .forEach((b) => {
      b.disabled = publishing || b.dataset.blocked === 'true';
    });
  updateQrButtons();
}
function updateRecording() {
  const local = mic.phase !== 'idle';
  const phase = local ? mic.phase : checkingMic && audio.state === 'idle' ? 'connecting' : audio.state;
  const labels = { idle: pausedByOperator ? '已暂停' : '未收音', connecting: '连接中', buffering: '已采音 · 等待云端', recording: '收音中', draining: '等待最后定稿' };
  el('record-status').textContent = phase === 'idle' && asrReady === false ? '收音待配置' : labels[phase];
  el('record-status').dataset.phase = phase;
  const canPause = local && ['recording', 'buffering'].includes(phase);
  const startLabel = pausedByOperator ? '继续收音' : '开始收音';
  el('record-label').textContent = phase === 'idle' ? startLabel : canPause ? '暂停收音' :
    phase === 'recording' ? '其他控台收音中' : labels[phase];
  el('record-play').hidden = phase !== 'idle';
  el('record-pause').hidden = !canPause;
  el('record').disabled = phase !== 'idle' && !canPause;
  el('record').dataset.active = String(canPause);
  for (const id of ['speech-mode', 'device']) el(id).disabled = phase !== 'idle';
  if (!local && ['recording','draining','connecting'].includes(audio.state)) {
    if (audio.mode) el('speech-mode').value = audio.mode;
  }
  const input = local ? mic.input : audio.input;
  el('input-summary').textContent = input?.label ? '· ' + input.label : '';
  const stats = audio.metrics, level = local ? mic.levelDb : stats?.levelDb;
  const signal = el('signal');
  signal.hidden = !local && !stats;
  el('level').value = Math.max(-72, level ?? -72);
  const quiet = (level ?? -96) < -55;
  el('level-label').textContent = phase === 'idle' ? '上次峰值 ' + (stats?.peakDb ?? '—') + ' dBFS' :
    phase === 'recording' && stats?.sincePacketMs > 1500 ? '后台未收到新音频' : (quiet ? '输入偏低 ' : '输入 ') + (level ?? '—') + ' dBFS';
  const seconds = (ms) => ((ms || 0) / 1000).toFixed(1) + ' 秒';
  el('capture-metrics').textContent = [
    input?.rate ? input.rate / 1000 + ' → 16 kHz' : '16 kHz',
    local ? '采集 ' + seconds(mic.receivedMs) + ' · 已发 ' + seconds(mic.sentMs) : '',
    '后台收到 ' + seconds(stats?.receivedMs), audio.message && !local ? audio.message : '',
  ].filter(Boolean).join(' · ');
  const drafts = audio.partials || (audio.partial ? [{body: audio.partial, startMs: Infinity, endMs: Infinity}] : []);
  liveText.setDrafts(drafts);
  el('live-state').hidden = !drafts.length;

}
function setScreen(next, previous, revision) {
  if (!next || next.version < screen.version) return;
  screen = next;
  if (previous && revision >= qrRevision) {
    history = previous;
    renderHistory();
  }
  el('published-time').textContent = timeOf(next.publishedAt);
  el('on-air').textContent = { idle: '待场', quote: '金句', qr: '二维码' }[next.kind];
  preview.show(next).then((drawn) => {
    if (drawn && next.version === screen.version) el('led-error').hidden = true;
  }).catch((error) => {
    if (next.version !== screen.version) return;
    const notice = el('led-error');
    notice.textContent = '此版本尚未显示。' + error.message;
    notice.hidden = false;
  });
  if (el('qr-dialog').open) describeRemoval();
  updatePresence();
}
function replay(item) {
  if (item) publish({ kind: 'history', version: item.version, currentVersion: screen.version });
}
function replayable(item) {
  if (item.kind === 'quote' && !validQuote(item.text,item.compact)) return false;
  if (!item.candidate) return true;
  const row = rows.get(item.candidate.id);
  return row && !row.correctedBy && row.rev === item.candidate.rev && ['ready', 'merged'].includes(row.status);
}
function renderHistory() {
  const list = el('history-list');
  if (!el('history').open) return;
  list.replaceChildren();
  if (!history.length) list.append(node('p', 'history-empty', '下一次发布后，可在这里找回上一屏。'));
  for (const item of history) {
    const line = node('div', 'history-item');
    if (item.kind === 'qr') {
      const img = node('img');
      img.alt = '';
      img.src = imageUrl(item.image);
      line.append(img);
    }
    const copy = node('div', 'history-copy', screenName(item));
    if (item.publishedAt) copy.append(node('time', '', timeOf(item.publishedAt)));
    const available = replayable(item);
    const restoreLabel = item.kind === 'quote' && quoteHint(item.text) ? '需精简后发送' : '原话已更新';
    const restore = button(available ? '重新展示' : restoreLabel, 'text-button', () => replay(item));
    restore.dataset.blocked = String(!available);
    restore.disabled = publishing || !available;
    line.append(copy, restore);
    list.append(line);
  }
}
function updateQrButtons() {
  const choosing = Boolean(selectedFile || decodingFile);
  el('cancel-file').hidden = !choosing;
  el('remove-qr').hidden = choosing || !lastQr;
  el('show-saved').hidden = choosing || !lastQr;
  el('restore-qr').hidden = choosing || !canRestoreQr;
  el('upload').hidden = !choosing;
  el('upload').disabled = publishing || !selectedFile?.verified || selectedFile.revision !== qrRevision;
  for (const id of ['qr-file', 'cancel-file', 'remove-qr', 'show-saved', 'restore-qr'])
    el(id).disabled = publishing;
  el('show-saved').disabled = publishing || Boolean(savedQrError?.invalid);
}
function renderTarget(target, error) {
  const host = el('qr-target');
  host.hidden = target === undefined && !error;
  host.dataset.error = String(Boolean(error));
  host.replaceChildren();
  if (error) return host.append(document.createTextNode(error));
  if (target === undefined) return;
  let link;
  try {
    const url = new URL(target);
    if (['https:', 'http:'].includes(url.protocol)) link = url;
  } catch {}
  if (!link) return host.append(document.createTextNode('扫码内容 · ' + (target || '二进制数据')));
  const open = node('a', '', '打开核对 ↗');
  open.href = link.href;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.title = link.href;
  host.append(node('span', '', '扫码目标 · ' + link.host), open);
}
function renderQr() {
  const img = el('qr-preview');
  const src = selectedFile?.url || (!decodingFile && lastQr ? imageUrl(lastQr) : '');
  if (src && img.getAttribute('src') !== src) img.src = src;
  if (!src) img.removeAttribute('src');
  img.hidden = !src;
  el('qr-placeholder').hidden = Boolean(src);
  el('file-title').textContent =
    selectedFile?.file.name || decodingFile || (lastQr ? '更换二维码图片' : '选择或拖入二维码');
  let detail = 'PNG 或 JPG，最大 8 MB';
  if (decodingFile) detail = '正在识别二维码…';
  else if (selectedFile?.verified) detail = selectedFile.pitch < 3
    ? 'LED 码点较密，建议使用较短链接并实机试扫' : 'LED 原生尺寸已读回，等待上传';
  else if (selectedFile) detail = '等待更换图片';
  else if (lastQr) detail = '已保存';
  else if (canRestoreQr) detail = '已删除二维码，上传新图前可撤销。';
  el('file-detail').textContent = detail;
  const changed = selectedFile && selectedFile.revision !== qrRevision;
  renderTarget(
    selectedFile ? selectedFile.target : savedTarget,
    changed
      ? '已存二维码发生变化，请重新选图后再上传。'
      : selectedFile
        ? selectedFile.problem
        : savedQrError?.message
  );
  updateQrButtons();
}
function setQrState(state) {
  const revision = state.qrRevision ?? 0;
  if (revision < qrRevision) return;
  const changed = lastQr !== state.lastQr;
  lastQr = state.lastQr;
  qrRevision = revision;
  canRestoreQr = Boolean(state.canRestoreQr);
  if (el('qr-dialog').open && confirmingRevision !== revision) {
    el('qr-dialog').close();
    toast('二维码已更新，请核对当前图片');
  }
  if (changed) savedTarget = savedQrError = undefined;
  renderQr();
  if (changed) {
    const id = lastQr;
    if (id)
      api('qr/target?image=' + encodeURIComponent(id))
        .then((data) => {
          if (id === lastQr) {
            savedTarget = data.target;
            renderQr();
          }
        })
        .catch((e) => {
          if (id === lastQr) {
            savedQrError = {
              invalid: e.status === 422,
              message: e.status === 422 ? e.message : '暂时无法读取扫码目标',
            };
            renderQr();
          }
        });
  }
}
function updateLook() {
  const look = stageLook(el('stage-look').value);
  el('preview').dataset.look = look;
  const url = new URL(base + '/stage', location.origin);
  url.searchParams.set('look', look);
  el('open-stage').href = url.href;
  if (shareHost && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = shareHost;
  shareUrl = url.href;
  el('stage-url').href = shareUrl;
  el('stage-url').textContent = url.host + url.pathname + url.search;
}
// Earlier rehearsal tabs stored their temporary colour comparisons under /led-look.
const lookKey = base + '/led-output-look';
el('stage-look').value = stageLook(loadDraft(lookKey));
el('stage-look').onchange = () => {
  saveDraft(lookKey, el('stage-look').value);
  updateLook();
};
function snapshot(s) {
  applyLiveClear(s.liveTranscriptBoundary);
  el('demo-notice').hidden = !s.publicDemo;
  document.querySelectorAll('[data-event]').forEach((n) => (n.textContent = s.name));
  mapping = s.mapping;
  rows.clear();
  for (const row of [...s.rows,...(s.editorCards || [])]) rows.set(row.id, row);
  audio = s.audio;
  asrReady = s.asrReady;
  modelReady = s.modelReady;
  online = s.online;
  displayed = s.displayed;
  ackVersion = s.ackVersion;
  acknowledgements = s.acknowledgements || [];
  shareHost = s.lan;
  updateLook();
  setScreen(s.screen, s.history, s.qrRevision);
  setQrState(s);
  updateRecording();
  scheduleLists();
}
function event(m) {
  if (m.type === 'snapshot') return snapshot(m);
  if (m.type === 'liveTranscriptCleared') return applyLiveClear(m.boundary);
  if (m.type === 'segment') {
    rows.set(m.row.id, m.row);
    if (screen.candidate?.id === m.row.id || history.some(s => s.candidate?.id === m.row.id)) {
      renderHistory();
      updatePresence();
    }
    scheduleLists();
  }
  if (m.type === 'mapping') {
    mapping = m.mapping;
    scheduleLists();
  }
  if (m.type === 'audio') {
    audio = m.audio;
    updateRecording();
    if (audio.message) toast(audio.message, true);
  }
  if (m.type === 'screen' || m.type === 'presence') {
    online = m.online;
    displayed = m.displayed;
    ackVersion = m.ackVersion;
    acknowledgements = m.acknowledgements || [];
    if (m.type === 'screen') {
      setScreen(m.screen, m.history, m.qrRevision);
      setQrState(m);
    }
    updatePresence();
  }
}
function applyLiveClear(boundary) {
  if (liveText.applyClear(boundary) && clearLiveDialog.open) {
    clearLiveDialog.close();
    el('live-text').focus({ preventScroll: true });
  }
}
el('clear-live').onclick = () => {
  clearRevisionAtOpen = liveText.clearRevision;
  clearLiveDialog.showModal();
};
el('cancel-clear-live').onclick = () => clearLiveDialog.close();
el('confirm-clear-live').onclick = async () => {
  const revision = clearRevisionAtOpen;
  const trigger = el('clear-live');
  clearLiveDialog.close();
  el('live-text').focus({ preventScroll: true });
  trigger.setAttribute('aria-busy', 'true');
  trigger.disabled = true;
  try {
    const boundary = await api('transcript/clear-live', 'POST', { revision });
    applyLiveClear(boundary);
    toast('实时逐字稿已清空');
  } catch (error) {
    // The WebSocket confirmation can arrive even if the HTTP response was lost.
    if (liveText.clearRevision > revision) toast('实时逐字稿已清空');
    else toast('清空失败，请重试。' + (error.message || ''), true);
  } finally {
    trigger.removeAttribute('aria-busy');
    trigger.disabled = !el('live-text').value;
  }
};
const roleOf = (row) => row.overrideRole ?? mapping[row.speaker] ?? '待确认';
function selectRoles(value, inherit, handler, label) {
  const select = node('select');
  select.setAttribute('aria-label', label);
  if (inherit) select.add(option('跟随发言人', ''));
  for (const role of roles) select.add(option(role, role));
  select.value = value || '';
  select.onchange = async () => {
    select.disabled = true;
    try {
      await handler(select.value);
    } catch (e) {
      select.value = value || '';
      toast(e.message, true);
    } finally {
      select.disabled = false;
    }
  };
  return select;
}
function showLines(host,layout,fallback='') {
  host.replaceChildren(...(layout ? layout.lines : [fallback]).map(line=>node('span','display-line',line)));
}
function readingPreview(host,text,compact) {
  const layout = fontLoaded && layoutQuote(text,compact);
  showLines(host,layout);
  host.hidden = !layout;
  host.dataset.size = layout ? layout.size + ' px' : '';
}
const reviewDialog = el('source-review');
let reviewAction;
function reviewSource(reason,source,confirm,action) {
  el('review-reason').textContent = reason;
  el('review-source').textContent = source;
  el('review-confirm').textContent = confirm;
  reviewAction = action;
  if (!reviewDialog.open) reviewDialog.showModal();
  el('review-cancel').focus();
}
el('review-cancel').onclick = () => reviewDialog.close();
el('review-confirm').onclick = () => { const act = reviewAction; reviewDialog.close(); act?.(); };
const selectedButton = el('extract-selection');
let extracting = false;
function selectionState() {
  selectedButton.disabled = extracting || !connected || !liveText.selection();
  selectedButton.textContent = extracting ? '正在提炼…' : '提炼所选';
}
for (const type of ['select','keyup','pointerup']) el('live-text').addEventListener(type,selectionState);
async function extractSelection(selection,confirmed=false) {
  if (!selection || extracting) return;
  extracting = true;
  selectionState();
  try {
    const answer = await api('transcript/extract','POST',{refs:selection.refs,confirmed});
    if (answer.needsReview) reviewSource(answer.reason,answer.context || selection.text,'确认归属并提炼',()=>extractSelection(selection,true));
    else if (answer.row) { rows.set(answer.row.id,answer.row); scheduleLists(); toast('选中的发言已提炼，请核对候选。'); }
    else toast(answer.reason || '所选内容还缺少完整观点。');
  } catch(e) { toast(e.message,true); }
  finally { extracting=false; selectionState(); }
}
selectedButton.onclick = () => extractSelection(liveText.selection());
function candidateCard(id) {
  const dom = node('article', 'candidate');
  const meta = node('header', 'candidate-meta');
  const role = node('span', 'role'),
    when = node('time');
  const confirmed = node('span', 'confirmed-label', '大屏正显示');
  const adapted = node('span', 'adapted-label', '现场金句');
  meta.append(role, adapted, confirmed, when);
  const text = node('p', 'candidate-text');
  const details = node('details', 'candidate-source'),
    original = node('p');
  const evidence = node('p', 'quote-evidence');
  details.append(node('summary', '', '原发言'), evidence, original);
  const footer = node('div', 'candidate-footer'),
    actions = node('div', 'candidate-actions');
  const form = node('form', 'edit-candidate'),
    input = node('textarea');
  const notice = node('p', 'service-note');
  input.rows = 2;
  input.setAttribute('aria-label', '编辑候选金句');
  const editActions = node('div', 'candidate-actions');
  const edit = button('编辑', 'text-button', openEditor);
  const send = button('', 'send-candidate', () => {
    if (rendered?.status === 'ready') publish({ kind: 'candidate', id, rev: rendered.rev });
  });
  send.setAttribute('aria-label', '发送');
  send.title = '发送这条金句到大屏';
  text.id = 'quote-' + encodeURIComponent(id);
  send.setAttribute('aria-describedby', text.id);
  const icon = node('i');
  icon.dataset.icon = 'send';
  send.append(icon);
  decorate(send);
  const line = node('div', 'quote-line');
  line.append(text, send);
  const sendEdit = node('button', 'button solid small', '发送改写');
  sendEdit.type = 'submit';
  const reload = button('载入新版', 'text-button', openEditor);
  editActions.append(reload, button('取消', 'text-button', closeEditor), sendEdit);
  const editPreview = node('div','reading-preview');
  const compactOption = node('label','compact-option');
  const compact = node('input');
  compact.type = 'checkbox';
  compact.onchange = sync;
  compactOption.append(compact,document.createTextNode('允许紧凑字号，最低 29 px'));
  form.append(input, editPreview, compactOption, notice, editActions);
  form.hidden = true;
  const review = button('核对归属','text-button',()=>{
    const row = rows.get(id);
    reviewSource(row.reason,'待选短稿\n'+(row.layout?.lines || [row.quote]).join('\n')+'\n\n原发言\n'+row.body,'确认可选用',async()=>{
      try { const answer = await api('cards/approve','POST',{id,rev:row.rev}); rows.set(id,answer.row); scheduleLists(); toast('归属已核对，可点选发送。'); }
      catch(e) { toast(e.message,true); }
    });
  });
  actions.append(review,edit);
  footer.append(details, actions);
  const caution = node('p', 'review-note');
  const fitNote = node('p', 'service-note');
  dom.append(meta, line, caution, fitNote, form, footer);
  let editingRev, rendered;
  function openEditor() {
    const row = rows.get(id);
    editingRev = row.rev;
    input.value = row.quote || '';
    input.sourceValue = row.draftText || input.value;
    compact.checked = false;
    form.hidden = false;
    sync();
    input.focus();
  }
  function closeEditor() {
    form.hidden = true;
    sync();
    edit.focus();
    scheduleLists();
  }
  function sync() {
    const row = rows.get(id);
    if (!row) return;
    const editing = !form.hidden;
    const stale = editing && (row.rev !== editingRev || row.status !== 'ready');
    const currentRole = roleOf(row);
    if (rendered !== row || role.dataset.role !== currentRole) {
      role.dataset.role = role.textContent = currentRole;
      role.hidden = currentRole === '待确认';
      when.textContent = clock(row.startMs);
      showLines(text,row.layout || layoutQuote(row.quote),row.quote);
      const sourceRows = JSON.parse(row.sourceIds || '[]').map((id) => rows.get(id)).filter(Boolean);
      adapted.hidden = evidence.hidden = !row.quoteEvidence;
      evidence.textContent = row.quoteEvidence ? '原话依据　' + row.quoteEvidence : '';
      original.textContent = row.extra ? row.body : sourceRows.map(s => s.correctedBody ?? s.body).join('\n') || row.correctedBody || row.body;
      if (sourceRows.some(r=>r.correctedBody)) original.textContent += '\n\n识别原文\n' + sourceRows.map(r=>r.body).join('\n');
      original.hidden = Boolean(row.quoteEvidence && row.quoteEvidence === original.textContent);
      caution.textContent = row.status === 'review' ? row.reason : row.reviewed ? '发言归属已核对' : [...new Set([row, ...sourceRows].map(s=>s.review).filter(Boolean))].join(' · ');
      caution.hidden = !caution.textContent;
      adapted.textContent = row.origin === 'selection' ? '选区提炼' : '现场金句';
      if (row.origin === 'selection') adapted.hidden = false;
      review.hidden = row.status !== 'review';
      edit.hidden = row.status === 'review';
      rendered = row;
    }
    const acknowledged = connected && online > 0 && displayed === online && ackVersion === screen.version;
    const matches = screen.candidate
      ? screen.candidate.id === row.id && screen.candidate.rev === row.rev
      : row.quote === screen.text;
    confirmed.hidden = !(acknowledged && screen.kind === 'quote' && matches);
    confirmed.textContent = row.quote !== screen.text ? '改写已上屏' : '大屏正显示';
    line.hidden = editing;
    actions.hidden = editing;
    const hint = quoteHint(row.quote || '');
    fitNote.textContent = hint;
    fitNote.hidden = editing || !hint;
    send.disabled = publishing || row.status !== 'ready' || !validQuote(row.quote || '');
    const raw = input.sourceValue || input.value;
    compactOption.hidden = !editing || !raw || Boolean(layoutQuote(raw)) || !layoutQuote(raw,true);
    if (compactOption.hidden) compact.checked = false;
    if (editing) readingPreview(editPreview,raw,compact.checked);
    sendEdit.disabled = publishing || stale || !validQuote(raw,compact.checked);
    reload.hidden = !stale || row.status !== 'ready';
    const editHint = quoteHint(raw,compact.checked);
    notice.textContent = row.correctedBy
      ? (row.confirmedCorrection ? '发言人已更正，这条草稿已停用。' : '发言人可能正在改口，暂缓发送。')
      : stale ? '原发言已有修订，请核对后载入新版候选。' : editHint;
    notice.hidden = !editing || (!stale && !editHint);
  }
  const finishEdit = bindQuoteField(input, sync);
  input.onkeydown = (e) => {
    if (!e.isComposing && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!sendEdit.disabled) form.requestSubmit();
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (sendEdit.disabled) return;
    const text = finishEdit();
    if ((await publish({ kind: 'candidate', id, rev: editingRev, text:input.sourceValue || text, compact:compact.checked })) && input.value.trim() === text)
      closeEditor();
  };
  return { dom, sync, editing: () => !form.hidden };
}
function speakerExcerpt(row) {
  const body = (row.correctedBody ?? row.body).replace(/\s+/g, ' ').trim();
  return '「' + [...body].slice(0, 22).join('') + ([...body].length > 22 ? '…' : '') + '」 · ' + clock(row.startMs);
}
el('more-quotes').onclick = () => { candidateLimit += 30; scheduleLists(); };
// Row updates replace the object. A two-hour session only measures newly received cards.
const sendableRows = new WeakMap();
function renderLists() {
  viewScheduled = false;
  const combined = [...rows.values()].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id)
  );
  const all = combined.filter(r=>!r.extra);
  const ready = combined.filter(row => {
    if (!fontLoaded || !['ready','review'].includes(row.status) || !row.quote) return false;
    if (!sendableRows.has(row)) sendableRows.set(row, validQuote(row.quote));
    return sendableRows.get(row);
  });
  liveText.setFinals(all);
  selectionState();
  const newest = new Set(ready.slice(-candidateLimit).map(r => r.id));
  const visibleCandidates = combined.filter((r) => newest.has(r.id) || cards.get(r.id)?.editing()).reverse();
  el('more-quotes').hidden = ready.length <= candidateLimit;
  const host = el('candidates'),
    ids = new Set(visibleCandidates.map((r) => r.id));
  for (const [id, item] of cards) {
    if (!ids.has(id)) {
      item.dom.remove();
      cards.delete(id);
    }
  }
  let cursor = host.firstElementChild;
  for (const row of visibleCandidates) {
    if (!cards.has(row.id)) cards.set(row.id, candidateCard(row.id));
    const card = cards.get(row.id);
    card.sync();
    if (card.dom !== cursor) host.insertBefore(card.dom, cursor);
    cursor = card.dom.nextElementSibling;
  }
  el('candidate-count').textContent = ready.length;
  el('segment-count').textContent = all.length + ' 段';
  const failed = all.filter(r => r.status === 'error');
  const pending = all.some(r => r.status === 'pending');
  const collecting = all.some(r => r.status === 'collecting');
  el('job-status').hidden = !collecting && !pending && !failed.length && modelReady;
  el('job-message').textContent = failed.length ? failed.length + ' 段提炼失败 · ' + failed.at(-1).problem :
    pending ? '正在提炼金句…' : collecting ? '等待发言接续…' : modelReady ? '' : '请在后台配置 Hy4 Flash 密钥';
  el('retry').hidden = !failed.length;
  el('empty-candidates').hidden = visibleCandidates.length > 0 || !el('job-status').hidden;
  const latest = all.at(-1);
  const emptyReasons = { waiting: '最近一段还缺少完整结论。', unconfirmed: '最后一段临时稿需要核对。', duplicate: '最近一段与前文重复。', withdrawn: '发言人已更正，旧候选已收起。', checking: '正在核对发言人的改口。' };
  el('empty-reason').textContent = latest ? (latest.problem || emptyReasons[latest.status] || '还没有可独立摘出的观点。') : '有完整观点后，候选会出现在这里。';

  const examples = new Map();
  for (const row of all) {
    if (!row.speaker) continue;
    const first = examples.get(row.speaker);
    if (!first || (first.body.length < 8 && row.body.length >= 8)) examples.set(row.speaker, row);
  }
  const speakerOptions = [...examples].map(([key, row]) => [key, speakerExcerpt(row)]);
  const choose = el('paste-speaker');
  const optionsKey = JSON.stringify(speakerOptions);
  if (choose.dataset.keys !== optionsKey) {
    choose.replaceChildren(option('单独提炼', ''), ...speakerOptions.map(([key, excerpt]) => option(excerpt, key)));
    choose.value = pasteSpeaker;
    choose.dataset.keys = optionsKey;
  }
  if (!el('records').open) return;
  const map = el('speaker-map');
  const mapKey = JSON.stringify(speakerOptions.map(([key, excerpt]) => [key, excerpt, mapping[key]]));
  if (map.dataset.key !== mapKey) {
    map.replaceChildren(
      ...speakerOptions.map(([key, excerpt]) => {
        const line = node('div', 'speaker-row');
        line.append(
          node('span', '', excerpt),
          selectRoles(
            mapping[key] || '待确认',
            false,
            (role) => api('assign', 'POST', { speaker: key, role }),
            '设置发言 ' + excerpt + ' 的默认阵营'
          )
        );
        return line;
      })
    );
    map.dataset.key = mapKey;
  }
  const log = el('transcript');
  const visible = all.slice(-transcriptLimit);
  const signature = JSON.stringify([
    all.length,
    visible.map((r) => [r.id, r.rev, roleOf(r), r.overrideRole, r.editVersion, r.status, r.problem]),
  ]);
  if (log.dataset.key === signature) return;
  log.dataset.key = signature;
  log.replaceChildren();
  if (!visible.length) log.append(node('p', 'transcript-row', '收音定稿或粘贴的发言会保存在这里。'));
  if (all.length > visible.length)
    log.append(
      button('显示更早的发言', 'text-button', () => {
        transcriptLimit += 100;
        scheduleLists();
      })
    );
  for (const r of visible) {
    const row = node('article', 'transcript-row'),
      head = node('header');
    head.append(
      node('span', '', clock(r.startMs)),
      node('span', '', roleOf(r)),
      selectRoles(
        r.overrideRole,
        true,
        (role) => api('override', 'POST', { id: r.id, role: role || null }),
        '校正这段发言的阵营'
      )
    );
    const tools = node('div', 'transcript-tools');
    tools.append(
      node(
        'span',
        '',
        [r.status === 'unconfirmed' ? '临时稿待核对' : '', r.correctedBody ? '已校订' : '', r.excluded ? '已排除导出' : '', r.problem || ({waiting:'等下文', skip:'无独立观点',duplicate:'与前文重复'})[r.status] || ''].filter(Boolean).join(' · ')
      )
    );
    const edit = button('校订文字', 'text-button', () => editTranscript(r));
    edit.dataset.segment = r.id;
    tools.append(edit);
    row.append(head, node('p', '', r.correctedBody ?? r.body), tools);
    log.append(row);
  }
}
function scheduleLists() {
  if (!viewScheduled) {
    viewScheduled = true;
    requestAnimationFrame(renderLists);
  }
}
function count() {
  const value = el('quote').value;
  const length = [...quoteText(value)].length;
  el('quote-count').textContent = length + ' / ' + maxQuote;
  const raw = el('quote').sourceValue || value;
  const compact = el('manual-compact');
  const canCompact = Boolean(raw && !layoutQuote(raw) && layoutQuote(raw,true));
  compact.parentElement.hidden = !canCompact;
  if (!canCompact) compact.checked = false;
  el('manual-layout').hidden = !value;
  readingPreview(el('manual-layout').firstElementChild,raw,compact.checked);
  const hint = quoteHint(raw,compact.checked);
  el('quote-count').dataset.invalid = String(Boolean(hint));
  el('length-hint').hidden = !hint;
  el('length-hint').textContent = hint;
  el('quote').setAttribute('aria-invalid', String(Boolean(hint)));
  el('manual-send').disabled = publishing || !validQuote(raw,compact.checked);
  saveDraft(draftKey, value);
}
async function publish(data) {
  if (publishing) return;
  let text = data.text;
  const item = data.kind === 'history' && history.find((past) => past.version === data.version);
  if (data.kind === 'candidate' && text === undefined) text = rows.get(data.id)?.quote;
  if (item?.kind === 'quote') text = item.text;
  if (text !== undefined && !validQuote(text,data.compact || item?.compact)) {
    toast(quoteHint(text,data.compact || item?.compact) || '请等待字体就绪并输入金句。', true);
    return false;
  }
  const signature = JSON.stringify(data);
  if (pendingSend?.signature !== signature) pendingSend = { signature, op: op() };
  publishing = true;
  el('manual-send').disabled = true;
  updatePresence();
  try {
    const image = item?.kind === 'qr' ? item.image : data.kind === 'qr' && lastQr;
    if (image) await ledQr(imageUrl(image));
    const result = await api('publish', 'POST', { ...data, op: pendingSend.op });
    pendingSend = null;
    setScreen(result.screen, result.history, result.qrRevision);
    publishFeedback(result.screen.version);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  } finally {
    publishing = false;
    updatePresence();
  }
}
el('manual-compact').onchange = count;
const finishManualQuote = bindQuoteField(el('quote'), count);
el('compose-form').onsubmit = (e) => {
  e.preventDefault();
  const text = finishManualQuote();
  if (!text || [...text].length > maxQuote) return toast('请输入 1 至 320 字的金句', true);
  publish({ kind:'quote', text:el('quote').sourceValue || text,compact:el('manual-compact').checked });
};
el('quote').onkeydown = (e) => {
  if (!e.isComposing && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    el('compose-form').requestSubmit();
  }
};
el('clear').onclick = () => publish({ kind: 'idle' });
el('undo-screen').onclick = () => replay(history.find(replayable));
el('history').ontoggle = renderHistory;
el('show-saved').onclick = () => publish({ kind: 'qr', qrRevision });
el('records').ontoggle = scheduleLists;
el('jump-records').onclick = () => {
  el('records').open = true;
};
let editingTranscript;
function editTranscript(row) {
  editingTranscript = row;
  el('edit-original').textContent = row.body;
  el('edit-body').value = row.correctedBody ?? row.body;
  el('exclude-row').checked = Boolean(row.excluded);
  el('edit-error').hidden = true;
  el('edit-dialog').querySelector('details').open = false;
  el('edit-dialog').showModal();
  el('edit-body').focus();
}
el('reset-edit').onclick = () => {
  el('edit-body').value = editingTranscript.body;
  el('edit-body').focus();
};
el('cancel-edit').onclick = () => el('edit-dialog').close();
el('edit-dialog').onclose = () => {
  el('transcript')
    .querySelector('[data-segment="' + CSS.escape(editingTranscript.id) + '"]')
    ?.focus();
};
el('transcript-form').onsubmit = async (e) => {
  e.preventDefault();
  const submit = el('transcript-form').querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  const { id, rev, editVersion } = editingTranscript;
  try {
    const { row } = await api('transcript/edit', 'POST', {
      id,
      rev,
      editVersion,
      text: el('edit-body').value.trim(),
      excluded: el('exclude-row').checked,
    });
    rows.set(row.id, row);
    renderLists();
    el('edit-dialog').close();
    toast('逐字稿校订已保存');
  } catch (e) {
    el('edit-error').textContent = e.message;
    el('edit-error').hidden = false;
    if (e.status === 409) {
      const state = await api('control').catch(() => null);
      if (state) {
        snapshot(state);
        editingTranscript = rows.get(id);
        el('edit-dialog').querySelector('details').open = true;
        el('edit-original').textContent =
          editingTranscript.body +
          (editingTranscript.correctedBody ? '\n最新校订：' + editingTranscript.correctedBody : '');
        el('edit-error').textContent += '。核对后再次保存可应用你的修改。';
      }
    }
  } finally {
    submit.disabled = false;
  }
};
el('copy-url').onclick = async () => {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(shareUrl);
    else {
      const tmp = node('textarea');
      tmp.value = shareUrl;
      document.body.append(tmp);
      tmp.select();
      const ok = document.execCommand('copy');
      tmp.remove();
      if (!ok) throw new Error();
    }
    toast('大屏地址已复制');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(el('stage-url'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    toast('已选中大屏地址，可复制');
  }
};
el('paste-open').onclick = () => {
  el('paste-form').hidden = !el('paste-form').hidden;
  el('paste-open').setAttribute('aria-expanded', String(!el('paste-form').hidden));
  savePaste();
  if (!el('paste-form').hidden) el('source').focus();
};
el('source').oninput = savePaste;
el('paste-speaker').onchange = () => {
  pasteSpeaker = el('paste-speaker').value;
  savePaste();
};
el('paste-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = el('source').value.trim(),
    submit = el('paste-form').querySelector('[type="submit"]');
  if (!text || submit.disabled) return;
  submit.disabled = true;
  const speaker = el('paste-speaker').value || null;
  const signature = JSON.stringify([text, speaker, el('speech-mode').value]);
  if (pendingPaste?.signature !== signature) pendingPaste = { signature, op: op() };
  try {
    await api('paste', 'POST', { text, speaker, mode: el('speech-mode').value, op: pendingPaste.op });
    pendingPaste = null;
    if (el('source').value.trim() === text && (el('paste-speaker').value || null) === speaker) {
      el('source').value = '';
      el('paste-form').hidden = true;
      el('paste-open').setAttribute('aria-expanded', 'false');
      el('paste-open').focus();
      savePaste();
    }
    toast('发言已保存，正在提炼');
  } catch (err) {
    toast(err.message, true);
  } finally {
    submit.disabled = false;
  }
};
el('retry').onclick = async () => {
  try {
    await api('retry', 'POST', {});
  } catch (e) {
    toast(e.message, true);
  }
};
async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId);
    const select = el('device'), previous = select.value;
    select.replaceChildren(option('系统默认麦克风',''), ...devices.filter(d=>d.deviceId !== 'default').map((d,i)=>option(d.label || '麦克风 ' + (i+1), d.deviceId)));
    if ([...select.options].some(o=>o.value === previous)) select.value = previous;
  } catch {}
}
el('audio-settings').ontoggle = () => { if (el('audio-settings').open) refreshDevices(); };
el('record').onclick = async () => {
  if (['recording', 'buffering'].includes(mic.phase)) {
    pausedByOperator = true;
    return mic.stop();
  }
  if (checkingMic || mic.phase !== 'idle' || audio.state !== 'idle') return;
  checkingMic = true;
  updateRecording();
  try {
    const s = await api('services');
    if (audio.state !== 'idle') return;
    asrReady = s.asrReady;
    if (!asrReady) {
      el('asr-note').textContent = '请在后台 ~/.config/jinju-buddy/asr.env 填写腾讯云 AppID、SecretId 和 SecretKey，保存后再开始收音。';
      el('asr-note').hidden = false;
      return;
    }
    el('asr-note').hidden = true;
    await mic.start({ mode: el('speech-mode').value, deviceId: el('device').value });
    pausedByOperator = false;
    refreshDevices();
  } catch (e) {
    el('asr-note').textContent = e.message; el('asr-note').hidden = false;
    toast(e.message, true);
  } finally {
    checkingMic = false;
    updateRecording();
  }
};
window.addEventListener('pagehide', () => {
  if (mic.phase !== 'idle') mic.release();
});
function clearSelection() {
  fileRevision++;
  if (selectedFile) URL.revokeObjectURL(selectedFile.url);
  selectedFile = null;
  decodingFile = '';
  renderQr();
}
async function selectFile(file) {
  if (!file || publishing) return;
  clearSelection();
  const token = fileRevision;
  if (file.size > 8 * 1024 * 1024 || !/^(image\/(png|jpeg))$/.test(file.type))
    return toast('请选择 8 MB 以内的 PNG 或 JPG 图片', true);
  decodingFile = file.name;
  const chosen = { file, url: URL.createObjectURL(file), op: op(), revision: qrRevision };
  selectedFile = chosen;
  renderQr();
  try {
    const response = await fetch(base + '/api/qr/inspect', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const { target, pitch } = await ledQr(chosen.url);
    if (target !== data.target) throw new Error('LED 预览与上传图片的扫码目标不同，请换图重试。');
    chosen.pitch = pitch;
    chosen.target = target;
    chosen.verified = true;
  } catch (e) {
    chosen.problem = e.message || '识别失败，请重新选图';
  }
  if (token !== fileRevision) return;
  decodingFile = '';
  renderQr();
}
el('cancel-file').onclick = () => {
  clearSelection();
  el('qr-file').focus();
};
function describeRemoval() {
  el('qr-dialog-detail').textContent =
    screen.kind === 'qr' && screen.image === lastQr
      ? '这张二维码已发布到大屏。删除后大屏将回到待场，上传新图前可以撤销删除。'
      : '删除后可以在上传新图前撤销。';
}
el('remove-qr').onclick = () => {
  if (!lastQr || publishing) return;
  confirmingRevision = qrRevision;
  describeRemoval();
  el('qr-dialog').showModal();
};
el('keep-qr').onclick = () => el('qr-dialog').close();
async function changeQr(action, revision) {
  if (publishing) return;
  if (pendingQr?.action !== action || pendingQr.revision !== revision)
    pendingQr = { action, revision, op: op() };
  publishing = true;
  updatePresence();
  try {
    const result = await api('qr/' + action, 'POST', { op: pendingQr.op, qrRevision: revision });
    pendingQr = null;
    setScreen(result.screen, result.history, result.qrRevision);
    setQrState(result);
    const removed = action === 'remove';
    toast(removed ? '二维码已删除' : '二维码已恢复，可手动展示');
  } catch (error) {
    if (error.status === 409)
      await api('control')
        .then(snapshot)
        .catch(() => {});
    toast(error.message, true);
  } finally {
    publishing = false;
    updatePresence();
    const nextFocus = canRestoreQr ? 'restore-qr' : lastQr ? 'remove-qr' : 'qr-file';
    el(nextFocus).focus();
  }
}
el('confirm-remove').onclick = () => {
  el('qr-dialog').close();
  changeQr('remove', confirmingRevision);
};
el('restore-qr').onclick = () => changeQr('restore', qrRevision);
el('qr-file').onchange = (e) => {
  selectFile(e.target.files[0]);
  e.target.value = '';
};
const zone = el('file-zone');
zone.ondragover = (e) => {
  e.preventDefault();
  zone.classList.add('drag');
};
zone.ondragleave = () => zone.classList.remove('drag');
zone.ondrop = (e) => {
  e.preventDefault();
  zone.classList.remove('drag');
  selectFile(e.dataTransfer.files[0]);
};
el('upload').onclick = async () => {
  if (!selectedFile?.verified || selectedFile.revision !== qrRevision || publishing) return;
  const current = selectedFile;
  publishing = true;
  el('upload').disabled = true;
  el('upload').textContent = '正在上传…';
  updatePresence();
  try {
    const r = await fetch(base + '/api/qr', {
      method: 'POST',
      headers: {
        'Content-Type': current.file.type,
        'X-Operation-Id': current.op,
        'X-QR-Revision': String(current.revision),
      },
      body: current.file,
    });
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.error), { status: r.status });
    if (current === selectedFile) clearSelection();
    setQrState(data);
    setScreen(data.screen, data.history, data.qrRevision);
    publishFeedback(data.screen.version);
  } catch (e) {
    if (e.status === 409)
      await api('control')
        .then(snapshot)
        .catch(() => {});
    toast(e.message || '二维码上传失败，请重试', true);
  } finally {
    publishing = false;
    el('upload').textContent = '上传并展示';
    updatePresence();
  }
};
async function enter() {
  const state = await api('control');
  el('login').hidden = true;
  el('workspace').hidden = false;
  snapshot(state);
  if (!live)
    live = connect(
      'control',
      (message) => {
        if (message.type === 'snapshot') connected = true;
        event(message);
      },
      (ok) => {
        if (!ok) connected = false;
        updatePresence();
      }
    );
}
async function boot() {
  try {
    await enter();
    return;
  } catch (e) {
    if (e.status !== 401) {
      el('login-error').textContent = e.message;
      el('login').hidden = false;
      return;
    }
  }
  try {
    await api('login', 'POST', { local: true, guest: true });
    await enter();
  } catch (e) {
    el('login').hidden = false;
    if (e.status !== 401) el('login-error').textContent = e.message;
  }
}
el('login-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('login', 'POST', { password: el('pass').value });
    el('pass').value = '';
    await enter();
  } catch (err) {
    el('login-error').textContent = err.message;
  }
};
el('quote').value = quoteText(loadDraft(draftKey));
el('source').value = pasteDraft?.text || '';
el('paste-form').hidden = !pasteDraft?.open;
el('paste-open').setAttribute('aria-expanded', String(!el('paste-form').hidden));
count();
fontReady.then(() => {
  fontLoaded = true;
  scheduleLists();
  count();
  renderHistory();
  updatePresence();
});
el('shortcut').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
boot();
