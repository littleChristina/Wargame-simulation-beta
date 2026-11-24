// 炮兵：间接压制。必中；射程2-6（不能打相邻）；移动或射击二选一；被压制=哑火；断供不能射击。
// 同格多门炮轰同一目标 → 压制−2封顶；不同格炮 → 刷新不叠加。
import { hexKey, findUnit, unitsAt, unitLabel } from './state.js';
import { hexDistance } from './hex.js';

export function canBombard(state, arty, target) {
  if (!arty || arty.dead || arty.type !== 'artillery') return false;
  if (arty.side !== state.activeSide || state.phase !== 'combat' || state.pending) return false;
  if (arty.moved || arty.attacked) return false;
  if (arty.suppressLevel) return false;
  if (arty.supplied === false) return false;
  const d = hexDistance(arty, target);
  if (d < 2 || d > 6) return false;
  return unitsAt(state, target.col, target.row).some(u => u.side !== arty.side);
}

export function bombardTargets(state, arty) {
  const list = [];
  for (let row = 0; row < state.height; row++) {
    for (let col = 0; col < state.width; col++) {
      if (canBombard(state, arty, { col, row })) list.push({ col, row });
    }
  }
  return list;
}

export function bombard(state, artyId, target) {
  const arty = findUnit(state, artyId);
  if (!arty || !canBombard(state, arty, target)) throw new Error('炮击条件不满足');
  const tk = hexKey(target);
  const priorSameHex = state.phaseBombards.filter(b => b.targetKey === tk && b.originKey === hexKey(arty)).length;
  const level = priorSameHex + 1 >= 2 ? 2 : 1;
  const hits = unitsAt(state, target.col, target.row);
  for (const u of hits) {
    u.suppressLevel = Math.max(u.suppressLevel || 0, level);
    u.suppressFirer = state.activeSide;
  }
  arty.attacked = true;
  state.phaseBombards.push({ originKey: hexKey(arty), targetKey: tk });
  state.log.push(`【炮击】${unitLabel(arty)} → (${target.col},${target.row})：${hits.length}个单位被压制（攻防−${level}）`);
}
