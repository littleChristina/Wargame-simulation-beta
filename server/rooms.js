// 联机房间管理：权威 state 在 Node 端，浏览器只发指令、收全量快照。
// 设计：SSE 下发 + POST 发指令；人类应手按 pendingOwnerSide 判定；AI 在服务端驱动。
import crypto from 'node:crypto';
import { createGame, endPhase, moveUnit } from '../src/engine/engine.js';
import { declareAttack, assignStep, unassignStep, clearAssignments, commitAssign,
         beginRetreat, retreatStep, toggleAdvance, commitAdvance, skipAdvance } from '../src/engine/combat.js';
import { bombard } from '../src/engine/artillery.js';
import { findUnit, other, UNIT_STATS } from '../src/engine/state.js';
import { aiStep, shouldAiDrive, pendingOwnerSide } from '../src/ai/ai-player.js';
import { MODE, evenSplitByPoints } from '../src/engine/setup.js';
import { CMD, CMD_TYPES, ROOM_CODE_ALPHABET, ROOM_CODE_LEN,
         ROOM_TTL_MS, MAX_ROOMS, SSE_HEARTBEAT_MS, SSE_RETRY_MS } from '../src/net/protocol.js';
import { encodeState } from '../src/net/wire.js';

const sleep = ms => new Promise(res => setTimeout(res, ms));
const stateSig = st => st ? `${st.turn}|${st.activeSide}|${st.phase}` : '';

function randomSeed() { return crypto.randomBytes(4).readUInt32BE(0) >>> 0; }

function defaultCoopSplit(scenario, humanSide) {
  const human = scenario.units.map((u, i) => ({ u, i })).filter(x => x.u.side === humanSide);
  const parts = evenSplitByPoints(human.map(x => UNIT_STATS[x.u.type].stack));
  const split = new Array(scenario.units.length).fill('P2');
  human.forEach((x, k) => { split[x.i] = parts[k]; });
  return split;
}

function requireHex(h, what) {
  if (!h || !Number.isInteger(h.col) || !Number.isInteger(h.row)) {
    throw new Error(`${what}坐标不合法`);
  }
  return { col: h.col, row: h.row };
}

function publicSeat(seat) {
  return { id: seat.id, side: seat.side, commander: seat.commander, connected: !!seat.connected };
}

export class RoomManager {
  constructor({ scenario, aiStepDelayMs = 250, roomTtlMs = ROOM_TTL_MS,
                maxRooms = MAX_ROOMS, logger = console } = {}) {
    if (!scenario) throw new Error('RoomManager 需要 scenario');
    this.scenario = scenario;
    this.aiStepDelayMs = Math.max(0, aiStepDelayMs);
    this.roomTtlMs = roomTtlMs;
    this.maxRooms = maxRooms;
    this.logger = logger;
    this.rooms = new Map();
    this.timer = setInterval(() => this.cleanup(), 60_000);
    this.timer.unref?.();
  }

  // ---------- 房间 ----------
  create({ setup, seed } = {}) {
    if (this.rooms.size >= this.maxRooms) throw new Error('服务器房间已满，请稍后再试');
    const clean = this.normalizeSetup(setup);
    const s = Number(seed);
    const room = {
      code: this.allocCode(),
      setup: clean,
      seed: Number.isInteger(s) && s > 0 ? s : randomSeed(),
      state: null,
      seats: [
        this.makeSeat('P1', clean.p1Side, 'P1'),
        this.makeSeat('P2', clean.mode === MODE.PVP ? other(clean.p1Side) : clean.p1Side, 'P2'),
      ],
      seq: 0,
      ready: { P1: false, P2: false },
      stateSig: '',
      aiRunning: false,
      createdAt: Date.now(),
      lastActive: Date.now(),
    };
    this.rooms.set(room.code, room);
    return { room, seat: room.seats[0] };
  }

  join(room) {
    if (!room) throw new Error('房间不存在或已过期');
    const guest = room.seats[1];
    if (guest.token) throw new Error('房间已满');
    guest.token = this.newToken();
    guest.lastActive = Date.now();
    room.lastActive = Date.now();
    return guest;
  }

  room(code) { return this.rooms.get(String(code || '').toUpperCase()) || null; }

