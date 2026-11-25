// AI 数值核心：CRT 期望、可通行距离场、格子价值。纯函数，不执行任何动作。
import { ROWS, RESULT_INFO } from '../engine/crt.js';
import { TERRAIN } from '../engine/terrain.js';
import { terrainAt, isBigRiver, isBridge } from '../engine/state.js';
import { DIRS, neighbor, inBounds } from '../engine/hex.js';

const ROLL_P = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]; // 骰点 2..12 的概率（/36）

// 某比值行的结算期望：E(守方损步)、E(攻方损步)、P(守方阵地被腾空)
export function rowExpectations(rowIndex) {
  let ed = 0, ea = 0, vacate = 0;
  ROWS[rowIndex].vals.forEach((v, i) => {
    const info = RESULT_INFO[v];
    ed += ROLL_P[i] * info.d;
    ea += ROLL_P[i] * info.a;
    if (info.r > 0 || v === 'D2') vacate += ROLL_P[i];
  });
  return { ed: ed / 36, ea: ea / 36, vacate: vacate / 36 };
}

export const SELF_LOSS_WEIGHT = 0.8;   // AI 对自损的厌恶系数

// 可通行图上的距离场：从 seeds 出发，大河非桥格边视为断路
export function distanceField(state, seeds) {
  const dist = new Map();
  const queue = [];
  for (const s of seeds) {
    const k = s.col + ',' + s.row;
    if (!dist.has(k)) { dist.set(k, 0); queue.push(s); }
  }
  while (queue.length) {
    const cur = queue.shift();
    const d0 = dist.get(cur.col + ',' + cur.row);
    for (const d of DIRS) {
      const n = neighbor(cur, d);
      if (!inBounds(n, state.width, state.height)) continue;
      const k = n.col + ',' + n.row;
      if (dist.has(k)) continue;
      if (isBigRiver(state, cur, n) && !isBridge(state, cur, n)) continue;
      dist.set(k, d0 + 1);
      queue.push(n);
    }
  }
  return dist; // Map<"col,row", dist>
}

export function terrainShiftAt(state, hex) {
  return TERRAIN[terrainAt(state, hex)].shift;
}

// 格子静态价值：目标点最高，城镇/林地次之
export function hexStaticValue(state, hex, objectives) {
  let v = 0;
  for (const o of objectives) {
    if (o.col === hex.col && o.row === hex.row) v += 3;
  }
  const t = terrainAt(state, hex);
  if (t === 'T') v += 1.5;
  if (t === 'F' || t === 'H') v += 1;
  return v;
}
