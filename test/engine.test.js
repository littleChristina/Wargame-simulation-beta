// 自测套件：node test/engine.test.js（零依赖，直接运行）
import assert from 'node:assert/strict';
import { ROWS, rowForRatio, RESULT_INFO } from '../src/engine/crt.js';
import { UNIT_STATS, MAX_STACK, hexKey, canStopIn, unitsAt } from '../src/engine/state.js';
import { TERRAIN } from '../src/engine/terrain.js';
import { scenario } from '../src/data/scenario.js';
import { createGame, endPhase, moveUnit } from '../src/engine/engine.js';
import { computeReachable, stepCost } from '../src/engine/move.js';
import { computeSupplySet } from '../src/engine/supply.js';
import { strongZoc } from '../src/engine/zoc.js';
import { declareAttack, assignStep, commitAssign, beginRetreat, retreatStep,
         retreatStepOptions, currentRetreatUnitId, toggleAdvance, commitAdvance, skipAdvance } from '../src/engine/combat.js';
import { roll2d6 } from '../src/engine/rng.js';
import { MODE, evenSplitByPoints, isAiSide } from '../src/engine/setup.js';
import { runAiTurn, aiStep, shouldAiDrive, pendingOwnerSide } from '../src/ai/ai-player.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' :: ' + String(e.message || e)); fail++; }
}

const byId = (st, id) => st.units.find(u => u.id === id);
const isolate = (st, keep) => { for (const u of st.units) if (!keep.includes(u.id)) u.dead = true; };
const place = (st, id, col, row) => { const u = byId(st, id); u.col = col; u.row = row; u.supplied = true; return u; };
const throws = f => { try { f(); return false; } catch { return true; } };
const maxSteps = u => (u.face === 'full' && UNIT_STATS[u.type].hasReduced ? 2 : 1);

// 在 1..tries 的种子里找第一个掷出指定结果的局面（setup 可选，用于挂 AI 阵营）
function findSeed(run, result, tries = 400, setup = undefined) {
  for (let s = 1; s <= tries; s++) {
    const st = createGame(scenario, s, setup);
    const p = run(st, s);
    if (p.result === result) return st;
  }
  throw new Error('找不到结果为 ' + result + ' 的种子');
}

// 按 UI 同样的步骤走完待结算战斗
function resolve(st) {
  for (let i = 0; i < 60 && st.pending; i++) {
    const p = st.pending;
    if (p.step === 'assign') {
      const who = p.needAttackerSteps > 0 ? 'attacker' : 'defender';
      const ids = who === 'attacker' ? p.attackerIds : p.defenderIds;
      let left = who === 'attacker' ? p.needAttackerSteps : p.needDefenderSteps;
      for (const id of ids) {
        const u = byId(st, id);
        for (let n = 0; left > 0 && !u.dead && n < maxSteps(u); n++) { assignStep(st, who, id); left--; }
      }
      assert.equal(left, 0, '步损分配应可完成');
      commitAssign(st, who);
    } else if (p.step === 'retreat') {
      let uid = currentRetreatUnitId(st);
      if (!uid) { beginRetreat(st, p.retreatQueue[0]); uid = currentRetreatUnitId(st); }
      if (uid) {
        const o = retreatStepOptions(st)[0];
        assert.ok(o, '撤退单位应有可走格');
        retreatStep(st, o);
      }
    } else if (p.step === 'advance') skipAdvance(st);
    else throw new Error('bad step ' + p.step);
  }
  assert.ok(!st.pending, '战斗应结算完毕');
}

// 按 app.js 的驱动策略跑 AI 应手：只要 AI 拥有 pending 或轮到 AI 就继续（同步、无延迟）
function driveAi(st, max = 100) {
  let steps = 0;
  while (shouldAiDrive(st) && steps++ < max) {
    if (aiStep(st) !== 'continue') break;
  }
  return st;
}