  seatByToken(room, token) {
    if (!room || !token) return null;
    return room.seats.find(s => s.token && s.token === token) || null;
  }

  resume(code, token) {
    const room = this.room(code);
    const seat = this.seatByToken(room, token);
    if (!seat) throw new Error('房间不存在或身份已失效');
    room.lastActive = Date.now();
    return { room, seat };
  }

  closeRoom(room) {
    if (!room) return;
    for (const s of room.seats) this.endSeat(s);
    this.rooms.delete(room.code);
  }

  // ---------- 连接（SSE） ----------
  attach(room, seat, res) {
    if (!room || !seat) throw new Error('无法建立连接');
    if (seat.res && seat.res !== res) { try { seat.res.end(); } catch { /* ignore */ } }
    seat.res = res;
    seat.connected = true;
    room.lastActive = Date.now();
    try {
      res.write(`retry: ${SSE_RETRY_MS}\n\n`);
      this.sseSend(res, { t: 'hello', seat: publicSeat(seat), room: this.publicRoom(room) });
      this.sseSend(res, this.snapshotMessage(room));
    } catch (e) { this.detach(room, seat, res); return; }
    clearInterval(seat.timer);
    seat.timer = setInterval(() => {
      if (!seat.res) return;
      try { seat.res.write(`: ping\n\n`); } catch { this.detach(room, seat, seat.res); }
    }, SSE_HEARTBEAT_MS);
    seat.timer.unref?.();
    res.on('close', () => this.detach(room, seat, res));
    this.maybeStart(room);
  }

  detach(room, seat, res) {
    if (!room || !seat || seat.res !== res) return;
    clearInterval(seat.timer);
    seat.timer = null;
    seat.res = null;
    seat.connected = false;
    room.lastActive = Date.now();
    // 让对手看到"掉线"状态；还没开局也广播一次等待画面
    this.broadcast(room);
  }

  endSeat(seat) {
    clearInterval(seat.timer);
    seat.timer = null;
    if (seat.res) { try { seat.res.end(); } catch { /* ignore */ } }
    seat.res = null;
    seat.connected = false;
  }

  // ---------- 开局 ----------
  maybeStart(room) {
    if (!room || room.state) return;
    if (room.seats.some(s => !s.token || !s.connected)) return;
    room.state = createGame(this.scenario, room.seed, room.setup);
    room.ready = { P1: false, P2: false };
    room.stateSig = stateSig(room.state);
    room.lastActive = Date.now();
    this.broadcast(room);
    this.kickAi(room);
  }

  // ---------- 快照 / 广播 ----------
  publicRoom(room) {
    return {
      code: room.code,
      mode: room.setup.mode,
      started: !!room.state,
      seats: room.seats.map(publicSeat),
    };
  }

  snapshotMessage(room) {
    const sig = stateSig(room.state);
    if (sig !== room.stateSig) {
      room.stateSig = sig;
      room.ready = { P1: false, P2: false };
    }
    room.seq += 1;
    return {
      t: 'snapshot',
      seq: room.seq,
      state: room.state ? encodeState(room.state) : null,
      aiRunning: room.aiRunning,
      ready: { P1: room.ready.P1, P2: room.ready.P2 },
      room: this.publicRoom(room),
    };
  }

  broadcast(room) {
    if (!room || this.rooms.get(room.code) !== room) return;
    room.lastActive = Date.now();
    const msg = this.snapshotMessage(room);
    for (const seat of room.seats) {
      if (seat.res) this.sseSend(seat.res, msg);
    }
  }

  sseSend(res, msg) {
    try { res.write(`data: ${JSON.stringify(msg)}\n\n`); }
    catch { /* 连接已断由 close 事件处理 */ }
  }

  notice(room, message) {
    const msg = { t: 'notice', message };
    for (const seat of room.seats) if (seat.res) this.sseSend(seat.res, msg);
  }

