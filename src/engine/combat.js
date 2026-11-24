// 近战结算状态机：
// 宣战（比值→行修正含迂回豁免→2d6→CRT结果）→ 步损分配（攻/守）→ 逐单位撤退 → 放血 → 可选挺进 → 关闭
// 约定：CRT 结果不会同时要求攻守双方损步（表内无此结果）。
import { UNIT_STATS, MAX_STACK, MAX_ARTY, hexKey, findUnit, unitsAt, unitAttack, unitDefense, unitLabel,
         applySteps, isBigRiver, isSmallRiver } from './state.js';
import { hexDistance } from './hex.js';
import { ROWS, rowForRatio, clampRow, RESULT_INFO, rowOdds } from './crt.js';
import { TERRAIN } from './terrain.js';
import { roll2d6 } from './rng.js';
import { retreatStepOptions as nextHexOptions } from './retreat.js';
import { checkAnnihilation } from './victory.js';

// 该格所有可参战的己方地面单位（未攻击过、相邻）
export function eligibleAttackers(state, target) {
  return state.units.filter(u => !u.dead && u.side === state.activeSide
    && u.type !== 'artillery' && !u.attacked && hexDistance(u, target) === 1);
}

export function previewAttack(state, attackerIds, target) {
  const idset = new Set(attackerIds);
  const atks = eligibleAttackers(state, target).filter(u => idset.has(u.id));
  const atkTotal = atks.reduce((s, u) => s + unitAttack(u), 0);
  const defenders = unitsAt(state, target.col, target.row).filter(u => u.side !== state.activeSide);
  const defTotal = defenders.reduce((s, u) => s + unitDefense(u), 0);
  const terrainShift = TERRAIN[state.terrain[target.row][target.col]].shift;

  // 迂回豁免：同岸攻击力合计严格大于总量一半 → 无视河流行修正
  const crossing = atks.filter(u => isBigRiver(state, u, target) || isSmallRiver(state, u, target));
  const sameBankAtk = atks.filter(u => !crossing.includes(u)).reduce((s, u) => s + unitAttack(u), 0);
  let riverShift = 0, exempt = false;
  if (crossing.length > 0) {
    if (sameBankAtk * 2 > atkTotal) exempt = true;
    else riverShift = crossing.some(u => isBigRiver(state, u, target)) ? -2 : -1;
  }
  // 未选参战单位或目标格无守军时不取行（baseRow/finalRow 为 null），由调用方决定如何提示
  if (atks.length === 0 || defenders.length === 0) {
    return { atks, atkTotal, defenders, defTotal, baseRow: null, terrainShift, riverShift, exempt,
             finalRow: null, ratioText: null, odds: '' };
  }
  const baseRow = rowForRatio(atkTotal, defTotal);
  const finalRow = clampRow(baseRow + terrainShift + riverShift);
  return { atks, atkTotal, defenders, defTotal, baseRow, terrainShift, riverShift, exempt,
           finalRow, ratioText: `${atkTotal}:${defTotal}`, odds: rowOdds(finalRow) };
}

export function declareAttack(state, attackerIds, target) {
  if (state.over) throw new Error('战役已结束');
  if (state.phase !== 'combat' || state.pending) throw new Error('现在不能宣战');
  const pv = previewAttack(state, attackerIds, target);
  if (pv.atks.length === 0) throw new Error('没有选择参战单位');
  if (pv.defenders.length === 0) throw new Error('目标格没有守军');
  const roll = roll2d6(state);
  const result = ROWS[pv.finalRow].vals[roll - 2];
  const info = RESULT_INFO[result];
  for (const u of pv.atks) u.attacked = true;
  const p = {
    kind: 'combat',
    target: { col: target.col, row: target.row },
    result, roll, finalRow: pv.finalRow, rowName: ROWS[pv.finalRow].name,
    attackerIds: pv.atks.map(u => u.id),
    defenderIds: pv.defenders.map(u => u.id),
    needAttackerSteps: info.a, needDefenderSteps: info.d, retreatHexes: info.r,
    assign: { attacker: {}, defender: {} },
    retreatQueue: null, step: 'assign', advanceCandidates: null,
  };
  state.pending = p;
  const shiftTxt = [];
  if (pv.terrainShift) shiftTxt.push(`地形${pv.terrainShift}`);
  if (pv.riverShift) shiftTxt.push(`跨河${pv.riverShift}${pv.exempt ? '（迂回豁免生效）' : ''}`);
  state.log.push(`【战斗】${pv.atks.map(unitLabel).join('、')} → (${target.col},${target.row})`);
  state.log.push(`  比值 ${pv.ratioText}${shiftTxt.length ? '，' + shiftTxt.join('，') : ''} → 行 ${p.rowName}；掷骰 ${roll} → ${result}（${info.desc}）`);
  advanceFlow(state);
  return p;
}

// ---- 步损分配 ----
export function maxStepsFor(u) {
  const st = UNIT_STATS[u.type];
  return (u.face === 'full' && st.hasReduced) ? 2 : 1;
}

export function assignedSum(p, who) {
  return Object.values(p.assign[who]).reduce((a, b) => a + b, 0);
}