// ---------- CRT ----------
test('CRT：取行、封底、封顶与平手取劣', () => {
  const rn = (a, d) => ROWS[rowForRatio(a, d)].name;
  assert.equal(rn(8, 6), '1.5:1');
  assert.equal(rn(5, 6), '1:1');
  assert.equal(rn(13, 10), '1.5:1');
  assert.equal(rn(10, 8), '1:1');
  assert.equal(rn(20, 4), '5:1+');
  assert.equal(rn(1, 10), '1:3');
});
test('CRT：不变量（每行11格、结果不同时要求双方损步）', () => {
  for (const row of ROWS) {
    assert.equal(row.vals.length, 11);
    for (const v of row.vals) assert.ok(!(RESULT_INFO[v].a > 0 && RESULT_INFO[v].d > 0), v);
  }
});

// ---------- 剧本数据 ----------
test('剧本：地形串、编制规模、部署堆叠合法', () => {
  assert.equal(scenario.terrain.length, 11);
  for (const row of scenario.terrain) {
    assert.equal(row.length, 15);
    for (const ch of row) assert.ok(TERRAIN[ch], '未知地形 ' + ch);
  }
  assert.equal(scenario.units.length, 24);
  const sides = {}, stacks = {};
  for (const u of scenario.units) {
    sides[u.side] = (sides[u.side] || 0) + 1;
    const k = u.side + '@' + u.col + ',' + u.row;
    stacks[k] = (stacks[k] || 0) + UNIT_STATS[u.type].stack;
    assert.ok(stacks[k] <= MAX_STACK, '部署超出堆叠：' + k);
  }
  assert.equal(sides.attacker, 12);
  assert.equal(sides.defender, 12);
});
test('剧本：小河是连续格边链且两端到位', () => {
  assert.ok(scenario.smallRiver.length >= 10);
  for (const [[c1, r1], [c2, r2]] of scenario.smallRiver) {
    assert.ok(Math.abs(c1 - c2) <= 1 && Math.abs(r1 - r2) <= 1 && !(c1 === c2 && r1 === r2), '非法格边');
  }
  assert.equal(scenario.bridges.length, 2);
});

// ---------- 确定性 ----------
test('确定性：同种子同骰序', () => {
  const a = createGame(scenario, 123), b = createGame(scenario, 123);
  for (let i = 0; i < 10; i++) assert.equal(roll2d6(a), roll2d6(b));
});

// ---------- 移动 / 补给 / ZOC ----------
test('移动：道路、桥、小河费用与敌占格不可达', () => {
  const st = createGame(scenario, 1);
  const armor = byId(st, 'attacker-armor-1'); // (3,7)
  assert.equal(stepCost(st, armor, { col: 3, row: 7 }, { col: 3, row: 6 }), 1, '道路');
  assert.equal(stepCost(st, armor, { col: 3, row: 6 }, { col: 3, row: 5 }), 2, '过桥');
  assert.equal(stepCost(st, armor, { col: 11, row: 3 }, { col: 12, row: 3 }), 15, '跨小河=半MP9+森林6');
  const reach = computeReachable(st, armor);
  assert.ok(!reach.has(hexKey({ col: 3, row: 5 })), '敌占格不可达');
  assert.ok(reach.get(hexKey({ col: 3, row: 6 })), '桥南端可达');
});
test('补给与ZOC：前线有补给；同岸两守军成强ZOC且不跨大河', () => {
  const st = createGame(scenario, 1);
  const ds = computeSupplySet(st, 'defender');
  assert.ok(ds.has('3,5') && ds.has('10,5'), '两处桥头出口有补给');
  assert.ok(computeSupplySet(st, 'attacker').has('3,7'));
  const sz = strongZoc(st, 'defender');
  assert.ok(sz.has('10,4'), '同岸两守军成强ZOC');
  assert.ok(!sz.has('10,6'), 'ZOC不跨大河（桥除外）');
});
test('堆叠：2点可进、3点封顶、满格可达但不可停留', () => {
  const st = createGame(scenario, 1, { mode: MODE.PVP, p1Side: 'attacker' });
  const keep = ['attacker-infantry-1', 'attacker-infantry-2', 'attacker-infantry-3', 'attacker-infantry-4'];
  isolate(st, keep);
  // 步兵4 初始就在 (6,9)；步兵5（编号2）移入同一格：2 点可停
  assert.equal(byId(st, 'attacker-infantry-4').col, 6);
  assert.equal(byId(st, 'attacker-infantry-4').row, 9);
  place(st, 'attacker-infantry-2', 7, 10);
  moveUnit(st, 'attacker-infantry-2', { col: 6, row: 9 });
  assert.equal(unitsAt(st, 6, 9).length, 2, '2 点堆叠应成功');
  // 第三支步兵进入同一格：3 点仍合法
  place(st, 'attacker-infantry-3', 7, 9);
  moveUnit(st, 'attacker-infantry-3', { col: 6, row: 9 });
  assert.equal(unitsAt(st, 6, 9).length, 3, '3 点堆叠应成功');
  assert.equal(canStopIn(st, 6, 9, 'infantry'), false, '满格不可再停');
  // 第四支：该格可达（可穿过），但不可停留
  place(st, 'attacker-infantry-1', 4, 9);
  const nfo = computeReachable(st, byId(st, 'attacker-infantry-1')).get('6,9');
  assert.ok(nfo, '满格友军格应可达');
  assert.equal(nfo.stoppable, false, '满格友军格可穿过不可停留');
  assert.ok(throws(() => moveUnit(st, 'attacker-infantry-1', { col: 6, row: 9 })), '停车应被拒绝');
});

