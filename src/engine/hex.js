// 六角坐标：奇数行右移（odd-r, pointy-top）。数学运算在需要时换算 axial/cube。
export const DIRS = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];

const NEI_EVEN = { E: [1, 0], NE: [0, -1], NW: [-1, -1], W: [-1, 0], SW: [-1, 1], SE: [0, 1] };
const NEI_ODD  = { E: [1, 0], NE: [1, -1], NW: [0, -1], W: [-1, 0], SW: [0, 1], SE: [1, 1] };

export function neighbor(hex, dir) {
  const table = (hex.row & 1) ? NEI_ODD : NEI_EVEN;
  const d = table[dir];
  return { col: hex.col + d[0], row: hex.row + d[1] };
}

export function neighbors(hex) {
  return DIRS.map(d => neighbor(hex, d));
}

export function offsetToAxial(col, row) {
  return { q: col - ((row - (row & 1)) >> 1), r: row };
}

export function hexDistance(a, b) {
  const A = offsetToAxial(a.col, a.row), B = offsetToAxial(b.col, b.row);
  const dq = A.q - B.q, dr = A.r - B.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

// 两个相邻格共有的格边（无方向），键为排序后的格对
export function edgeKey(a, b) {
  const [x, y] = (a.col < b.col || (a.col === b.col && a.row < b.row)) ? [a, b] : [b, a];
  return `${x.col},${x.row}|${y.col},${y.row}`;
}

export function inBounds(h, width, height) {
  return h.col >= 0 && h.col < width && h.row >= 0 && h.row < height;
}
