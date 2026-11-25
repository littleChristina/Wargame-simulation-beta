// 联机自测：node test/net.test.js
// 零依赖：启动真实 HTTP 服务（随机端口），用 fetch 建双客户端、读 SSE、发 POST 指令。
import assert from 'node:assert/strict';
import { createGameServer } from '../server/http.js';
import { scenario } from '../src/data/scenario.js';
import { MODE } from '../src/engine/setup.js';
import { pendingOwnerSide } from '../src/ai/ai-player.js';
import { decodeState } from '../src/net/wire.js';

let pass = 0, fail = 0;
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

async function api(base, apiPath, body) {
  const res = await fetch(base + apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function createPvp(base, seed = 123) {
  const r = await api(base, '/api/create', { setup: { mode: MODE.PVP, p1Side: 'attacker' }, seed });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}
async function joinRoom(base, code) {
  const r = await api(base, '/api/join', { code });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}
async function send(base, code, token, cmd) {
  return api(base, '/api/cmd', { code, token, cmd });
}

// SSE 客户端：收集 data: 消息，支持按谓词等待
function openSse(base, code, token) {
  const ctrl = new AbortController();
  const messages = [];
  const waiters = [];
  let opened = false;
  const ready = (async () => {
    const res = await fetch(`${base}/api/events?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`,
      { signal: ctrl.signal });
    assert.equal(res.status, 200, 'SSE 连接失败 ' + res.status);
    opened = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.split('\n').find(l => l.startsWith('data: '));
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line.slice(6)); } catch { continue; }
            messages.push(msg);
            for (const w of [...waiters]) {
              if (w.pred(msg)) {
                waiters.splice(waiters.indexOf(w), 1);
                clearTimeout(w.timer);
                w.resolve(msg);
              }
            }
          }
        }
      } catch { /* aborted / server closed */ }
    })();
  })();
  return {
    messages,
    ready,
    isOpen: () => opened,
    wait(pred, timeout = 5000) {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('SSE 等待超时'));
        }, timeout);
        waiters.push(w);
      });
    },
    close() { ctrl.abort(); },
  };
}

const snapState = msg => (msg.t === 'snapshot' && msg.state) ? decodeState(msg.state) : null;

// ---------- 用例 ----------
await test('联机：创建/加入/双端连接后开局，座位与阵营正确', () => withServer(async base => {
  const host = await createPvp(base);
  assert.equal(host.code.length, 4);
  assert.equal(host.seat.id, 'P1');
  assert.equal(host.seat.side, 'attacker');

  const a = openSse(base, host.code, host.token);
  await a.ready;
  const helloA = await a.wait(m => m.t === 'hello');
  assert.equal(helloA.seat.id, 'P1');
  const waiting = await a.wait(m => m.t === 'snapshot');
  assert.equal(waiting.state, null, '第二人未加入前不开局');

  const guest = await joinRoom(base, host.code);
  assert.equal(guest.seat.id, 'P2');
  assert.equal(guest.seat.side, 'defender');

  const b = openSse(base, guest.code, guest.token);
  await b.ready;
  const startedA = await a.wait(m => m.t === 'snapshot' && !!m.state);
  const startedB = await b.wait(m => m.t === 'snapshot' && !!m.state);
  const st = decodeState(startedA.state);
  assert.equal(st.activeSide, 'attacker');
  assert.equal(st.phase, 'move');
  assert.equal(st.meta.mode, MODE.PVP);
  assert.equal(st.units.length, 24);
  assert.ok(st.bigRiver instanceof Set && st.bigRiver.size > 0, 'Set 应还原');
  assert.equal(startedA.room.seats.length, 2);
  assert.equal(startedB.room.seats.filter(s => s.connected).length, 2);
  a.close(); b.close();
}));