// ---------- 战斗与撤退 ----------
test('战斗：D2打孤炮按可承受步数结算，并可挺进占格', () => {
  const st = findSeed(st => {
    isolate(st, ['defender-artillery-1', 'attacker-armor-1', 'attacker-armor-2']);
    place(st, 'defender-artillery-1', 7, 4);
    place(st, 'attacker-armor-1', 8, 4);
    place(st, 'attacker-armor-2', 7, 3);
    st.phase = 'combat';
    return declareAttack(st, ['attacker-armor-1', 'attacker-armor-2'], { col: 7, row: 4 });
  }, 'D2');
  assert.equal(st.pending.needDefenderSteps, 1, '孤炮只能承受1步');
  assignStep(st, 'defender', 'defender-artillery-1');
  commitAssign(st, 'defender');
  assert.ok(byId(st, 'defender-artillery-1').dead);
  assert.equal(st.pending.step, 'advance');
  toggleAdvance(st, 'attacker-armor-1');
  commitAdvance(st);
  assert.equal(byId(st, 'attacker-armor-1').col, 7);
  assert.ok(!st.pending);
});
test('撤退：守方自选撤退顺序，逐格走', () => {
  const st = findSeed(st => {
    isolate(st, ['defender-infantry-1', 'defender-infantry-2', 'attacker-armor-1', 'attacker-armor-2']);
    place(st, 'defender-infantry-1', 7, 4);
    place(st, 'defender-infantry-2', 7, 4);
    place(st, 'attacker-armor-1', 8, 4);
    place(st, 'attacker-armor-2', 7, 3);
    st.phase = 'combat';
    return declareAttack(st, ['attacker-armor-1', 'attacker-armor-2'], { col: 7, row: 4 });
  }, 'DR');
  assert.equal(st.pending.retreatQueue.length, 2);
  beginRetreat(st, 'defender-infantry-2');
  assert.equal(currentRetreatUnitId(st), 'defender-infantry-2');
  retreatStep(st, retreatStepOptions(st)[0]);
  assert.equal(currentRetreatUnitId(st), 'defender-infantry-1');
  retreatStep(st, retreatStepOptions(st)[0]);
  assert.equal(st.pending.step, 'advance');
  skipAdvance(st);
  assert.ok(!st.pending);
});
test('撤退：终点超堆叠损1步并加退1格', () => {
  const st = findSeed(st => {
    isolate(st, ['defender-infantry-1', 'defender-infantry-2', 'defender-infantry-3', 'defender-infantry-4', 'attacker-armor-1', 'attacker-infantry-1']);
    place(st, 'defender-infantry-1', 7, 4);
    for (const id of ['defender-infantry-2', 'defender-infantry-3', 'defender-infantry-4']) place(st, id, 6, 4);
    place(st, 'attacker-armor-1', 8, 4);
    place(st, 'attacker-infantry-1', 7, 3);
    st.phase = 'combat';
    return declareAttack(st, ['attacker-armor-1', 'attacker-infantry-1'], { col: 7, row: 4 });
  }, 'DR');
  assert.equal(currentRetreatUnitId(st), 'defender-infantry-1');
  assert.equal(st.pending.retreatRemaining, 1);
  const u = byId(st, 'defender-infantry-1');
  retreatStep(st, { col: 6, row: 4 });   // 直接撤进满格友军格
  assert.equal(u.face, 'reduced', '终点超堆叠损1步');
  assert.equal(st.pending.retreatPushes, 1);
  assert.equal(st.pending.retreatRemaining, 1);
  retreatStep(st, retreatStepOptions(st)[0]);
  assert.ok(!u.dead && st.pending.step === 'advance', '加退1格后完成');
  skipAdvance(st);
  assert.ok(!st.pending);
});
test('撤退：完全被堵死时剩余格数改为损步、原地停留', () => {
  const st = findSeed(st => {
    const keep = ['defender-infantry-1', 'defender-infantry-2'];
    const atk = ['attacker-infantry-1', 'attacker-infantry-2', 'attacker-infantry-3', 'attacker-infantry-4', 'attacker-infantry-5', 'attacker-infantry-6'];
    isolate(st, keep.concat(atk));
    place(st, 'defender-infantry-1', 7, 4);
    place(st, 'defender-infantry-2', 7, 4);
    const spots = [[8, 4], [7, 3], [6, 3], [6, 4], [6, 5], [7, 5]];
    atk.forEach((id, i) => { place(st, id, spots[i][0], spots[i][1]).face = 'reduced'; });
    st.phase = 'combat';
    return declareAttack(st, atk, { col: 7, row: 4 });
  }, 'DR');
  beginRetreat(st, 'defender-infantry-1');
  const d1 = byId(st, 'defender-infantry-1'), d2 = byId(st, 'defender-infantry-2');
  assert.equal(d1.face, 'reduced', '第1格无路可走改损1步');
  assert.equal(d2.face, 'reduced', '第2个单位同样原地损步');
  assert.equal(d1.col, 7, '原地停留');
  assert.ok(!st.pending, '守军留在原地无挺进，战斗直接关闭');
});

