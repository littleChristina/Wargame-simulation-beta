// 双层 ZOC：弱（无效果）/强（≥2 个敌方非炮兵单位弱ZOC重叠）。
// ZOC（含弱）不跨大河格边延伸（桥除外）。炮兵不施 ZOC。
import { DIRS, neighbor, inBounds } from './hex.js';
import { hexKey, isBigRiver, isBridge } from './state.js';

// 返回 Map<key, 投射单位数>：side 一方所有非炮兵单位周边 6 格
export function weakZocCounts(state, side) {
  const counts = new Map();
  for (const u of state.units) {
    if (u.dead || u.side !== side || u.type === 'artillery') continue;
    const from = { col: u.col, row: u.row };
    for (const d of DIRS) {
      const n = neighbor(from, d);
      if (!inBounds(n, state.width, state.height)) continue;
      if (isBigRiver(state, from, n) && !isBridge(state, from, n)) continue;
      const k = hexKey(n);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return counts;
}

// side 一方的强 ZOC 格集合（相对对方而言是"敌方强ZOC"）
export function strongZoc(state, side) {
  const counts = weakZocCounts(state, side);
  const s = new Set();
  for (const [k, c] of counts) if (c >= 2) s.add(k);
  return s;
}
