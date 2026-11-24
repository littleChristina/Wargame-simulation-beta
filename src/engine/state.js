// 单位数据与通用查询。MP 为实际值 ×2（步8 装18 炮6）。
export const UNIT_STATS = {
  infantry: { name: '步兵', atk: { full: 5, reduced: 3 }, def: { full: 6, reduced: 4 }, mp: 8, stack: 1, hasReduced: true },
  armor:    { name: '装甲', atk: { full: 8, reduced: 4 }, def: { full: 5, reduced: 4 }, mp: 18, stack: 2, hasReduced: true },
  artillery:{ name: '炮兵', atk: null, def: { full: 3, reduced: 3 }, mp: 6, stack: 0, hasReduced: false },
};

export const MAX_STACK = 3;   // 每格堆叠上限（点）
export const MAX_ARTY = 2;    // 每格炮兵上限（门）

export function hexKey(h) { return `${h.col},${h.row}`; }
export function parseKey(k) { const [c, r] = k.split(',').map(Number); return { col: c, row: r }; }
export function other(side) { return side === 'attacker' ? 'defender' : 'attacker'; }
export function sideName(side) { return side === 'attacker' ? '攻方' : '守方'; }

export function findUnit(state, id) { return state.units.find(u => u.id === id) || null; }
export function aliveUnits(state) { return state.units.filter(u => !u.dead); }
export function unitsAt(state, col, row) {
  return state.units.filter(u => !u.dead && u.col === col && u.row === row);
}

export function unitAttack(u) {
  if (u.type === 'artillery') return 0;
  const st = UNIT_STATS[u.type];
  let a = st.atk[u.face];
  if (u.suppressLevel) a = Math.max(1, a - u.suppressLevel);
  return a;
}

export function unitDefense(u) {
  const st = UNIT_STATS[u.type];
  let d = st.def[u.face];
  if (u.suppressLevel) d = Math.max(1, d - u.suppressLevel);
  return d;
}

export function unitLabel(u) {
  const s = UNIT_STATS[u.type];
  return `${s.name}${u.no != null ? u.no : ''}${u.face === 'reduced' ? '(受损)' : ''}`;
}

export function stackPointsIn(state, col, row) {
  return unitsAt(state, col, row).reduce((s, u) => s + UNIT_STATS[u.type].stack, 0);
}

export function artyCountIn(state, col, row) {
  return unitsAt(state, col, row).filter(u => u.type === 'artillery').length;
}

// 单位能否停入该格（堆叠容量与炮兵上限）
export function canStopIn(state, col, row, unitType) {
  if (stackPointsIn(state, col, row) + UNIT_STATS[unitType].stack > MAX_STACK) return false;
  if (unitType === 'artillery' && artyCountIn(state, col, row) >= MAX_ARTY) return false;
  return true;
}

// 损 n 步：满编→受损→摧毁。炮兵无受损面，损步即毁。
export function applySteps(state, u, n) {
  const st = UNIT_STATS[u.type];
  for (let i = 0; i < n; i++) {
    if (u.dead) return;
    if (u.face === 'full' && st.hasReduced) {
      u.face = 'reduced';
      state.log.push(`【损步】${unitLabel(u)} 翻面至受损面`);
    } else {
      u.dead = true;
      state.log.push(`【摧毁】${unitLabel(u)} 被摧毁`);
    }
  }
}

// ---- 地图查询 ----
export function terrainAt(state, h) { return state.terrain[h.row][h.col]; }
export function terrainName(state, h) { return TERRAIN_NAME[terrainAt(state, h)]; }

const TERRAIN_NAME = { P: '平原', R: '道路', F: '森林', H: '丘陵', T: '城镇' };

export function isBigRiver(state, a, b) { return state.bigRiver.has(edgeKeyOf(a, b)); }
export function isSmallRiver(state, a, b) { return state.smallRiver.has(edgeKeyOf(a, b)); }
export function isBridge(state, a, b) { return state.bridges.has(edgeKeyOf(a, b)); }

function edgeKeyOf(a, b) {
  const [x, y] = (a.col < b.col || (a.col === b.col && a.row < b.row)) ? [a, b] : [b, a];
  return `${x.col},${x.row}|${y.col},${y.row}`;
}
