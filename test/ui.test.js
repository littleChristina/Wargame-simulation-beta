// 界面点击链路自测：node test/ui.test.js（零依赖假 DOM，不渲染像素）
// 覆盖网页端才有的回归：
//   U1 移入堆叠后从堆叠选择栏选中另一单位并继续操作（pickStack）
//   U2 阶段切换清空选中/攻击预览/堆叠栏（陈旧交互态）
//   U3 多单位撤退时人类守方有"选择撤退单位"入口（retreatBegin）
//   U4 人类回合内、应手属于 AI 时 app 自动驱动 aiStep 结算
//   U5 AI 先手（人类守方）结束后不会停在"AI 该动却没动"的状态
//   U6 联机：移动发指令而不是本地改状态，收到快照后镜像更新
//   U7 联机：非我方回合不能操作；我方回合的操作路由到服务端指令
//   U8 联机合作：准备按钮走服务端、队友准备状态来自快照
import assert from 'node:assert/strict';
import { hexCenter } from '../src/ui/renderer.js';
import { initApp } from '../src/ui/app.js';
import { scenario } from '../src/data/scenario.js';
import { createGame, endPhase, moveUnit } from '../src/engine/engine.js';
import { declareAttack, currentRetreatUnitId } from '../src/engine/combat.js';
import { MODE } from '../src/engine/setup.js';
import { pendingOwnerSide } from '../src/ai/ai-player.js';
import { findUnit, unitsAt } from '../src/engine/state.js';
import { encodeState } from '../src/net/wire.js';

// ---------- 假 DOM ----------
const ELEMENT_IDS = ['status', 'actions', 'info', 'stackbar', 'pending', 'log', 'flash'];

function makeCtx() {
  return new Proxy({}, {
    get(t, p) {
      if (p in t) return t[p];
      return (t[p] = () => {});   // 所有 Canvas 2D 方法空实现
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', scrollTop: 0, scrollHeight: 120, listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  };
}

// 每个用例一套独立环境：监听器不串到别的对局
function makeEnv() {
  const els = {};
  for (const id of ELEMENT_IDS) els[id] = makeEl(id);
  const canvas = {
    width: 0, height: 0, listeners: {}, ctx: makeCtx(),
    getContext() { return this.ctx; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; },
  };
  globalThis.window = {};
  globalThis.document = {
    getElementById: id => (id === 'map' ? canvas : els[id]),
    querySelector: sel => ({
      '#actions': els.actions, '#info': els.info, '#stackbar': els.stackbar, '#pending': els.pending,
    }[sel]),
  };

  function clickHex(col, row) {
    const c = hexCenter(col, row);
    for (const fn of canvas.listeners.click || []) fn({ clientX: c.x, clientY: c.y });
  }
  // 模拟点击某个面板里的 data-action 按钮（不需要真实 innerHTML 解析）
  function clickBtn(sel, action, data = {}) {
    const host = globalThis.document.querySelector(sel);
    const btn = {
      dataset: { action, ...data },
      disabled: false,
      closest(s) { return s === '[data-action]' ? btn : null; },
    };
    const target = { closest(s) { return s === '[data-action]' ? btn : null; } };
    for (const fn of host.listeners.click || []) fn({ target });
  }
  return { els, canvas, clickHex, clickBtn };
}

function start(env, setup, seed = 20261124) {
  return initApp(env.canvas, scenario, seed, setup, { aiStepDelayMs: 0 });
}

// 联机用假传输：记录客户端发出的指令，手工推快照
function fakeNet() {
  const handlers = new Set();
  const net = {
    code: 'TEST', token: 'fake', sent: [],
    onMessage(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    onError() {},
    send(cmd) { net.sent.push(cmd); return Promise.resolve({ ok: true, seq: net.sent.length }); },
    close() {},
    push(msg) { for (const fn of [...handlers]) fn(msg); },
  };
  return net;
}
function snapshotOf(st, extra = {}) {
  return {
    t: 'snapshot', seq: 1, state: encodeState(st), aiRunning: false,
    ready: { P1: false, P2: false },
    room: { code: 'TEST', mode: st.meta ? st.meta.mode : 'pvp', started: true, seats: [] },
    ...extra,
  };
}
function startOnline(env, net, seat, snapshot) {
  return initApp(env.canvas, scenario, 0, null, { net, seat, initialSnapshot: snapshot });
}

async function waitFor(fn, timeout = 2000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('等待条件超时');
    await new Promise(res => setTimeout(res, 5));
  }
}

// ---------- 用例辅助 ----------
function put(st, id, col, row) {
  const u = findUnit(st, id);
  assert.ok(u, '找不到单位 ' + id);
  u.col = col; u.row = row; u.supplied = true;
  return u;
}
function isolate(st, keep) {
  for (const u of st.units) if (!keep.includes(u.id)) u.dead = true;
}
// 造一个相邻战斗局面（人类攻方），用于搜索指定 CRT 结果的种子
function craftAttack(st, { attackers, defenders }) {
  isolate(st, [...attackers, ...defenders]);
  for (const id of defenders) put(st, id, 7, 4);
  put(st, attackers[0], 8, 4);
  put(st, attackers[1], 7, 3);
  st.phase = 'combat';
  st.pending = null;
}
function findSeed(setup, craft, attackers, wanted) {
  for (let s = 1; s <= 1000; s++) {
    const st = createGame(scenario, s, setup);
    craft(st);
    let p;
    try { p = declareAttack(st, attackers, { col: 7, row: 4 }); } catch { continue; }
    if (wanted.includes(p.result)) return s;
  }
  throw new Error('找不到结果为 ' + wanted.join('/') + ' 的种子');
}

// ---------- 测试 ----------
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' :: ' + String(e && e.message || e)); fail++; }
}

