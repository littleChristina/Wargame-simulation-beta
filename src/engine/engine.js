// 回合引擎：建局 → 阶段1（压制到期+补给判定）→ 移动阶段 → 战斗阶段 → 移交行动权。
import { hexKey, findUnit, unitLabel, sideName } from './state.js';
import { doMove } from './move.js';
import { markSupply } from './supply.js';
import { checkAnnihilation, evaluateScenarioEnd } from './victory.js';

function pairKey(a, b) {
  const [x, y] = (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) ? [a, b] : [b, a];
  return `${x[0]},${x[1]}|${y[0]},${y[1]}`;
}

export function createGame(scenario, seed) {
  const state = {
    width: scenario.width,
    height: scenario.height,
    turns: scenario.turns,
    objectives: scenario.objectives,
    objectivesNeeded: scenario.objectivesNeeded,
    supplySource: scenario.supplySource,
    terrain: scenario.terrain,
    bigRiver: new Set(scenario.bigRiver.map(e => pairKey(e[0], e[1]))),
    smallRiver: new Set(scenario.smallRiver.map(e => pairKey(e[0], e[1]))),
    bridges: new Set(scenario.bridges.map(e => pairKey(e[0], e[1]))),
    units: [],
    turn: 1,
    activeSide: 'attacker',
    phase: 'start',
    pending: null,
    over: null,
    rngState: seed >>> 0,
    log: [],
    phaseBombards: [],
    seedText: String(seed),
  };
  const counters = {};
  state.units = scenario.units.map(u => {
    const k = `${u.side}-${u.type}`;
    counters[k] = (counters[k] || 0) + 1;
    return {
      id: `${k}-${counters[k]}`,
      no: counters[k],
      side: u.side,
      type: u.type,
      col: u.col,
      row: u.row,
      face: 'full',
      moved: false,
      attacked: false,
      dead: false,
      suppressLevel: 0,
      suppressFirer: null,
      supplied: true,
    };
  });
  state.log.push(`战役开始（种子 ${seed}）：${scenario.name}`);
  runPhaseStart(state);
  return state;
}

// 阶段1：移除本方施放且到期的压制 → 重置本方行动标记 → 补给判定
export function runPhaseStart(state) {
  const side = state.activeSide;
  for (const u of state.units) {
    if (u.suppressFirer === side) { u.suppressLevel = 0; u.suppressFirer = null; }
    if (!u.dead && u.side === side) { u.moved = false; u.attacked = false; }
  }
  state.phaseBombards = [];
  markSupply(state, side);
  state.phase = 'move';
  const unsupplied = state.units.filter(u => !u.dead && u.side === side && u.supplied === false);
  state.log.push(`── 回合${state.turn} ${sideName(side)}回合开始 ──`);
  if (unsupplied.length > 0) {
    state.log.push(`  【断补】${unsupplied.map(unitLabel).join('、')} 未补给`);
  }
}

export function endPhase(state) {
  if (state.over) throw new Error('战役已结束');
  if (state.pending) throw new Error('有未完成的战斗结算');
  if (state.phase === 'move') {
    state.phase = 'combat';
    state.log.push('── 进入战斗阶段 ──');
    return;
  }
  if (state.phase !== 'combat') throw new Error('阶段状态错误');
  checkAnnihilation(state);
  if (state.over) return;
  if (state.activeSide === 'defender') {
    if (state.turn >= state.turns) { evaluateScenarioEnd(state); return; }
    state.turn += 1;
    state.activeSide = 'attacker';
  } else {
    state.activeSide = 'defender';
  }
  runPhaseStart(state);
}

export function moveUnit(state, unitId, dest) {
  if (state.over) throw new Error('战役已结束');
  if (state.phase !== 'move' || state.pending) throw new Error('现在不是移动阶段');
  const u = findUnit(state, unitId);
  if (!u || u.dead) throw new Error('单位不存在');
  if (u.side !== state.activeSide) throw new Error('不是当前行动方单位');
  if (u.moved) throw new Error('该单位本回合已移动');
  const path = doMove(state, u, dest);
  state.log.push(`【移动】${unitLabel(u)} → (${dest.col},${dest.row})`);
  return path;
}
