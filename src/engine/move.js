// 移动：各单位独立行动、逐格扣自己的 MP。
// 费用 = 目标格地形费 + 格边附加费（大桥桥1 / 小河桥1 / 小河无桥=该单位最大MP一半）。
// 强ZOC：踩入即停；已在强ZOC中的单位未离开前不得进入另一强ZOC格。
// 满格友军格可穿不可停；敌占格不可进入。
import { UNIT_STATS, hexKey, parseKey, unitsAt, canStopIn, other,
         isBigRiver, isSmallRiver, isBridge, terrainAt } from './state.js';
import { TERRAIN } from './terrain.js';
import { DIRS, neighbor, inBounds, edgeKey } from './hex.js';
import { strongZoc } from './zoc.js';

export function stepCost(state, unit, from, to) {
  const t = terrainAt(state, to);
  let c = TERRAIN[t].mp[unit.type];
  if (isBigRiver(state, from, to)) {
    if (!isBridge(state, from, to)) return Infinity;
    c += 1;
  } else if (isSmallRiver(state, from, to)) {
    c += isBridge(state, from, to) ? 1 : (UNIT_STATS[unit.type].mp >> 1);
  }
  return c;
}

// Dijkstra 可达图：key -> { cost, stoppable, parentKey, strong, exitedStrong, depth }
export function computeReachable(state, unit) {
  const strong = strongZoc(state, other(unit.side));
  const mp = UNIT_STATS[unit.type].mp;
  const startKey = hexKey(unit);
  const nodes = new Map();
  const startStrong = strong.has(startKey);
  nodes.set(startKey, { cost: 0, stoppable: false, parentKey: null, strong: startStrong,
                        exitedStrong: !startStrong, depth: 0 });
  const frontier = [startKey];
  while (frontier.length) {
    frontier.sort((a, b) => nodes.get(a).cost - nodes.get(b).cost);
    const k = frontier.shift();
    const n = nodes.get(k);
    if (n.strong && n.depth > 0) continue; // 踩入强ZOC即停，不再扩张
    const cur = parseKey(k);
    for (const d of DIRS) {
      const to = neighbor(cur, d);
      if (!inBounds(to, state.width, state.height)) continue;
      if (unitsAt(state, to.col, to.row).some(u => u.side !== unit.side)) continue; // 敌占格
      if (isBigRiver(state, cur, to) && !isBridge(state, cur, to)) continue;
      const c = stepCost(state, unit, cur, to);
      if (c === Infinity) continue;
      const nc = n.cost + c;
      if (nc > mp) continue;
      const tk = hexKey(to);
      const toStrong = strong.has(tk);
      if (!n.exitedStrong && toStrong) continue; // 强→强禁行（未离开强ZOC前）
      const old = nodes.get(tk);
      if (old && old.cost <= nc) continue;
      nodes.set(tk, {
        cost: nc,
        stoppable: canStopIn(state, to.col, to.row, unit.type),
        parentKey: k,
        strong: toStrong,
        exitedStrong: !toStrong,
        depth: n.depth + 1,
      });
      frontier.push(tk);
    }
  }
  return nodes;
}

export function pathTo(nodes, dest) {
  const chain = [];
  let k = hexKey(dest);
  while (k && nodes.has(k)) {
    const n = nodes.get(k);
    chain.unshift(parseKey(k));
    k = n.parentKey;
  }
  return chain; // 含起点
}

// 执行移动（含全部校验）。成功返回路径，失败抛错。
export function doMove(state, unit, dest) {
  const nodes = computeReachable(state, unit);
  const info = nodes.get(hexKey(dest));
  if (!info || !info.stoppable) throw new Error('该格不可达或不可停留');
  if (info.cost === 0) throw new Error('原地不动无意义');
  const path = pathTo(nodes, dest);
  unit.col = dest.col;
  unit.row = dest.row;
  unit.moved = true;
  return path;
}