  // ---------- 指令 ----------
  apply(room, seat, cmd) {
    if (!room || !seat) throw new Error('房间或身份无效');
    if (!cmd || typeof cmd !== 'object' || !CMD_TYPES.has(cmd.t)) throw new Error('未知指令');
    if (!room.state) throw new Error('对局尚未开始，等待另一位玩家加入');
    if (room.aiRunning) throw new Error('AI 行动中，请稍候');
    const state = room.state;
    if (state.over && cmd.t !== CMD.NEW_GAME) throw new Error('战役已结束');
    room.lastActive = Date.now();

    if (cmd.t === CMD.NEW_GAME) {
      if (seat.id !== 'P1') throw new Error('只有房主可以开新对局');
      room.seed = randomSeed();
      room.state = createGame(this.scenario, room.seed, room.setup);
      room.ready = { P1: false, P2: false };
      room.stateSig = stateSig(room.state);
      this.broadcast(room);
      this.kickAi(room);
      return { ok: true, seq: room.seq };
    }

    if (cmd.t === CMD.READY) {
      this.applyReady(room, seat, cmd);
      return { ok: true, seq: room.seq };
    }

    const next = structuredClone(state);
    switch (cmd.t) {
      case CMD.MOVE: {
        this.requireActive(next, seat);
        this.requireOwn(next, seat, cmd.unitId, true);
        moveUnit(next, cmd.unitId, requireHex({ col: cmd.col, row: cmd.row }, '移动'));
        break;
      }
      case CMD.BOMBARD: {
        this.requireActive(next, seat);
        this.requireOwn(next, seat, cmd.unitId, true);
        bombard(next, cmd.unitId, requireHex({ col: cmd.col, row: cmd.row }, '炮击'));
        break;
      }
      case CMD.DECLARE_ATTACK: {
        this.requireActive(next, seat);
        const ids = Array.isArray(cmd.attackerIds) ? cmd.attackerIds : [];
        if (ids.length === 0) throw new Error('没有选择参战单位');
        for (const id of ids) {
          const u = findUnit(next, id);
          if (!u || u.dead || u.side !== seat.side) throw new Error('参战单位不属于你方');
        }
        declareAttack(next, ids, requireHex(cmd.target, '攻击目标'));
        break;
      }
      case CMD.ASSIGN: {
        this.requirePendingOwner(next, seat);
        assignStep(next, cmd.who, cmd.unitId);
        break;
      }
      case CMD.UNASSIGN: {
        this.requirePendingOwner(next, seat);
        unassignStep(next, cmd.who, cmd.unitId);
        break;
      }
      case CMD.CLEAR_ASSIGN: {
        this.requirePendingOwner(next, seat);
        clearAssignments(next, cmd.who);
        break;
      }
      case CMD.COMMIT: {
        this.requirePendingOwner(next, seat);
        commitAssign(next, cmd.who);
        break;
      }
      case CMD.BEGIN_RETREAT: {
        this.requirePendingOwner(next, seat);
        beginRetreat(next, cmd.unitId);
        break;
      }
      case CMD.RETREAT_STEP: {
        this.requirePendingOwner(next, seat);
        retreatStep(next, requireHex({ col: cmd.col, row: cmd.row }, '撤退'));
        break;
      }
      case CMD.TOGGLE_ADVANCE: {
        this.requirePendingOwner(next, seat);
        toggleAdvance(next, cmd.unitId);
        break;
      }
      case CMD.COMMIT_ADVANCE: {
        this.requirePendingOwner(next, seat);
        commitAdvance(next);
        break;
      }
      case CMD.SKIP_ADVANCE: {
        this.requirePendingOwner(next, seat);
        skipAdvance(next);
        break;
      }
      case CMD.END_PHASE: {
        this.requireActive(next, seat);
        if (next.meta && next.meta.mode === MODE.COOP_PVE) throw new Error('合作模式请用"准备"结束阶段');
        endPhase(next);
        break;
      }
      default:
        throw new Error('暂不支持的指令 ' + cmd.t);
    }
    room.state = next;
    this.broadcast(room);
    this.kickAi(room);
    return { ok: true, seq: room.seq };
  }

  applyReady(room, seat, cmd) {
    const state = room.state;
    if (!state.meta || state.meta.mode !== MODE.COOP_PVE) throw new Error('只有合作模式需要准备');
    this.requireActive(state, seat);
    if (state.pending) throw new Error('有未完成的战斗结算，先完成结算');
    if (cmd.kind !== state.phase) throw new Error('准备的项目与当前阶段不符');
    const me = seat.commander;
    const otherC = me === 'P1' ? 'P2' : 'P1';
    if (!room.ready[me] && room.ready[otherC]) {
      // 两人都准备 → 结束阶段（在克隆上执行，失败不落状态）
      const next = structuredClone(state);
      endPhase(next);
      room.state = next;
      room.ready = { P1: false, P2: false };
    } else {
      room.ready[me] = !room.ready[me];
    }
    this.broadcast(room);
    this.kickAi(room);
  }

