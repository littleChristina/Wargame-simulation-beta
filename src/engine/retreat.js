// 撤退路线：逐格规划。每走一格都在这里判定——不可进敌占格、敌强ZOC，不可跨大河（桥除外），
// 不可走回头路（不重复经过本次路线上的格，含出发格）。
// 堆叠不在这里判定，只在终点判定（见 combat.js）。
import { DIRS, neighbor, inBounds } from './hex.js';
import { hexKey, unitsAt, other, isBigRiver, isBridge } from './state.js';
import { strongZoc } from './zoc.js';

// unit：正在撤退的单位（取其当前位置）；path：本次路线已经过的格（含出发格）
export function retreatStepOptions(state, unit, path) {
  const enemyStrong = strongZoc(state, other(unit.side));
  const visited = new Set(path.map(h => `${h.col},${h.row}`));
  const out = [];
  for (const d of DIRS) {
    const to = neighbor(unit, d);
    if (!inBounds(to, state.width, state.height)) continue;
    if (visited.has(hexKey(to))) continue;
    if (unitsAt(state, to.col, to.row).some(u => u.side !== unit.side)) continue;
    if (enemyStrong.has(hexKey(to))) continue;
    if (isBigRiver(state, unit, to) && !isBridge(state, unit, to)) continue;
    out.push(to);
  }
  return out;
}