await test('U1 堆叠：移入后可从堆叠栏选中另一单位', () => {
  const env = makeEnv();
  const app = start(env, { mode: MODE.SOLO_PVE, p1Side: 'attacker' }, 20261124);
  const st = app.getState();
  const ui = app.getUi();
  // 步兵5 (7,10) → 步兵4 所在格 (6,9)
  env.clickHex(7, 10);
  assert.equal(ui.selectedId, 'attacker-infantry-5', '应选中步兵5');
  env.clickHex(6, 9);
  assert.equal(unitsAt(st, 6, 9).length, 2, '两支部队应堆叠在同一格');
  assert.ok(env.els.stackbar.innerHTML.includes('data-unit="attacker-infantry-4"'), '堆叠栏应列出步兵4');
  assert.ok(env.els.stackbar.innerHTML.includes('data-unit="attacker-infantry-5"'), '堆叠栏应列出步兵5');
  env.clickBtn('#stackbar', 'pickStack', { unit: 'attacker-infantry-4' });
  assert.equal(ui.selectedId, 'attacker-infantry-4', '堆叠栏应能选中步兵4');
  // 选中后仍可继续移动该单位（到相邻空平原格）
  env.clickHex(7, 10);
  assert.equal(unitsAt(st, 7, 10).some(u => u.id === 'attacker-infantry-4'), true, '步兵4应能继续移动');
});

await test('U2 阶段切换清空选中/攻击预览/堆叠栏', () => {
  const env = makeEnv();
  const app = start(env, { mode: MODE.SOLO_PVE, p1Side: 'attacker' }, 20261124);
  const ui = app.getUi();
  env.clickHex(7, 10);
  env.clickHex(6, 9);   // 形成堆叠
  env.clickBtn('#stackbar', 'pickStack', { unit: 'attacker-infantry-4' });
  assert.ok(ui.selectedId, '阶段结束前应有选中单位');
  env.clickBtn('#actions', 'endMove');
  assert.equal(app.getState().phase, 'combat', '应进入战斗阶段');
  assert.equal(ui.selectedId, null, '阶段结束应清空选中');
  assert.equal(ui.attackSel, null, '阶段结束应清空攻击预览');
  assert.equal(ui.stackChoices, null, '阶段结束应清空堆叠栏');
  assert.equal(ui.mode, 'idle');
});