// ---------- 回合与胜负 ----------
test('回合：打满12回合，攻方未达标则守方胜', () => {
  const st = createGame(scenario, 5);
  for (let t = 0; t < 48 && !st.over; t++) endPhase(st); // 每回合4次阶段切换
  assert.equal(st.over, 'defender');
  assert.ok(st.log.some(l => l.includes('终局')));
});

test('挺进：多单位同时挺进受堆叠上限约束', () => {
  const st = findSeed(st => {
    isolate(st, ['defender-artillery-1', 'attacker-armor-1', 'attacker-infantry-1']);
    place(st, 'defender-artillery-1', 7, 4);
    place(st, 'attacker-armor-1', 8, 4);
    place(st, 'attacker-infantry-1', 7, 3);
    st.phase = 'combat';
    return declareAttack(st, ['attacker-armor-1', 'attacker-infantry-1'], { col: 7, row: 4 });
  }, 'D2');
  assignStep(st, 'defender', 'defender-artillery-1'); // 孤炮只能承受1步（封顶）
  commitAssign(st, 'defender');
  assert.equal(st.pending.step, 'advance');
  toggleAdvance(st, 'attacker-armor-1');
  toggleAdvance(st, 'attacker-infantry-1');
  commitAdvance(st);
  assert.equal(byId(st, 'attacker-armor-1').col, 7);
  assert.equal(byId(st, 'attacker-infantry-1').col, 7);
  assert.ok(!st.pending);
});
test('挺进：超过堆叠上限的确认被拒绝', () => {
  const st = findSeed(st => {
    isolate(st, ['defender-infantry-1', 'attacker-armor-1', 'attacker-armor-2']);
    place(st, 'defender-infantry-1', 7, 4);
    place(st, 'attacker-armor-1', 8, 4);
    place(st, 'attacker-armor-2', 7, 3);
    st.phase = 'combat';
    return declareAttack(st, ['attacker-armor-1', 'attacker-armor-2'], { col: 7, row: 4 });
  }, 'D2');
  assert.equal(st.pending.step, 'assign');
  assignStep(st, 'defender', 'defender-infantry-1');
  assignStep(st, 'defender', 'defender-infantry-1'); // 满编吃满2步=摧毁
  commitAssign(st, 'defender');
  assert.equal(st.pending.step, 'advance');
  toggleAdvance(st, 'attacker-armor-1');
  toggleAdvance(st, 'attacker-armor-2');
  assert.ok(throws(() => commitAdvance(st)), '4点超过3点上限');
  assert.ok(st.pending && st.pending.step === 'advance', '拒绝后仍在挺进阶段，可改选');
  toggleAdvance(st, 'attacker-armor-2');
  commitAdvance(st);
  assert.equal(byId(st, 'attacker-armor-1').col, 7);
  assert.ok(!st.pending);
});
// ---------- 开局设置与指挥官 ----------
test('设置：coop-pve 指挥官分配与AI阵营', () => {
  const st = createGame(scenario, 1, { mode: MODE.COOP_PVE, p1Side: 'defender', split: {} });
  assert.ok(st.units.filter(u => u.side === 'defender').every(u => u.commander === 'P1'));
  assert.ok(st.units.filter(u => u.side === 'attacker').every(u => u.commander === 'AI'));
  assert.deepEqual(st.meta.aiSides, ['attacker']);
  assert.ok(isAiSide(st, 'attacker') && !isAiSide(st, 'defender'));
});
test('设置：pvp 指挥官', () => {
  const st = createGame(scenario, 1, { mode: MODE.PVP, p1Side: 'attacker' });
  assert.ok(st.units.filter(u => u.side === 'attacker').every(u => u.commander === 'P1'));
  assert.ok(st.units.filter(u => u.side === 'defender').every(u => u.commander === 'P2'));
  assert.deepEqual(st.meta.aiSides, []);
});
test('设置：均分预设对半且点数平衡', () => {
  const points = scenario.units.filter(u => u.side === 'defender')
    .map(u => (u.type === 'armor' ? 2 : (u.type === 'infantry' ? 1 : 0)));
  const split = evenSplitByPoints(points);
  const c = { P1: 0, P2: 0 }, pts = { P1: 0, P2: 0 };
  split.forEach((cmd, i) => { c[cmd]++; pts[cmd] += points[i]; });
  assert.equal(c.P1, 6, '人数对半');
  assert.equal(c.P2, 6, '人数对半');
  assert.equal(pts.P1, 6, '点数对半');
  assert.equal(pts.P2, 6, '点数对半');
});

