// 带种子的伪随机数（mulberry32）。状态存在 state.rngState 里，保证同种子同指令序列结果可复现。
export function nextRandom(state) {
  let s = state.rngState |= 0;
  s = (s + 0x6D2B79F5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  state.rngState = (t ^ (t >>> 14)) >>> 0;
  return state.rngState / 4294967296;
}

export function roll2d6(state) {
  const a = 1 + Math.floor(nextRandom(state) * 6);
  const b = 1 + Math.floor(nextRandom(state) * 6);
  return a + b;
}
