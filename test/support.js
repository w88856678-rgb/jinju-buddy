import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../server/app.js';

export async function until(check, timeout = 3500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(15);
  }
  throw new Error('等待测试条件超时');
}
export async function testApp(overrides = {}) {
  const dir = overrides.dir || (await mkdtemp(join(tmpdir(), 'buddy-rehearsal-')));
  const app = createApp({
    config: { id: 'rehearsal', name: '金句彩排', dir, localControl: true, tlsKey: null, tlsCert: null },
    credentials: () => ({ appId: '123456', secretId: 'example-id', secretKey: 'example-key', token: 'test' }),
    generate: async (s) => s.body,
    quoteTiming: { quietMs: 60, maxWaitMs: 240 },
    dialAsr: () => {
      throw new Error('此测试未设置模拟音频服务');
    },
    ...overrides,
  });
  app.server.listen(0, overrides.listenHost || '127.0.0.1');
  await once(app.server, 'listening');
  const url = 'http://127.0.0.1:' + app.server.address().port + app.base;
  const request = (path, data, cookie, headers = {}) =>
    fetch(url + '/api/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const login = await request('login', { local: true });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return {
    ...app,
    dir,
    url,
    cookie,
    request,
    call: (path, data) => request(path, data, cookie),
    async cleanup(keep = false) {
      await app.stop();
      if (!keep) await rm(dir, { recursive: true, force: true });
    },
  };
}
export async function mockCloud() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const connections = [];
  const signed = [];
  let readyDelay = 0;
  server.on('connection', (ws) => {
    const c = { ws, packets: [], times: [], ended: false };
    connections.push(c);
    ws.on('message', (buf, binary) => {
      if (binary) { c.packets.push(Buffer.from(buf)); c.times.push(Date.now()); }
      else if (JSON.parse(buf).type === 'end') {
        c.ended = true;
        c.onEnd?.();
      }
    });
    c.send = (data = {}) => ws.send(JSON.stringify({ code: 0, ...data }));
    const ready = () => { if (ws.readyState === WebSocket.OPEN) c.send({ speaker_context_id: 'fixture-context' }); };
    if (readyDelay) setTimeout(ready, readyDelay);
    else ready();
  });
  return {
    connections,
    signed,
    setReadyDelay(ms) { readyDelay = ms; },
    dial(url) {
      signed.push(new URL(url));
      return new WebSocket('ws://127.0.0.1:' + server.address().port);
    },
    async stop() {
      for (const ws of server.clients) ws.terminate();
      await new Promise((r) => server.close(r));
    },
  };
}
export function wire(app, role, authenticated = false) {
  const ws = new WebSocket(
    app.url.replace('http', 'ws') + '/live?role=' + role,
    authenticated ? { headers: { Cookie: app.cookie } } : {}
  );
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  return {
    ws,
    messages,
    wait: (fn) => until(() => messages.find(fn)),
    send: (m) => ws.send(JSON.stringify(m)),
  };
}
export function sentence(id, who, body, type = 1) {
  return {
    sentence_id: id,
    speaker_id: who,
    sentence_type: type,
    sentence: body,
    start_time: 1000 + id * 1800,
    end_time: 2100 + id * 1800,
  };
}
