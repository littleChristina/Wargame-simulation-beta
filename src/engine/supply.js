// 补给：从补给源 BFS。不可进敌占格；不可穿敌强ZOC（该格有己方单位除外）；不可跨大河（桥除外）。
// 每方在自己回合开始的阶段1统一判定一次（离散补给）。
import { DIRS, neighbor, inBounds } from './hex.js';
import { hexKey, unitsAt, other, isBigRiver, isBridge } from './state.js';
import { strongZoc } from './zoc.js';

export function computeSupplySet(state, side) {
  const enemy = other(side);
  const enemyStrong = strongZoc(state, enemy);
  const visited = new Set();
  const queue = [];
  for (const s of state.supplySource[side]) {
    const k = hexKey(s);
    if (!visited.has(k)) { visited.add(k); queue.push(s); }
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const d of DIRS) {
      const to = neighbor(cur, d);
      if (!inBounds(to, state.width, state.height)) continue;
      const k = hexKey(to);
      if (visited.has(k)) continue;
      if (isBigRiver(state, cur, to) && !isBridge(state, cur, to)) continue;
      const occ = unitsAt(state, to.col, to.row);
      if (occ.some(u => u.side === enemy)) continue;               // 敌占格
      if (enemyStrong.has(k) && !occ.some(u => u.side === side)) continue; // 敌强ZOC且无己方单位
      visited.add(k);
      queue.push(to);
    }
  }
  return visited;
}

// 只刷新 side 一方单位的补给标记（离散判定：状态保持到下次判定）
export function markSupply(state, side) {
  const set = computeSupplySet(state, side);
  for (const u of state.units) {
    if (u.dead || u.side !== side) continue;
    u.supplied = set.has(hexKey(u));
  }
}
