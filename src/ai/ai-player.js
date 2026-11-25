// AI 指挥官：打分式决策，步进式执行（aiStep 一次推一步）。
// 关键设计：待结算状态机（步损分配/撤退）按"归属"决定由 AI 还是人类应手——
// AI 攻击人类守军时，守方的撤退与分配交还给人，AI 回合暂停等待。
// 全部动作经由与玩家相同的引擎 API 执行，保持确定性（同种子同结果）。
import { computeReachable } from '../engine/move.js';
import { moveUnit, endPhase } from '../engine/engine.js';
import { declareAttack, previewAttack, assignStep, commitAssign, beginRetreat,
         retreatStep, retreatStepOptions, toggleAdvance, commitAdvance,
         eligibleAttackers, maxStepsFor } from '../engine/combat.js';
import { bombard, bombardTargets } from '../engine/artillery.js';
import { UNIT_STATS, hexKey, parseKey, unitsAt, aliveUnits, findUnit } from '../engine/state.js';
import { hexDistance } from '../engine/hex.js';
import { strongZoc } from '../engine/zoc.js';
import { AI_COMMANDER, isAiSide } from '../engine/setup.js';
import { rowExpectations, distanceField, hexStaticValue, terrainShiftAt, SELF_LOSS_WEIGHT } from './evaluate.js';

// 打分权重（v1 一档"标准"难度；调难度就是调这张表）
const W = {
  obj: 0.6,            // 逼近目标点
  terrain: 0.35,       // 好地形（守方加倍）
  attack: 0.5,         // 攻击潜力（守方大减）
  stayBiasDef: 0.4,    // 守军驻守偏好
  strongZoc: 0.8,      // 误入敌强ZOC的惩罚
  artilleryRange: 0.4, // 炮兵保持射程内的加分
  artilleryAdjacent: -1.2,
  attackThreshold: 0.2, // 攻击净收益门槛
};

function ownUnits(state, side) { return aliveUnits(state).filter(u => u.side === side); }
function alive(state, id) { const u = findUnit(state, id); return u && !u.dead ? u : null; }
function enemyHexes(state, side) {
  return aliveUnits(state).filter(u => u.side !== side).map(u => ({ col: u.col, row: u.row }));
}
function nearestEnemyDist(state, h, side) {
  const es = enemyHexes(state, side);
  return es.length ? Math.min(...es.map(e => hexDistance(h, e))) : 99;
}
function adjacentEnemyStacks(state, h, side) {
  return enemyHexes(state, side).filter(e => hexDistance(h, e) === 1).length;
}
function inEnemyStrongZoc(state, h, side) {
  return strongZoc(state, side === 'attacker' ? 'defender' : 'attacker').has(hexKey(h));
}
function aiSideOf(state) {
  return (state.meta && state.meta.aiSides && state.meta.aiSides[0]) || null;
}
// 待结算状态属于哪一方（谁该应手）
export function pendingOwnerSide(state, p) {
  if (p.step === 'assign') {
    return p.needAttackerSteps > 0
      ? (sideOfUnits(state, p.attackerIds) || state.activeSide)
      : (sideOfUnits(state, p.defenderIds) || state.activeSide);
  }
  if (p.step === 'retreat') return sideOfUnits(state, p.defenderIds) || state.activeSide;
  if (p.step === 'advance') return sideOfUnits(state, p.attackerIds) || state.activeSide;
  return state.activeSide;
}
function sideOfUnits(state, ids) {
  for (const id of ids) { const u = findUnit(state, id); if (u && !u.dead) return u.side; }
  return null;
}

// ---------- 炮击 ----------
export function aiBombard(state) {
  const side = state.activeSide;
  for (const a of ownUnits(state, side)) {
    if (a.type !== 'artillery') continue;
    let best = null;
    for (const T of bombardTargets(state, a)) {
      const occ = unitsAt(state, T.col, T.row).filter(u => u.side !== side);
      const v = hexStaticValue(state, T, state.objectives) + 1.2 * occ.length;
      if (!best || v > best.v) best = { T, v };
    }
    if (best) bombard(state, a.id, best.T);
  }
}

