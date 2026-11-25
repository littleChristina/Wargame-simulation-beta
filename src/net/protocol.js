// 联机协议（Node 服务端与浏览器共用）：HTTP 路径、指令类型、房间码规则。
export const API = Object.freeze({
  create: '/api/create',
  join: '/api/join',
  resume: '/api/resume',
  events: '/api/events',
  cmd: '/api/cmd',
  close: '/api/close',
  network: '/api/network',
});

export const CMD = Object.freeze({
  MOVE: 'move',
  END_PHASE: 'endPhase',
  BOMBARD: 'bombard',
  DECLARE_ATTACK: 'declareAttack',
  ASSIGN: 'assign',
  UNASSIGN: 'unassign',
  CLEAR_ASSIGN: 'clearAssign',
  COMMIT: 'commit',
  BEGIN_RETREAT: 'beginRetreat',
  RETREAT_STEP: 'retreatStep',
  TOGGLE_ADVANCE: 'toggleAdvance',
  COMMIT_ADVANCE: 'commitAdvance',
  SKIP_ADVANCE: 'skipAdvance',
  READY: 'ready',
  NEW_GAME: 'newGame',
});

export const CMD_TYPES = new Set(Object.values(CMD));

// 房间码字母表去掉易混淆的 I/O/0/1
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LEN = 4;

export function isValidRoomCode(code) {
  if (typeof code !== 'string' || code.length !== ROOM_CODE_LEN) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export const SSE_HEARTBEAT_MS = 15000;
export const SSE_RETRY_MS = 2000;
export const MAX_BODY_BYTES = 32 * 1024;
export const ROOM_TTL_MS = 30 * 60 * 1000;
export const MAX_ROOMS = 32;
export const MAX_SEATS = 2;