await test('U3 撤退：多单位撤退时人类可选择撤退单位', () => {
  const setup = { mode: MODE.PVP, p1Side: 'attacker' };   // 双方人类，无 AI 抢答
  const attackers = ['attacker-armor-1', 'attacker-infantry-1'];
  const defenders = ['defender-infantry-1', 'defender-infantry-2'];
  const craft = st => craftAttack(st, { attackers, defenders });
  const seed = findSeed(setup, craft, attackers, ['DR', 'DRR', 'DR1', 'DRR1']);

  const env = makeEnv();
  const app = start(env, setup, seed);
  const st = app.getState();
  craft(st);
  declareAttack(st, attackers, { col: 7, row: 4 });
  assert.equal(st.pending.step, 'retreat');
  assert.equal(currentRetreatUnitId(st), null, '多单位时应先由玩家选择');
  // 触发一次渲染（点空地）
  env.clickHex(0, 0);
  const html = env.els.pending.innerHTML;
  assert.ok(html.includes('data-action="retreatBegin"'), '面板应提供撤退单位选择');
  assert.ok(html.includes('data-unit="defender-infantry-1"'), '应列出第1个守军');
  assert.ok(html.includes('data-unit="defender-infantry-2"'), '应列出第2个守军');
  env.clickBtn('#pending', 'retreatBegin', { unit: 'defender-infantry-1' });
  assert.equal(currentRetreatUnitId(st), 'defender-infantry-1', '选中的单位应开始逐格撤退');
  assert.ok(env.els.pending.innerHTML.includes('绿色高亮格'), '选定后提示逐格撤退');
});

await test('U4 应手：人类回合内 AI 守军自动结算', async () => {
  const setup = { mode: MODE.SOLO_PVE, p1Side: 'attacker' };
  const attackers = ['attacker-infantry-1', 'attacker-infantry-2'];
  const defenders = ['defender-infantry-1'];
  const craft = st => craftAttack(st, { attackers, defenders });
  const seed = findSeed(setup, craft, attackers, ['DR', 'DRR', 'DR1', 'DRR1']);

  const env = makeEnv();
  const app = start(env, setup, seed);
  const st = app.getState();
  craft(st);
  // 通过真实 UI 点击发起攻击：点敌格 → 确认攻击
  env.clickHex(7, 4);
  assert.ok(app.getUi().attackSel, '应打开攻击预览');
  env.clickBtn('#info', 'confirmAttack');
  assert.ok(st.pending || st.log.some(l => l.includes('【战斗】')), '攻击应已宣告');
  await waitFor(() => !app.getUi().aiRunning);
  assert.ok(!st.pending || pendingOwnerSide(st, st.pending) === 'attacker', 'AI 守方不应再欠应手');
  assert.ok(st.log.some(l => l.includes('【撤退】') || l.includes('【损步】')), 'AI 应已分配步损/撤退');
});

await test('U5 PVE 人类守方：AI 先手结束后不会停在"AI 该动却没动"', async () => {
  for (const seed of [1, 2, 3, 7, 42]) {
    const env = makeEnv();
    const app = start(env, { mode: MODE.SOLO_PVE, p1Side: 'defender' }, seed);
    const st = app.getState();
    await waitFor(() => !app.getUi().aiRunning, 5000);
    assert.ok(st.over || st.activeSide === 'defender' || st.pending,
      `种子 ${seed}：AI 空闲时必须已交还人类回合或人类应手`);
    if (st.pending) {
      assert.equal(pendingOwnerSide(st, st.pending), 'defender', `种子 ${seed}：AI 不应欠应手`);
    }
  }
});

