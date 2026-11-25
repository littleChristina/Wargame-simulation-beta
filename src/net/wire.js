// 权威对局状态的网络序列化：服务端 room.state → 纯 JSON，客户端还原为引擎可用的 state。
// 注意：bigRiver/smallRiver/bridges 是 Set，JSON 会丢；必须转数组再还原。
// rngState 不下发：客户端只做只读预览（可达格/攻击预览/炮击范围），掷骰只在服务端。
export const WIRE_LOG_LIMIT = 240;

export function encodeState(state) {
  if (!state) return null;
  return {
    width: state.width,
    height: state.height,
    turns: state.turns,
    objectives: state.objectives,
    objectivesNeeded: state.objectivesNeeded,
    supplySource: state.supplySource,
    terrain: state.terrain,
    bigRiver: [...state.bigRiver],
    smallRiver: [...state.smallRiver],
    bridges: [...state.bridges],
    units: state.units,
    turn: state.turn,
    activeSide: state.activeSide,
    phase: state.phase,
    pending: state.pending,
    over: state.over,
    log: state.log.slice(-WIRE_LOG_LIMIT),
    phaseBombards: state.phaseBombards,
    seedText: state.seedText,
    meta: state.meta,
  };
}

export function decodeState(wire) {
  if (!wire) return null;
  return {
    ...wire,
    bigRiver: new Set(wire.bigRiver || []),
    smallRiver: new Set(wire.smallRiver || []),
    bridges: new Set(wire.bridges || []),
    rngState: 0,   // 客户端不掷骰；服务端才是权威
  };
}
