// Keep the full transcript selectable while replacing only the current recognition preview.
const order = (a, b) =>
  a.startMs - b.startMs || a.endMs - b.endMs || String(a.id).localeCompare(String(b.id));
function append(text, previous, row) {
  const body = row.correctedBody ?? row.body;
  if (!previous) return body;
  const newParagraph =
    !row.stream ||
    row.stream !== previous.stream ||
    row.startMs - previous.endMs > 6500 ||
    (row.speaker && previous.speaker && row.speaker !== previous.speaker) ||
    (!row.speaker && !previous.speaker && row.mode === 'debate');
  const needsSpace = /[a-z0-9]$/i.test(previous.correctedBody ?? previous.body) && /^[a-z0-9]/i.test(body);
  return text + (newParagraph ? '\n\n' : needsSpace ? ' ' : '') + body;
}
function joinRows(rows) {
  let text = '',
    previous;
  for (const row of rows) {
    text = append(text, previous, row);
    previous = row;
  }
  return text;
}
export class LiveTranscript {
  constructor(field, clearButton) {
    this.field = field;
    this.clearButton = clearButton;
    this.clearRevision = 0;
    this.clearedThrough = 0;
    this.clearedDrafts = new Set();
    this.finals = [];
    this.ids = new Set();
    this.drafts = [];
    this.finalText = '';
    this.follow = true;
    field.addEventListener('scroll', () => {
      this.follow = field.scrollHeight - field.clientHeight - field.scrollTop < 6;
    });
    new ResizeObserver(() => {
      if (this.follow && field.selectionStart === field.selectionEnd) field.scrollTop = field.scrollHeight;
    }).observe(field);
  }
  applyClear(boundary) {
    if (!boundary || boundary.revision <= this.clearRevision) return false;
    this.clearRevision = boundary.revision;
    this.clearedThrough = boundary.through;
    this.clearedDrafts = new Set(boundary.draftIds);
    this.field.placeholder = '下一段发言会显示在这里。';
    this.setDrafts(this.drafts);
    this.setFinals(this.finals);
    return true;
  }
  setFinals(orderedRows) {
    this.finals = this.clearRevision
      ? orderedRows.filter(row => row.sequence > this.clearedThrough && !this.clearedDrafts.has(row.id))
      : orderedRows;
    this.ids = new Set(this.finals.map((r) => r.id));
    this.finalText = joinRows(this.finals);
    this.render();
  }
  setDrafts(drafts) {
    if (this.clearedDrafts.size) drafts = drafts.filter(row => !this.clearedDrafts.has(row.id));
    const key = JSON.stringify(drafts.map((r) => [r.id, r.speaker, r.startMs, r.endMs, r.body]));
    if (this.draftKey === key) return;
    this.draftKey = key;
    this.drafts = drafts;
    this.render();
  }
  selection() {
    const {selectionStart:start,selectionEnd:end,value} = this.field;
    if (start === end) return null;
    const rows = [...this.finals,...this.drafts.filter(r=>!this.ids.has(r.id))].sort(order);
    const refs = [];
    let offset = 0, previous;
    for (const row of rows) {
      const body = row.correctedBody ?? row.body;
      const size = append('',previous,row).length;
      const from = offset + size - body.length, until = offset + size;
      if (until > start && from < end) {
        if (!this.ids.has(row.id) || row.status === 'unconfirmed') return null;
        refs.push({id:row.id,rev:row.rev,start:Math.max(0,start-from),end:Math.min(body.length,end-from)});
      }
      previous = row;
      offset = until;
      if (offset >= end) break;
    }
    return refs.length ? {refs,text:value.slice(start,end)} : null;
  }
  render() {
    const drafts = this.drafts.filter((r) => !this.ids.has(r.id)).sort(order);
    let text = this.finalText;
    let previous = this.finals.at(-1);
    if (previous && drafts.length && order(drafts[0], previous) < 0) {
      text = joinRows([...this.finals, ...drafts].sort(order));
    } else {
      for (const row of drafts) {
        text = append(text, previous, row);
        previous = row;
      }
    }
    const field = this.field;
    this.clearButton.disabled = !text || this.clearButton.hasAttribute('aria-busy');
    if (field.value === text) return;
    const top = field.scrollTop;
    const start = field.selectionStart,
      end = field.selectionEnd,
      direction = field.selectionDirection;
    const follow = field.scrollHeight - field.clientHeight - top < 6 && start === end;
    const selection = field.value.slice(start, end);
    field.value = text;
    if (selection || document.activeElement === field) {
      let position = Math.min(start, text.length);
      if (selection && text.slice(position, position + selection.length) !== selection) {
        const match = text.indexOf(selection);
        if (match >= 0 && match === text.lastIndexOf(selection)) position = match;
      }
      field.setSelectionRange(position, position + selection.length, direction);
    }
    field.scrollTop = follow ? field.scrollHeight : top;
  }
}