await test('U6 联机：移动只发指令，收到服务端快照才更新镜像', () => {
  const env = makeEnv();
  const hostState = createGame(scenario, 123, { mode: MODE.PVP, p1Side: 'attacker' });
  const net = fakeNet();
  const app = startOnline(env, net, { id: 'P1', side: 'attacker', commander: 'P1' }, snapshotOf(hostState));
  const ui = app.getUi();
  env.clickHex(7, 10);
  assert.equal(ui.selectedId, 'attacker-infantry-5');
  env.clickHex(6, 9);
  const mv = net.sent.find(c => c.t === 'move');
  assert.ok(mv, '应发送移动指令');
  assert.equal(mv.unitId, 'attacker-infantry-5');
  assert.equal(mv.col, 6);
  assert.equal(mv.row, 9);
  // 快照到达前，客户端不得本地改权威状态
  assert.equal(findUnit(app.getState(), 'attacker-infantry-5').col, 7);
  // 服务端执行后推快照
  const serverState = createGame(scenario, 123, { mode: MODE.PVP, p1Side: 'attacker' });
  moveUnit(serverState, 'attacker-infantry-5', { col: 6, row: 9 });
  net.push(snapshotOf(serverState));
  const u = findUnit(app.getState(), 'attacker-infantry-5');
  assert.equal(u.col, 6);
  assert.equal(u.row, 9);
  assert.equal(ui.netBusy, false, '快照应清掉同步中');
});

await test('U7 联机：非我方回合不发送；我方回合正常路由', () => {
  // 攻方回合、客户端是守方 P2：点守军不应有任何指令
  const stA = createGame(scenario, 123, { mode: MODE.PVP, p1Side: 'attacker' });
  const envA = makeEnv();
  const netA = fakeNet();
  const appA = startOnline(envA, netA, { id: 'P2', side: 'defender', commander: 'P2' }, snapshotOf(stA));
  envA.clickHex(3, 5);
  assert.equal(netA.sent.length, 0, '非我方回合不能发指令');
  assert.equal(appA.getUi().selectedId, null);

  // 守方回合（攻方结束移动+战斗后）
  const stB = createGame(scenario, 123, { mode: MODE.PVP, p1Side: 'attacker' });
  endPhase(stB); endPhase(stB);
  assert.equal(stB.activeSide, 'defender');
  assert.equal(stB.phase, 'move');
  const envB = makeEnv();
  const netB = fakeNet();
  const appB = startOnline(envB, netB, { id: 'P2', side: 'defender', commander: 'P2' }, snapshotOf(stB));
  envB.clickHex(3, 5);
  assert.equal(appB.getUi().selectedId, 'defender-infantry-2');
  envB.clickHex(3, 4);
  const mv = netB.sent.find(c => c.t === 'move');
  assert.ok(mv && mv.unitId === 'defender-infantry-2', '守方回合应发送移动指令');
  // 清掉同步中后再点攻方单位：不可操作、不得发指令
  netB.push(snapshotOf(stB));
  const before = netB.sent.length;
  envB.clickHex(7, 10);
  assert.equal(netB.sent.length, before, '不能操作对方单位');
});

await test('U8 联机合作：准备走服务端，队友状态来自快照', () => {
  const setup = {
    mode: MODE.COOP_PVE, p1Side: 'attacker',
    split: scenario.units.map((u, i) => (u.side === 'attacker' ? (i % 2 ? 'P2' : 'P1') : 'P2')),
  };
  const st = createGame(scenario, 7, setup);
  const env = makeEnv();
  const net = fakeNet();
  const app = startOnline(env, net, { id: 'P1', side: 'attacker', commander: 'P1' }, snapshotOf(st));
  const ui = app.getUi();
  assert.ok(env.els.actions.innerHTML.includes('我准备好了'), '合作联机应显示准备按钮');
  assert.ok(!env.els.actions.innerHTML.includes('切换操作'), '联机不能切换操作者');
  env.clickBtn('#actions', 'readyMove');
  const cmd = net.sent.find(c => c.t === 'ready');
  assert.ok(cmd, '准备应发给服务端');
  assert.equal(cmd.kind, 'move');
  net.push(snapshotOf(st, { ready: { P1: true, P2: false } }));
  assert.equal(ui.ready.P1, true);
  assert.ok(env.els.actions.innerHTML.includes('✓'), '准备后按钮应打勾');
  assert.ok(env.els.status.innerHTML.includes('等待队友'), '应提示等待队友');
});

console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : fail + ' FAILED, ' + pass + ' passed');
process.exit(fail === 0 ? 0 : 1);
