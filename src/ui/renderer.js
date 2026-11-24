// Canvas 六角渲染：地形/河流/桥/目标点/单位/高亮。
import { TERRAIN } from '../engine/terrain.js';
import { hexKey, unitsAt, UNIT_STATS } from '../engine/state.js';
import { edgeKey } from '../engine/hex.js';

const SIZE = 30;
const SQ3 = Math.sqrt(3);
const PAD = 24;

export const CANVAS_W = Math.ceil(SIZE * SQ3 * 15.5) + PAD * 2;  // ≈853
export const CANVAS_H = Math.ceil(SIZE * 1.5 * 10) + SIZE * 2 + PAD * 2; // ≈568

export function hexCenter(col, row) {
  return {
    x: SIZE * SQ3 * (col + 0.5 * (row & 1)) + SIZE * SQ3 / 2 + PAD,
    y: SIZE * 1.5 * row + SIZE + PAD,
  };
}

export function pointToHex(x, y, width, height) {
  let best = null, bestD = Infinity;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const c = hexCenter(col, row);
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bestD) { bestD = d; best = { col, row }; }
    }
  }
  return bestD <= (SIZE * 0.95) ** 2 ? best : null;
}

function hexPath(ctx, cx, cy) {
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = (-90 + 60 * k) * Math.PI / 180;
    const px = cx + SIZE * Math.cos(a);
    const py = cy + SIZE * Math.sin(a);
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function edgeSegment(a, b) {
  const ca = hexCenter(a.col, a.row), cb = hexCenter(b.col, b.row);
  const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
  let dx = cb.x - ca.x, dy = cb.y - ca.y;
  const len = Math.hypot(dx, dy);
  dx /= len; dy /= len;
  const px = -dy * SIZE / 2, py = dx * SIZE / 2;
  return [mx - px, my - py, mx + px, my + py];
}

export function draw(ctx, state, ui) {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = '#2e2c28';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // 地形
  for (let row = 0; row < state.height; row++) {
    for (let col = 0; col < state.width; col++) {
      const t = TERRAIN[state.terrain[row][col]];
      const c = hexCenter(col, row);
      hexPath(ctx, c.x, c.y);
      ctx.fillStyle = t.fill;
      ctx.fill();
      ctx.strokeStyle = '#3a3833';
      ctx.lineWidth = 1;
      ctx.stroke();
      drawGlyph(ctx, state.terrain[row][col], c.x, c.y);
    }
  }

  // 河流与桥
  drawRivers(ctx, state, 'bigRiver', '#2f6db3', 6);
  drawRivers(ctx, state, 'smallRiver', '#7fb3e0', 3.5);
  for (const key of state.bridges) {
    const [a, b] = key.split('|').map(s => { const [c, r] = s.split(',').map(Number); return { col: c, row: r }; });
    const [x1, y1, x2, y2] = edgeSegment(a, b);
    ctx.strokeStyle = '#8b5e34';
    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.strokeStyle = '#e8d8b0';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // 目标点
  for (const o of state.objectives) {
    const c = hexCenter(o.col, o.row);
    ctx.strokeStyle = '#d33';
    ctx.lineWidth = 2.5;
    hexPath(ctx, c.x, c.y - 4);
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd9d9';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('★' + o.name, c.x, c.y + SIZE - 6);
  }

  // 高亮层
  if (ui.strongZoc) {
    ctx.strokeStyle = '#b06ad3';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    for (const k of ui.strongZoc) {
      const [col, row] = k.split(',').map(Number);
      const c = hexCenter(col, row);
      hexPath(ctx, c.x, c.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  const fillSets = [
    [ui.reachableStoppable, 'rgba(255,255,255,0.35)'],
    [ui.retreatHexes, 'rgba(120,220,120,0.45)'],
    [ui.bombardHexes, 'rgba(255,170,60,0.35)'],
  ];
  for (const [set, color] of fillSets) {
    if (!set) continue;
    ctx.fillStyle = color;
    for (const k of set) {
      const [col, row] = k.split(',').map(Number);
      const c = hexCenter(col, row);
      hexPath(ctx, c.x, c.y);
      ctx.fill();
    }
  }
  if (ui.attackTarget) {
    const c = hexCenter(ui.attackTarget.col, ui.attackTarget.row);
    ctx.strokeStyle = '#ff4040';
    ctx.lineWidth = 3;
    hexPath(ctx, c.x, c.y);
    ctx.stroke();
  }
  if (ui.selectedId) {
    const u = state.units.find(x => x.id === ui.selectedId);
    if (u && !u.dead) {
      const c = hexCenter(u.col, u.row);
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 3;
      hexPath(ctx, c.x, c.y);
      ctx.stroke();
    }
  }

  // 单位（同格多单位时错开一点，都能看见）
  const alive = state.units.filter(u => !u.dead);
  const groups = {};
  for (const u of alive) {
    const k = u.col + ',' + u.row;
    (groups[k] = groups[k] || []).push(u);
  }
  for (const k of Object.keys(groups)) {
    const g = groups[k];
    g.forEach((u, i) => drawUnit(ctx, u, i - (g.length - 1) / 2));
  }
}

function drawRivers(ctx, state, setName, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  for (const key of state[setName]) {
    const parts = key.split('|').map(s => { const [c, r] = s.split(',').map(Number); return { col: c, row: r }; });
    const [x1, y1, x2, y2] = edgeSegment(parts[0], parts[1]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
}

function drawGlyph(ctx, t, cx, cy) {
  ctx.strokeStyle = 'rgba(40,40,30,0.55)';
  ctx.fillStyle = 'rgba(40,40,30,0.55)';
  if (t === 'F') {
    for (const [ox, oy] of [[-8, 4], [0, -4], [8, 4]]) {
      ctx.beginPath();
      ctx.moveTo(cx + ox, cy + oy - 6);
      ctx.lineTo(cx + ox - 4, cy + oy + 3);
      ctx.lineTo(cx + ox + 4, cy + oy + 3);
      ctx.closePath(); ctx.fill();
    }
  } else if (t === 'H') {
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx - 9, cy + 3); ctx.lineTo(cx - 3, cy - 5); ctx.lineTo(cx + 3, cy + 3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 1, cy + 5); ctx.lineTo(cx + 7, cy - 3); ctx.lineTo(cx + 13, cy + 5); ctx.stroke();
  } else if (t === 'T') {
    for (const [ox, oy] of [[-6, -3], [3, 2]]) {
      ctx.fillRect(cx + ox, cy + oy, 8, 8);
    }
  } else if (t === 'R') {
    ctx.strokeStyle = 'rgba(90,70,40,0.8)';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy); ctx.stroke();
  }
}

const SIDE_COLORS = {
  attacker: { border: '#7a1f18', fill: '#e8a49a', symbol: '#3a120e' },
  defender: { border: '#1f4e79', fill: '#a9c8e6', symbol: '#0e2237' },
};

function drawUnit(ctx, u, shift = 0) {
  const c = hexCenter(u.col, u.row);
  c.x += (shift || 0) * 9;
  c.y += (shift || 0) * 5;
  const col = SIDE_COLORS[u.side];
  const w = 30, h = 20;
  ctx.fillStyle = u.face === 'reduced' ? '#cdbba8' : col.fill;
  ctx.strokeStyle = col.border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(c.x - w / 2, c.y - h / 2, w, h, 3);
  ctx.fill(); ctx.stroke();

  ctx.strokeStyle = col.symbol;
  ctx.fillStyle = col.symbol;
  ctx.lineWidth = 2;
  if (u.type === 'infantry') {
    ctx.beginPath();
    ctx.moveTo(c.x - 9, c.y - 6); ctx.lineTo(c.x + 9, c.y + 6);
    ctx.moveTo(c.x - 9, c.y + 6); ctx.lineTo(c.x + 9, c.y - 6);
    ctx.stroke();
  } else if (u.type === 'armor') {
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, 9, 5.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - 3.5); ctx.lineTo(c.x, c.y - 8);
    ctx.stroke();
  }
  // 编号
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = col.symbol;
  ctx.fillText(String(u.no), c.x - w / 2 + 2, c.y - h / 2 + 9);
  // 状态标记
  if (u.suppressLevel) {
    ctx.fillStyle = '#ff8c00';
    ctx.beginPath(); ctx.arc(c.x + w / 2 - 3, c.y - h / 2 + 1, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 7px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('压', c.x + w / 2 - 3, c.y - h / 2 + 3.5);
  }
  if (u.supplied === false) {
    ctx.fillStyle = '#d00';
    ctx.beginPath(); ctx.arc(c.x - w / 2 + 3, c.y - h / 2 + 1, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('!', c.x - w / 2 + 3, c.y - h / 2 + 4);
  }
}