await test('联机：移动/回合推进与越权指令拒绝', () => withServer(async base => {
  const host = await createPvp(base);
  const a = openSse(base, host.code, host.token); await a.ready;
  const guest = await joinRoom(base, host.code);
  const b = openSse(base, guest.code, guest.token); await b.ready;
  await a.wait(m => m.t === 'snapshot' && !!m.state);

  // 攻方移动步兵5 (7,10) → (6,9)
  const mv = await send(base, host.code, host.token, { t: 'move', unitId: 'attacker-infantry-5', col: 6, row: 9 });
  assert.equal(mv.status, 200, JSON.stringify(mv.json));
  const moved = await a.wait(m => {
    const s = snapState(m);
    if (!s) return false;
    const u = s.units.find(x => x.id === 'attacker-infantry-5');
    return u && u.col === 6 && u.row === 9;
  });
  assert.equal(decodeState(moved.state).units.find(u => u.id === 'attacker-infantry-5').col, 6);

  // 守方在攻方回合发指令 → 拒绝
  const bad = await send(base, host.code, guest.token, { t: 'endPhase' });
  assert.equal(bad.status, 400);
  assert.match(String(bad.json.error), /不是你方行动/);

  // 攻方结束移动、再结束战斗 → 守方回合
  assert.equal((await send(base, host.code, host.token, { t: 'endPhase' })).status, 200);
  await a.wait(m => (snapState(m) || {}).phase === 'combat');
  assert.equal((await send(base, host.code, host.token, { t: 'endPhase' })).status, 200);
  const defenderTurn = await a.wait(m => { const s = snapState(m); return s && s.activeSide === 'defender'; });
  assert.equal(defenderTurn.state.activeSide, 'defender');

  // 守方尝试移动攻方单位 → 越权
  const wrong = await send(base, host.code, guest.token, { t: 'move', unitId: 'attacker-infantry-1', col: 2, row: 9 });
  assert.equal(wrong.status, 400);
  assert.match(String(wrong.json.error), /对方单位|不能操作/);

  // 守方正常结束自己的移动/战斗
  assert.equal((await send(base, host.code, guest.token, { t: 'endPhase' })).status, 200);
  await a.wait(m => { const s = snapState(m); return s && s.activeSide === 'defender' && s.phase === 'combat'; });
  assert.equal((await send(base, host.code, guest.token, { t: 'endPhase' })).status, 200);
  const nextTurn = await a.wait(m => { const s = snapState(m); return s && s.turn === 2 && s.activeSide === 'attacker'; });
  assert.ok(nextTurn);
  a.close(); b.close();
}));

await test('联机：重连（同一 token）与 resume', () => withServer(async base => {
  const host = await createPvp(base);
  const a = openSse(base, host.code, host.token); await a.ready;
  const guest = await joinRoom(base, host.code);
  const b = openSse(base, guest.code, guest.token); await b.ready;
  await a.wait(m => m.t === 'snapshot' && !!m.state);

  const res = await api(base, '/api/resume', { code: host.code, token: host.token });
  assert.equal(res.status, 200);
  assert.equal(res.json.started, true);
  assert.equal(res.json.seat.id, 'P1');

  a.close();
  await new Promise(r => setTimeout(r, 80));
  const again = openSse(base, host.code, host.token);
  await again.ready;
  await again.wait(m => m.t === 'hello');
  const snap = await again.wait(m => m.t === 'snapshot' && !!m.state);
  assert.equal(snap.room.seats.find(s => s.id === 'P1').connected, true);
  assert.equal(decodeState(snap.state).units.length, 24);
  again.close(); b.close();
}));

await test('联机：合作 PVE 由服务端自动驱动 AI 先手', () => withServer(async base => {
  const r = await api(base, '/api/create', {
    setup: { mode: MODE.COOP_PVE, p1Side: 'defender' }, seed: 42,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const host = r.json;
  const a = openSse(base, host.code, host.token); await a.ready;
  const guest = await joinRoom(base, host.code);
  const b = openSse(base, guest.code, guest.token); await b.ready;
  await a.wait(m => m.t === 'snapshot' && !!m.state);

  // AI 执攻方先手；服务端跑完后要么交还守方回合，要么停在守方应手
  const settled = await a.wait(m => {
    const msg = m;
    if (msg.t !== 'snapshot' || !msg.state || msg.aiRunning) return false;
    const s = decodeState(msg.state);
    if (s.over) return true;
    if (s.pending) return pendingOwnerSide(s, s.pending) === 'defender';
    return s.activeSide === 'defender';
  }, 8000);
  const st = decodeState(settled.state);
  assert.ok(st.log.some(l => l.includes('【移动】') || l.includes('【战斗】') || l.includes('【炮击】')),
    'AI 应已行动');
  assert.ok(st.over
    || st.activeSide === 'defender'
    || (st.pending && pendingOwnerSide(st, st.pending) === 'defender'),
    'AI 应把行动权交还守方（或已终局）');
  a.close(); b.close();
}));

await test('联机：SSE 鉴权、静态白名单与页面安全头', () => withServer(async base => {
  const host = await createPvp(base);
  const bad = await fetch(`${base}/api/events?code=${host.code}&token=nope`);
  assert.equal(bad.status, 403);
  await bad.body?.cancel();

  const cmdBad = await api(base, '/api/cmd', { code: host.code, token: 'nope', cmd: { t: 'endPhase' } });
  assert.equal(cmdBad.status, 403);

  for (const p of ['/.git/config', '/test/ui.test.js', '/server/http.js', '/README.md', '/package.json']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p + ' 不应被静态服务');
    await r.body?.cancel();
  }
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /兵棋《渡口》/);
  assert.ok(page.headers.get('content-security-policy'), '应带 CSP');
  const js = await fetch(base + '/src/ui/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
  await js.body?.cancel();
}));

console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : fail + ' FAILED, ' + pass + ' passed');
process.exit(fail === 0 ? 0 : 1);