// ---------- AI 应手（人类回合内） ----------
const PVE_HUMAN_ATTACK = { mode: MODE.SOLO_PVE, p1Side: 'attacker' }; // 人类攻方，AI 守方

// 人类攻方攻击 AI 守军（守军堆在 7,4），取指定 CRT 结果
function humanAttacksAiDefender(result, defenders = 1) {
  return findSeed(st => {
    const keep = ['attacker-infantry-1', 'attacker-infantry-2'];
    for (let i = 1; i <= defenders; i++) keep.push('defender-infantry-' + i);
    isolate(st, keep);
    for (let i = 1; i <= defenders; i++) place(st, 'defender-infantry-' + i, 7, 4);
    place(st, 'attacker-infantry-1', 8, 4);
    place(st, 'attacker-infantry-2', 7, 3);
    st.phase = 'combat';
    return declareAttack(st, ['attacker-infantry-1', 'attacker-infantry-2'], { col: 7, row: 4 });
  }, result, 500, PVE_HUMAN_ATTACK);
}

test('应手策略：人类回合内 AI 归属的待结算会驱动 AI，人类归属的不驱动', () => {
  const aiOwned = humanAttacksAiDefender('DR');
  assert.equal(aiOwned.activeSide, 'attacker', '应仍处于人类回合');
  assert.equal(pendingOwnerSide(aiOwned, aiOwned.pending), 'defender', '应手属于 AI 守方');
  assert.equal(shouldAiDrive(aiOwned), true, 'AI 守方应手应被驱动');
  const humanOwned = humanAttacksAiDefender('A1');
  assert.equal(humanOwned.pending.step, 'assign');
  assert.equal(pendingOwnerSide(humanOwned, humanOwned.pending), 'attacker');
  assert.equal(shouldAiDrive(humanOwned), false, '人类攻方的损失不由 AI 代打');
  const pvp = findSeed(st => {
    isolate(st, ['attacker-infantry-1', 'attacker-infantry-2', 'defender-infantry-1']);
    place(st, 'defender-infantry-1', 7, 4);
    place(st, 'attacker-infantry-1', 8, 4);
    place(st, 'attacker-infantry-2', 7, 3);
    st.phase = 'combat';
    return declareAttack(st, ['attacker-infantry-1', 'attacker-infantry-2'], { col: 7, row: 4 });
  }, 'DR', 500, { mode: MODE.PVP, p1Side: 'attacker' });
  assert.equal(shouldAiDrive(pvp), false, '热座 PvP 没有 AI');
});
test('应手：人类攻击 AI 守军，AI 自动分配步损并撤退，只剩人类挺进', () => {
  const st = humanAttacksAiDefender('DR', 2);
  driveAi(st);
  assert.ok(!st.pending || pendingOwnerSide(st, st.pending) === 'attacker', 'AI 守方不再欠应手');
  assert.ok(st.pending && st.pending.step === 'advance', '撤退后由人类攻方选择挺进');
  for (const id of ['defender-infantry-1', 'defender-infantry-2']) {
    const u = byId(st, id);
    assert.ok(u && !u.dead, id + ' 应存活');
    assert.ok(!(u.col === 7 && u.row === 4), id + ' 应已撤离原格');
  }
  assert.ok(st.log.some(l => l.includes('【撤退】')), '应产生撤退记录');
});
test('应手：人类攻击产生攻方损失时 AI 不代打', () => {
  const st = humanAttacksAiDefender('A1');
  assert.equal(st.pending.step, 'assign');
  assert.equal(st.pending.needAttackerSteps, 1);
  assert.equal(pendingOwnerSide(st, st.pending), 'attacker');
  assert.equal(shouldAiDrive(st), false);
  const sig = s => JSON.stringify(s.units.map(u => [u.id, u.col, u.row, u.face, u.dead]));
  const before = sig(st);
  driveAi(st);
  assert.equal(sig(st), before, 'AI 不应改动人类归属的应手');
  assert.ok(st.pending && st.pending.step === 'assign');
});

