// 开局设置：对局模式与指挥官分配。引擎只记录 commander 字段和 meta，
// 规则判定不读这些数据——谁能操作什么由 UI 层根据它来限制。
export const MODE = {
  SOLO_PVE: 'solo-pve',   // 单人 vs AI
  COOP_PVE: 'coop-pve',   // 双人合作 vs AI
  PVP: 'pvp',             // 热座 PvP
};

export const AI_COMMANDER = 'AI';

// 均分预设：points 为单位堆叠点数组（顺序与单位列表一致），
// 按点数降序贪心，每次分给点数较少的一方（持平则轮流）。
// 返回 ('P1'|'P2')[]，与输入顺序对齐。
export function evenSplitByPoints(points) {
  const pts = { P1: 0, P2: 0 };
  let toggle = 'P1';
  const order = points.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p || a.i - b.i);
  const res = new Array(points.length).fill('P1');
  for (const { p, i } of order) {
    let target;
    if (pts.P1 === pts.P2) target = toggle;
    else target = pts.P1 < pts.P2 ? 'P1' : 'P2';
    res[i] = target;
    pts[target] += p;
    toggle = toggle === 'P1' ? 'P2' : 'P1';
  }
  return res;
}

function UNIT_STACK(type) { return type === 'armor' ? 2 : (type === 'infantry' ? 1 : 0); }

// 把设置写进对局状态。setup = { mode, p1Side, split? }
// p1Side：PVE = 人类阵营；PvP = 玩家1 阵营。split 仅 coop-pve 生效：
// 数组，与单位列表同序，值为 'P1' | 'P2'。
export function applySetup(state, setup) {
  const mode = setup.mode;
  const p1Side = setup.p1Side;
  const otherSide = p1Side === 'attacker' ? 'defender' : 'attacker';
  state.meta = {
    mode,
    p1Side,
    aiSides: mode === MODE.PVP ? [] : [otherSide],
    humanSides: mode === MODE.PVP ? ['attacker', 'defender'] : [p1Side],
  };
  state.units.forEach((u, i) => {
    if (mode === MODE.PVP) u.commander = u.side === p1Side ? 'P1' : 'P2';
    else if (u.side === otherSide) u.commander = AI_COMMANDER;
    else if (mode === MODE.COOP_PVE && Array.isArray(setup.split) && setup.split[i]) u.commander = setup.split[i];
    else u.commander = 'P1';
  });
  return state;
}

export function isAiSide(state, side) {
  return !!(state.meta && Array.isArray(state.meta.aiSides) && state.meta.aiSides.includes(side));
}

// 双人合作下，某阵营的指挥官列表
export function commandersOfSide(state, side) {
  const set = new Set();
  for (const u of state.units) if (!u.dead && u.side === side) set.add(u.commander);
  return [...set].sort();
}