// ---------- 移动 ----------
export function aiMovePhase(state) {
  const side = state.activeSide;
  const isDef = side === 'defender';
  const isAtt = !isDef;
  const objs = state.objectives.filter(o => {
    const occ = unitsAt(state, o.col, o.row);
    return isAtt ? !occ.some(x => x.side === side) : occ.some(x => x.side === side);
  });
  const field = distanceField(state, objs.length ? objs : state.objectives);
  const distAt = h => field.get(hexKey(h)) ?? 99;

  for (const u of ownUnits(state, side)) {
    if (u.moved) continue;
    const here = { col: u.col, row: u.row };
    const scoreHex = h => {
      let s = 0;
      s += (distAt(here) - distAt(h)) * W.obj;                        // 逼近目标
      s += (-terrainShiftAt(state, h)) * W.terrain * (isDef ? 2 : 1);  // 好地形
      const adj = adjacentEnemyStacks(state, h, side);
      s += adj * W.attack * (isDef ? 0.3 : 1);                         // 攻击潜力
      if (u.type === 'artillery') {
        s -= adj * W.attack;                                          // 炮兵不凑近
        const d = nearestEnemyDist(state, h, side);
        s += (d >= 2 && d <= 5) ? W.artilleryRange : (d < 2 ? W.artilleryAdjacent : 0);
      }
      if (inEnemyStrongZoc(state, h, side)) {
        s -= W.strongZoc * (u.type === 'artillery' ? 2 : (isDef ? 1 : 0.5));
      }
      return s;
    };
    let best = { k: hexKey(u), s: scoreHex(here) + (isDef ? W.stayBiasDef : 0) };
    const reach = computeReachable(state, u);
    for (const [k, info] of reach) {
      if (!info.stoppable || info.cost === 0) continue;
      const s = scoreHex(parseKey(k));
      if (s > best.s + 1e-9) best = { k, s };
    }
    if (best.k !== hexKey(u)) {
      try { moveUnit(state, u.id, parseKey(best.k)); } catch { /* 打分失误则原地 */ }
    }
  }
}

// ---------- 攻击决策 ----------
export function pickAttack(state) {
  let best = null;
  for (const T of enemyHexes(state, state.activeSide)) {
    const ids = eligibleAttackers(state, T).map(u => u.id);
    if (ids.length === 0) continue;
    const pv = previewAttack(state, ids, T);
    if (pv.finalRow === null) continue;
    const exp = rowExpectations(pv.finalRow);
    const hexV = hexStaticValue(state, T, state.objectives);
    const score = exp.ed * 1.0 + exp.vacate * hexV * 0.6 - exp.ea * SELF_LOSS_WEIGHT;
    if (!best || score > best.score) best = { ids, T, score };
  }
  return best && best.score > W.attackThreshold ? best : null;
}

// ---------- 待结算状态机应手（只应手自己的一方，别人的交还） ----------
function resolvePending(state, selfSide) {
  for (let guard = 0; guard < 60 && state.pending; guard++) {
    const p = state.pending;
    if (pendingOwnerSide(state, p) !== selfSide) return 'yield';
    if (p.step === 'assign') aiAssign(state, p);
    else if (p.step === 'retreat') aiRetreatStep(state, p);
    else if (p.step === 'advance') aiAdvance(state, p);
    else throw new Error('AI：未知结算步骤 ' + p.step);
  }
  return 'done';
}

