// 大厅/恢复链路自测：node test/lobby.test.js
// 用假 DOM + fetch 流式 EventSource 桩，跑真实 HTTP 服务，验证：
//   创建 → 等待 → 客人加入 → 双方连上自动开局 → onGame 交棒
//   已开局房间刷新后凭 token 恢复
import assert from 'node:assert/strict';
import { createGameServer } from '../server/http.js';
import { scenario } from '../src/data/scenario.js';
import { MODE } from '../src/engine/setup.js';
import { startLanSession } from '../src/ui/lan-session.js';
import { decodeState } from '../src/net/wire.js';

let pass = 0, fail = 0;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function test(name, fn) {
  try { await fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' :: ' + String(e && e.message || e)); fail++; }
}

async function withServer(fn) {
  const app = createGameServer({ scenario, aiStepDelayMs: 0, logger: { error() {} } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try { return await fn(base); }
  finally { await app.close(); }
}

async function waitUntil(fn, timeout = 5000, step = 20) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > timeout) throw new Error('等待条件超时');
    await delay(step);
  }
}

// ---------- 假浏览器环境 ----------
function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', style: {}, listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  };
}

function setupBrowser(base) {
  const store = new Map();
  const realFetch = globalThis.fetch;
  const wrappedFetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    return realFetch(url.startsWith('http') ? url : base + url, init);
  };
  globalThis.fetch = wrappedFetch;
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  const byId = { 'lan-status': makeEl(), 'lan-link': makeEl() };
  globalThis.document = {
    getElementById: id => byId[id] || null,
    execCommand: () => true,
  };
  const u = new URL(base);
  globalThis.location = { protocol: 'http:', hostname: '127.0.0.1', port: u.port, origin: base, search: '' };
  globalThis.history = { replaceState() {} };
  globalThis.EventSource = makeFakeEventSource();

  const root = makeEl();
  const layout = makeEl();
  return {
    root, layout, store,
    storedRoom() {
      for (const [k, v] of store) {
        if (k.startsWith('dukou.room.')) return { code: k.slice('dukou.room.'.length), token: v };
      }
      return null;
    },
  };
}

// 用 fetch 流实现的 EventSource 桩：浏览器在真实环境会用原生 EventSource
function makeFakeEventSource() {
  return class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
      this.closed = false;
      this.ctrl = new AbortController();
      this._run = this._runLoop();
    }
    async _runLoop() {
      try {
        const res = await globalThis.fetch(this.url, { signal: this.ctrl.signal });
        if (!res.ok) { if (!this.closed && this.onerror) this.onerror(); return; }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (!this.closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.split('\n').find(l => l.startsWith('data: '));
            if (line && this.onmessage) this.onmessage({ data: line.slice(6) });
          }
        }
      } catch {
        if (!this.closed && this.onerror) this.onerror();
      }
    }
    close() { this.closed = true; this.ctrl.abort(); }
  };
}

async function apiJson(path, body) {
  const res = await globalThis.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------- 用例 ----------
await test('大厅：创建 → 等待 → 客人加入 → 自动开局 → onGame', () => withServer(async base => {
  const env = setupBrowser(base);
  let game = null;
  let resolveGame;
  const gameReady = new Promise(r => { resolveGame = r; });
  startLanSession({
    action: { kind: 'create', setup: { mode: MODE.PVP, p1Side: 'attacker' }, seed: 123 },
    root: env.root,
    layout: env.layout,
    onGame: info => { game = info; resolveGame(info); },
    onCancel: () => {},
  });

  await waitUntil(() => !!env.storedRoom());
  const host = env.storedRoom();
  // 房主 SSE 必须连上（双方都连上才开局）
  await waitUntil(async () => {
    const r = await apiJson('/api/resume', { code: host.code, token: host.token });
    return r.ok && r.room.seats.some(s => s.id === 'P1' && s.connected);
  });

  const guest = await apiJson('/api/join', { code: host.code });
  assert.equal(guest.ok, true, JSON.stringify(guest));
  const guestEs = new globalThis.EventSource(
    `/api/events?code=${guest.code}&token=${guest.token}`);
  guestEs.onmessage = () => {};

  await Promise.race([gameReady, delay(5000).then(() => { throw new Error('onGame 超时'); })]);
  assert.ok(game, '应收到 onGame 交棒');
  assert.equal(game.seat.id, 'P1');
  assert.equal(game.seat.side, 'attacker');
  const st = decodeState(game.snapshot.state);
  assert.equal(st.meta.mode, MODE.PVP);
  assert.equal(st.activeSide, 'attacker');
  assert.equal(st.phase, 'move');
  assert.equal(st.units.length, 24);

  game.client.close();
  guestEs.close();
}));

await test('大厅：已开局房间刷新后凭 token 恢复', () => withServer(async base => {
  const env = setupBrowser(base);
  // 直接用 API 建房 + 加入，并用两个假 SSE 连上触发开局
  const host = await apiJson('/api/create', {
    setup: { mode: MODE.PVP, p1Side: 'attacker' }, seed: 7,
  });
  assert.equal(host.ok, true, JSON.stringify(host));
  const guest = await apiJson('/api/join', { code: host.code });

  const hostEs = new globalThis.EventSource(
    `/api/events?code=${host.code}&token=${host.token}`);
  let started = null;
  const startedP = new Promise(resolve => {
    hostEs.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.t === 'snapshot' && msg.state) { started = msg; resolve(); }
    };
  });
  const guestEs = new globalThis.EventSource(
    `/api/events?code=${guest.code}&token=${guest.token}`);
  guestEs.onmessage = () => {};
  await Promise.race([startedP, delay(5000).then(() => { throw new Error('开局超时'); })]);
  assert.ok(started);

  // 模拟刷新：关掉房主旧连接，凭 token 恢复
  hostEs.close();
  await delay(80);

  let game = null;
  let resolveGame;
  const gameReady = new Promise(r => { resolveGame = r; });
  startLanSession({
    action: { kind: 'resume', code: host.code, token: host.token },
    root: env.root,
    layout: env.layout,
    onGame: info => { game = info; resolveGame(info); },
    onCancel: () => {},
  });
  await Promise.race([gameReady, delay(5000).then(() => { throw new Error('恢复超时'); })]);
  assert.ok(game, '恢复后应收到 onGame');
  assert.equal(game.seat.id, 'P1');
  const st = decodeState(game.snapshot.state);
  assert.equal(st.meta.mode, MODE.PVP);
  assert.equal(st.units.length, 24);

  game.client.close();
  guestEs.close();
}));

console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : fail + ' FAILED, ' + pass + ' passed');
process.exit(fail === 0 ? 0 : 1);