export function assignStep(state, who, unitId) {
  const p = state.pending;
  if (!p || p.step !== 'assign') throw new Error('当前不在步损分配阶段');
  const u = findUnit(state, unitId);
  if (!u || u.dead) throw new Error('单位不存在');
  const list = who === 'attacker' ? p.attackerIds : p.defenderIds;
  if (!list.includes(unitId)) throw new Error('不属于该方参战单位');
  const cur = p.assign[who][unitId] || 0;
  if (cur >= maxStepsFor(u)) throw new Error('该单位无法再承受步损');
  p.assign[who][unitId] = cur + 1;
}

export function unassignStep(state, who, unitId) {
  const p = state.pending;
  if (!p) throw new Error('无待结算战斗');
  const cur = p.assign[who][unitId] || 0;
  if (cur > 0) p.assign[who][unitId] = cur - 1;
}

export function clearAssignments(state, who) {
  const p = state.pending;
  if (p) p.assign[who] = {};
}

export function commitAssign(state, who) {
  const p = state.pending;
  if (!p || p.step !== 'assign') throw new Error('当前不在步损分配阶段');
  const need = who === 'attacker' ? p.needAttackerSteps : p.needDefenderSteps;
  if (assignedSum(p, who) !== need) throw new Error('分配总数不等于应承担步损');
  for (const [id, c] of Object.entries(p.assign[who])) {
    applySteps(state, findUnit(state, id), c);
  }
  p.assign[who] = {};
  if (who === 'attacker') p.needAttackerSteps = 0; else p.needDefenderSteps = 0;
  advanceFlow(state);
}

// ---- 撤退：逐单位、逐格 ----
// 守方玩家逐个挑选撤退的单位；退多格时逐格规划路线。
// 每进一格都做 ZOC 判定（见 retreat.js）；堆叠只在终点判定：终点超堆叠 → 损1步并再撤一格。
// 某一格无路可走 → 从该格起剩余格数各损1步，原地停留。

// 正在撤退的单位（尚需玩家挑选时为 null）
export function currentRetreatUnitId(state) {
  const p = state.pending;
  return (p && p.step === 'retreat') ? p.retreatActive : null;
}

// 守方玩家选定下一个撤退的单位
export function beginRetreat(state, unitId) {
  const p = state.pending;
  if (!p || p.step !== 'retreat') throw new Error('当前不在撤退阶段');
  if (p.retreatActive) throw new Error('已有单位正在撤退');
  const idx = p.retreatQueue.indexOf(unitId);
  if (idx < 0) throw new Error('该单位不在撤退队列');
  const u = findUnit(state, unitId);
  p.retreatQueue.splice(idx, 1);
  p.retreatActive = unitId;
  p.retreatPath = [{ col: u.col, row: u.row }];
  p.retreatRemaining = p.retreatHexes;
  p.retreatPushes = 0;
  state.log.push(`  【撤退】${unitLabel(u)} 需退${p.retreatHexes}格`);
  advanceRetreat(state);
}

// 正在撤退的单位走下一格的合法选项
export function retreatStepOptions(state) {
  const p = state.pending;
  if (!p || p.step !== 'retreat' || !p.retreatActive) return [];
  return nextHexOptions(state, findUnit(state, p.retreatActive), p.retreatPath);
}

// 正在撤退的单位走入下一格（dest 须为 retreatStepOptions 之一）
export function retreatStep(state, dest) {
  const p = state.pending;
  if (!p || p.step !== 'retreat' || !p.retreatActive) throw new Error('当前没有正在撤退的单位');
  if (!retreatStepOptions(state).some(h => h.col === dest.col && h.row === dest.row)) {
    throw new Error('该格不能作为撤退路线');
  }
  const u = findUnit(state, p.retreatActive);
  u.col = dest.col;
  u.row = dest.row;
  p.retreatPath.push({ col: dest.col, row: dest.row });
  p.retreatRemaining -= 1;
  if (p.retreatRemaining === 0 && overStackedAt(state, u)) {
    // 终点超出堆叠：损1步，并再撤一格
    p.retreatPushes += 1;
    state.log.push(`  ${unitLabel(u)} 撤入 (${dest.col},${dest.row}) 超出堆叠上限 → 损1步并再撤1格`);
    applySteps(state, u, 1);
    p.retreatRemaining = 1;
  }
  if (p.retreatRemaining === 0) finishRetreatUnit(state, u);
  else advanceRetreat(state);
}

// 终点堆叠判定：该格其余单位 + 本单位是否超限（炮兵另有每格门数上限）
function overStackedAt(state, u) {
  const others = unitsAt(state, u.col, u.row).filter(x => x !== u);
  const points = others.reduce((s, x) => s + UNIT_STATS[x.type].stack, 0) + UNIT_STATS[u.type].stack;
  if (points > MAX_STACK) return true;
  return u.type === 'artillery' && others.filter(x => x.type === 'artillery').length >= MAX_ARTY;
}