function aiAssign(state, p) {
  const who = p.needAttackerSteps > 0 ? 'attacker' : 'defender';
  const ids = who === 'attacker' ? p.attackerIds : p.defenderIds;
  let left = who === 'attacker' ? p.needAttackerSteps : p.needDefenderSteps;
  const cands = ids.map(id => alive(state, id)).filter(Boolean)
    .sort((a, b) => (a.face === 'full' ? 0 : 1) - (b.face === 'full' ? 0 : 1)
      || UNIT_STATS[a.type].stack - UNIT_STATS[b.type].stack);
  for (let pass = 0; pass < 10 && left > 0; pass++) {
    let progressed = false;
    for (const u of cands) {
      if (left === 0) break;
      if (u.dead) continue;
      const cur = p.assign[who][u.id] || 0;
      if (cur >= maxStepsFor(u)) continue;
      assignStep(state, who, u.id);
      left--;
      progressed = true;
      if (left === 0) break;
    }
    if (!progressed) break;
  }
  commitAssign(state, who);
}

function aiRetreatStep(state, p) {
  if (!p.retreatActive) beginRetreat(state, p.retreatQueue[0]);
  const u = alive(state, p.retreatActive);
  if (!u) return;
  const opts = retreatStepOptions(state);
  if (opts.length === 0) return; // 无路可走 → 引擎已自动改损步
  let best = null;
  for (const h of opts) {
    const s = nearestEnemyDist(state, h, u.side) * 1.0 + (-terrainShiftAt(state, h)) * 0.3;
    if (!best || s > best.s + 1e-9) best = { h, s };
  }
  retreatStep(state, best.h);
}

function aiAdvance(state, p) {
  const cands = p.advanceCandidates.map(id => alive(state, id)).filter(Boolean)
    .sort((a, b) => UNIT_STATS[a.type].stack - UNIT_STATS[b.type].stack);
  let pts = 0;
  for (const u of cands) {
    if (pts + UNIT_STATS[u.type].stack <= 3) {
      toggleAdvance(state, u.id);
      pts += UNIT_STATS[u.type].stack;
    }
  }
  commitAdvance(state);
}

// ---------- 步进驱动 ----------
// 是否该由 AI 推进：有待结算且应手方是 AI，或行动方是 AI。
// 与 aiStep 内部的两段守卫保持一致；UI 用它在人类回合内也驱动 AI 应手。
export function shouldAiDrive(state) {
  if (!state || state.over) return false;
  const ai = aiSideOf(state);
  if (!ai) return false;
  if (state.pending) return pendingOwnerSide(state, state.pending) === ai;
  return isAiSide(state, state.activeSide);
}

// 推进一步 AI 决策。返回：
//   'done'     —— AI 回合结束（行动权已移交）
//   'yield'    —— 等待人类应手或非 AI 回合，调用方暂停
//   'continue' —— 还有动作，稍后请再调一次
export function aiStep(state) {
  if (state.over) return 'done';
  if (state.pending) {
    const owner = pendingOwnerSide(state, state.pending);
    if (owner !== aiSideOf(state)) return 'yield';
    resolvePending(state, aiSideOf(state));
    return state.pending ? 'yield' : 'continue';
  }
  const side = state.activeSide;
  if (!isAiSide(state, side)) return 'yield';
  if (state.phase === 'move') {
    aiMovePhase(state);
    endPhase(state);
    return 'continue';
  }
  if (state.phase === 'combat') {
    aiBombard(state);
    const best = pickAttack(state);
    if (best) {
      declareAttack(state, best.ids, best.T);
      return 'continue';
    }
    endPhase(state);
    return 'done';
  }
  return 'done';
}

// 同步跑完整个 AI 回合（自测用）。返回 'done' | 'yield'
export function runAiTurn(state) {
  for (let i = 0; i < 100; i++) {
    const r = aiStep(state);
    if (r !== 'continue') return r;
  }
  return 'yield';
}

// 异步带延迟跑完（UI 用），人类应手处暂停
export async function runAiTurnAsync(state, hooks = {}) {
  for (let i = 0; i < 100; i++) {
    const r = aiStep(state);
    if (hooks.onAction) { hooks.onAction(r); if (hooks.delay) await hooks.delay(); }
    if (r !== 'continue') return r;
  }
  return 'yield';
}
