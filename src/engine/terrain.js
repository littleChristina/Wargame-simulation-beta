// 地形定义。MP 为内部整数（实际值 ×2，避免 0.5 的浮点问题）。
// shift 为攻方行修正（负值 = 对攻方不利）。
export const TERRAIN = {
  P: { char: 'P', name: '平原', mp: { infantry: 2, armor: 2, artillery: 2 }, shift: 0, fill: '#a8c686' },
  R: { char: 'R', name: '道路', mp: { infantry: 1, armor: 1, artillery: 1 }, shift: 0, fill: '#d6cba0' },
  F: { char: 'F', name: '森林', mp: { infantry: 4, armor: 6, artillery: 4 }, shift: -1, fill: '#63965f' },
  H: { char: 'H', name: '丘陵', mp: { infantry: 4, armor: 6, artillery: 4 }, shift: -1, fill: '#c9ad72' },
  T: { char: 'T', name: '城镇', mp: { infantry: 4, armor: 4, artillery: 4 }, shift: -1, fill: '#b0a494' },
};
