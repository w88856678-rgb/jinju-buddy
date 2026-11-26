export const base = location.pathname.replace(/\/(control|stage)\/?$/, '');
const paths = {
  screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  external: '<path d="M7 17 18 6M9 6h9v9"/>',
  pen: '<path d="m4 16-1 5 5-1L20 8l-4-4zM14 6l4 4"/>',
  send: '<path d="m21 3-7 18-3-8-8-3 18-7ZM11 13 21 3"/>',
  wave: '<path d="M2 10v4m4-7v10m4-14v18m4-16v14m4-11v8m4-6v4"/>',
  play: '<path d="M7 4.5 19 12 7 19.5Z" fill="currentColor" stroke-linejoin="round"/>',
  pause: '<path d="M8 5.5v13m8-13v13" stroke-width="4.5" stroke-linecap="round"/>',
  paste:
    '<rect x="5" y="5" width="14" height="16" rx="2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M8.5 12h7m-7 4h5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  copy: '<rect x="8" y="8" width="11" height="13" rx="2"/><path d="M15 8V4H4v12h4"/>',
  qr: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h2v3h-2zm5 0h2v3m-3 2h3v2h-7v-2"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  expand: '<path d="M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  undo: '<path d="m9 5-5 5 5 5m-5-5h10a6 6 0 0 1 0 12" transform="translate(0 -1)"/>',
  notes: '<path d="M5 3h11l3 3v15H5zM8 9h7m-7 4h8m-8 4h5"/>',
  sort: '<path d="M4 6h16M4 12h11M4 18h6"/>',
};
export function decorate(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      (paths[el.dataset.icon] || '') +
      '</svg>';
  });
}
export async function api(path, method = 'GET', data) {
  const options = { method, cache: 'no-store' };
  if (data !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(data);
  }
  const r = await fetch(base + '/api/' + path, options);
  let result;
  try {
    result = await r.json();
  } catch {
    throw new Error('后台连接中断，请稍后重试');
  }
  if (!r.ok) throw Object.assign(new Error(result.error), { status: r.status });
  return result;
}
export function socketUrl(role) {
  const url = new URL(base + '/live', location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', role);
  return url.href;
}
export function connect(role, onMessage, onStatus) {
  let ws,
    delay = 400,
    timer,
    stopped = false;
  function open() {
    if (stopped) return;
    ws = new WebSocket(socketUrl(role));
    ws.onopen = () => {
      delay = 400;
      onStatus(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch (error) {
        console.error('无法更新显示', error.name);
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!stopped) {
        timer = setTimeout(open, delay);
        delay = Math.min(delay * 1.6, 5000);
      }
    };
    ws.onerror = () => ws.close();
  }
  open();
  return {
    send: (data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
export const imageUrl = (id) => base + '/qr/' + id + '.png';
export function op() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (v) => v.toString(16).padStart(2, '0')).join('');
}
