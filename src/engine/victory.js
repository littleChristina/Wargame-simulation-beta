// 胜负判定：一方全灭立即终局；12回合结束按目标点判定。
import { unitsAt, aliveUnits, sideName } from './state.js';

export function checkAnnihilation(state) {
  if (state.over) return;
  const a = aliveUnits(state).filter(u => u.side === 'attacker').length;
  const d = aliveUnits(state).filter(u => u.side === 'defender').length;
  if (a === 0 && d === 0) state.over = 'draw';
  else if (a === 0) state.over = 'defender';
  else if (d === 0) state.over = 'attacker';
  if (state.over) {
    state.log.push(`【终局】一方全灭：${state.over === 'draw' ? '同归于尽' : sideName(state.over) + '胜'}`);
  }
}

// 控制定义：目标格上有本方（攻方）单位
export function evaluateScenarioEnd(state) {
  const held = state.objectives.filter(o =>
    unitsAt(state, o.col, o.row).some(u => u.side === 'attacker')).length;
  state.over = held >= state.objectivesNeeded ? 'attacker' : 'defender';
  state.log.push(`【终局】${state.turns}回合结束：攻方控制目标点 ${held}/${state.objectives.length}（需${state.objectivesNeeded}）→ ${sideName(state.over)}胜`);
}
