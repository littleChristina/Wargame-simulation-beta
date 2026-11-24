// 战斗结果表（CRT，2d6，高骰利于攻方）。行序 = 比值从劣到优。
export const ROWS = [
  { name: '1:3',   vals: ['A2', 'A2', 'A1', 'A1', 'A1', 'A1', 'C', 'C', 'C', 'C', 'C'] },
  { name: '1:2',   vals: ['A2', 'A1', 'A1', 'A1', 'C', 'C', 'C', 'C', 'DR', 'DR', 'DR'] },
  { name: '1:1',   vals: ['A2', 'A1', 'A1', 'C', 'D1', 'D1', 'DR', 'DR', 'DR1', 'DR1', 'DR1'] },
  { name: '1.5:1', vals: ['A1', 'A1', 'C', 'C', 'DR', 'DR', 'DR1', 'DR1', 'DR1', 'DRR1', 'DRR1'] },
  { name: '2:1',   vals: ['A1', 'C', 'C', 'DR', 'DR', 'DR1', 'DR1', 'DR1', 'DRR1', 'DRR1', 'DRR1'] },
  { name: '3:1',   vals: ['C', 'DR', 'DR1', 'DR1', 'DR1', 'DRR1', 'DRR1', 'D2', 'D2', 'D2', 'D2'] },
  { name: '4:1',   vals: ['DR', 'DR1', 'DRR1', 'DRR1', 'D2', 'D2', 'D2', 'D2', 'D2', 'D2', 'D2'] },
  { name: '5:1+',  vals: ['DRR1', 'D2', 'D2', 'D2', 'D2', 'D2', 'D2', 'D2', 'D2', 'D2', 'D2'] },
];

// 比值取行：四舍五入到最近行，距离相等取较低（对攻方劣）行；≥5 落 5:1+；<1:3 封底。
const ROW_VALUES = [1 / 3, 0.5, 1, 1.5, 2, 3, 4];

export function rowForRatio(atk, def) {
  if (atk <= 0 || def <= 0) throw new Error(`非法比值 ${atk}:${def}`);
  const x = atk / def;
  if (x >= 5) return 7;
  let best = 0;
  let bestDist = Infinity;
  ROW_VALUES.forEach((v, i) => {
    const d = Math.abs(x - v);
    if (d < bestDist - 1e-9) { bestDist = d; best = i; } // 严格小于：平手保留较低行
  });
  return best;
}

export function clampRow(rowIndex) {
  return Math.max(0, Math.min(ROWS.length - 1, rowIndex));
}

export const RESULT_INFO = {
  C:    { a: 0, d: 0, r: 0, desc: '无事发生' },
  A1:   { a: 1, d: 0, r: 0, desc: '攻方损1步' },
  A2:   { a: 2, d: 0, r: 0, desc: '攻方损2步' },
  DR:   { a: 0, d: 0, r: 1, desc: '守方退1格' },
  DRR:  { a: 0, d: 0, r: 2, desc: '守方退2格' },
  DR1:  { a: 0, d: 1, r: 1, desc: '守方退1格且损1步' },
  DRR1: { a: 0, d: 1, r: 2, desc: '守方退2格且损1步' },
  D1:   { a: 0, d: 1, r: 0, desc: '守方原地损1步' },
  D2:   { a: 0, d: 2, r: 0, desc: '守方损2步' },
};

// 某一行各结果的概率分布（按 2d6 真实点数概率加权，而非等概率的格子数）
const ROLL_P = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]; // 骰点 2..12
export function rowOdds(rowIndex) {
  const probs = {};
  ROWS[rowIndex].vals.forEach((v, i) => { probs[v] = (probs[v] || 0) + ROLL_P[i]; });
  const order = ['C', 'A1', 'A2', 'D1', 'D2', 'DR', 'DR1', 'DRR1'];
  return order.filter(k => probs[k])
    .map(k => `${k} ${Math.round(probs[k] / 36 * 100)}%`)
    .join('　');
}