// 推进当前单位的撤退：无路可走时把剩余格数直接转为损步，否则等待玩家选格
function advanceRetreat(state) {
  const p = state.pending;
  const u = findUnit(state, p.retreatActive);
  if (u.dead) { finishRetreatUnit(state, u); return; }
  if (retreatStepOptions(state).length > 0) return;
  state.log.push(`  ${unitLabel(u)} 无路可退，剩余${p.retreatRemaining}格各损1步`);
  applySteps(state, u, p.retreatRemaining);
  finishRetreatUnit(state, u);
}

function finishRetreatUnit(state, u) {
  const p = state.pending;
  if (!u.dead) state.log.push(`  ${unitLabel(u)} 撤退结束，位于 (${u.col},${u.row})`);
  p.retreatActive = null;
  p.retreatPath = null;
  p.retreatRemaining = 0;
  advanceFlow(state);
}

// ---- 挺进：可多选，确认后一并进占 ----
export function toggleAdvance(state, unitId) {
  const p = state.pending;
  if (!p || p.step !== 'advance') throw new Error('当前不在挺进阶段');
  if (!p.advanceCandidates.includes(unitId)) throw new Error('该单位不可挺进');
  const i = p.advancePick.indexOf(unitId);
  if (i >= 0) p.advancePick.splice(i, 1);
  else p.advancePick.push(unitId);
}

export function commitAdvance(state) {
  const p = state.pending;
  if (!p || p.step !== 'advance') throw new Error('当前不在挺进阶段');
  if (unitsAt(state, p.target.col, p.target.row).length > 0) throw new Error('目标格仍有单位');
  const picked = p.advancePick.map(id => findUnit(state, id)).filter(u => u && !u.dead);
  const points = picked.reduce((s, x) => s + UNIT_STATS[x.type].stack, 0);
  if (points > MAX_STACK) throw new Error(`挺进单位合计${points}点，超过每格上限${MAX_STACK}点`);
  for (const u of picked) { u.col = p.target.col; u.row = p.target.row; }
  if (picked.length > 0) {
    state.log.push(`  【挺进】${picked.map(unitLabel).join('、')} 进入 (${p.target.col},${p.target.row})`);
  }
  closeCombat(state);
}

export function skipAdvance(state) {
  const p = state.pending;
  if (!p || p.step !== 'advance') throw new Error('当前不在挺进阶段');
  closeCombat(state);
}

// ---- 内部级联 ----
// 应损步数超过该方参战单位可承受的总步数时，按可承受数结算
// （一步单位吃 D2/A2 即摧毁，多出的步数无效；否则分配永远凑不够总数）
function capRequiredSteps(state, p, who) {
  const key = who === 'attacker' ? 'needAttackerSteps' : 'needDefenderSteps';
  if (p[key] <= 0) return;
  const ids = who === 'attacker' ? p.attackerIds : p.defenderIds;
  const cap = ids.map(id => findUnit(state, id))
    .filter(u => u && !u.dead)
    .reduce((s, u) => s + maxStepsFor(u), 0);
  if (p[key] > cap) {
    state.log.push(`  ${who === 'attacker' ? '攻方' : '守方'}应损${p[key]}步，仅能承受${cap}步 → 按${cap}步结算`);
    p[key] = cap;
  }
}

function advanceFlow(state) {
  const p = state.pending;
  if (!p) return;
  capRequiredSteps(state, p, 'attacker');
  capRequiredSteps(state, p, 'defender');
  if (p.needAttackerSteps > 0 || p.needDefenderSteps > 0) { p.step = 'assign'; return; }
  if (p.retreatHexes > 0) {
    if (!p.retreatQueue) {
      // 待撤单位 id 队列：存活且尚未撤退的守军
      p.retreatQueue = p.defenderIds.filter(id => { const u = findUnit(state, id); return u && !u.dead; });
      p.retreatActive = null;
    }
    if (p.retreatActive || p.retreatQueue.length > 0) {
      p.step = 'retreat';
      // 只剩一个单位时无从挑选，直接开始
      if (!p.retreatActive && p.retreatQueue.length === 1) beginRetreat(state, p.retreatQueue[0]);
      return;
    }
  }
  doBleed(state, p);
  const empty = unitsAt(state, p.target.col, p.target.row).length === 0;
  const candidates = p.attackerIds.map(id => findUnit(state, id)).filter(u => u && !u.dead);
  if (p.result !== 'C' && empty && candidates.length > 0) {
    p.step = 'advance';
    p.advanceCandidates = candidates.map(u => u.id);
    p.advancePick = [];
    state.log.push('  守方阵地已腾空，攻方可选择挺进');
    return;
  }
  closeCombat(state);
}

function doBleed(state, p) {
  const ids = [...p.attackerIds, ...p.defenderIds];
  const bleed = ids.map(id => findUnit(state, id)).filter(u => u && !u.dead && u.supplied === false);
  if (bleed.length > 0) {
    state.log.push(`  【放血】缺补给参战单位各损1步：${bleed.map(unitLabel).join('、')}`);
    for (const u of bleed) applySteps(state, u, 1);
  }
}

function closeCombat(state) {
  state.pending = null;
  checkAnnihilation(state);
}