// ---------- AI 冒烟 ----------
function playGameWithAi(aiSide, seed) {
  const st = createGame(scenario, seed, {
    mode: MODE.SOLO_PVE, p1Side: aiSide === 'attacker' ? 'defender' : 'attacker',
  });
  let guard = 0;
  while (!st.over && guard++ < 100) {
    if (st.pending) resolve(st);                                  // 谁的应手都由测试方代答
    else if (isAiSide(st, st.activeSide)) runAiTurn(st);
    else endPhase(st);
  }
  return { st, guard };
}
test('AI冒烟：AI执攻方完整对局', () => {
  const { st } = playGameWithAi('attacker', 42);
  assert.ok(st.over, '对局应在12回合内结束');
  assert.ok(st.log.length > 40, 'AI应产生大量动作记录: ' + st.log.length);
});
test('AI冒烟：AI执守方完整对局', () => {
  const { st } = playGameWithAi('defender', 42);
  assert.ok(st.over, '对局应在12回合内结束');
});
test('AI确定性：同种子同终局同布局', () => {
  const sig = s => JSON.stringify(s.units.map(u => [u.id, u.col, u.row, u.face, u.dead])) + '|' + s.over;
  const a = playGameWithAi('attacker', 7).st;
  const b = playGameWithAi('attacker', 7).st;
  assert.equal(sig(a), sig(b));
});

console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : fail + ' FAILED, ' + pass + ' passed');
process.exit(fail === 0 ? 0 : 1);