  // ---------- AI（服务端驱动，联机时客户端不再自行 aiStep） ----------
  async kickAi(room) {
    if (!room || room.aiRunning || !room.state || room.state.over) return;
    if (!shouldAiDrive(room.state)) return;
    room.aiRunning = true;
    this.broadcast(room);
    let guard = 0;
    try {
      while (shouldAiDrive(room.state) && guard++ < 200) {
        const r = aiStep(room.state);
        this.broadcast(room);
        if (r !== 'continue' || !shouldAiDrive(room.state)) break;
        if (this.aiStepDelayMs > 0) await sleep(this.aiStepDelayMs);
      }
      if (guard >= 200 && shouldAiDrive(room.state)) throw new Error('AI 步数超过上限');
    } catch (e) {
      this.logger.error?.('[room] AI 出错:', e);
      this.notice(room, 'AI 出错：' + (e && e.message ? e.message : String(e)));
    } finally {
      room.aiRunning = false;
      this.broadcast(room);
    }
  }

  // ---------- 校验 ----------
  requireActive(state, seat) {
    if (state.over) throw new Error('战役已结束');
    if (state.activeSide !== seat.side) throw new Error('现在不是你方行动');
  }

  requirePendingOwner(state, seat) {
    if (!state.pending) throw new Error('当前没有待结算战斗');
    if (pendingOwnerSide(state, state.pending) !== seat.side) throw new Error('这一步应由对方应手');
  }

  requireOwn(state, seat, unitId, respectCommander) {
    const u = findUnit(state, unitId);
    if (!u || u.dead) throw new Error('单位不存在');
    if (u.side !== seat.side) throw new Error('不能操作对方单位');
    if (respectCommander && state.meta && state.meta.mode === MODE.COOP_PVE
        && u.commander !== seat.commander) {
      throw new Error('该单位属于队友');
    }
    return u;
  }

  // ---------- 内部 ----------
  makeSeat(id, side, commander) {
    return {
      id, side, commander,
      token: id === 'P1' ? this.newToken() : null,
      connected: false,
      res: null,
      timer: null,
    };
  }

  newToken() { return crypto.randomBytes(18).toString('hex'); }

  allocCode() {
    for (let i = 0; i < 200; i++) {
      let code = '';
      for (let k = 0; k < ROOM_CODE_LEN; k++) {
        code += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('无法分配房间号');
  }

  normalizeSetup(setup) {
    if (!setup || typeof setup !== 'object') throw new Error('缺少开局设置');
    const mode = setup.mode;
    if (mode !== MODE.PVP && mode !== MODE.COOP_PVE) {
      throw new Error('联机仅支持热座 PvP 或双人合作 PVE');
    }
    const p1Side = setup.p1Side;
    if (p1Side !== 'attacker' && p1Side !== 'defender') throw new Error('阵营设置不合法');
    let split = null;
    if (mode === MODE.COOP_PVE) {
      let candidate = null;
      if (Array.isArray(setup.split) && setup.split.length === this.scenario.units.length
          && setup.split.every(v => v === 'P1' || v === 'P2')) {
        candidate = setup.split.slice();
      }
      if (!candidate) candidate = defaultCoopSplit(this.scenario, p1Side);
      const human = this.scenario.units.map((u, i) => ({ u, i })).filter(x => x.u.side === p1Side);
      const p1 = human.filter(x => candidate[x.i] === 'P1').length;
      const p2 = human.length - p1;
      if (p1 === 0 || p2 === 0) throw new Error('请为玩家1和玩家2各分配至少一个单位（可用"均分预设"）');
      split = candidate;
    }
    return { mode, p1Side, split };
  }

  cleanup() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      const anyConnected = room.seats.some(s => s.connected);
      if (!anyConnected && now - room.lastActive > this.roomTtlMs) this.closeRoom(room);
    }
  }

  dispose() {
    clearInterval(this.timer);
    for (const room of [...this.rooms.values()]) this.closeRoom(room);
  }
}

export { publicSeat };
