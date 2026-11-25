// 界面控制器：对局内交互（热座 PvP / 单人 PVE / 双人合作 PVE）。
// 面板渲染见 panels.js，开局设置见 setup-screen.js，AI 决策见 ai/。
// 合作模式：双确认门槛（两处阶段转换）、指挥官切换、合并开火（借火力提示）。
import { draw, pointToHex, CANVAS_W, CANVAS_H } from './renderer.js';
import { hexKey, unitsAt, findUnit, other } from '../engine/state.js';
import { computeReachable } from '../engine/move.js';
import { endPhase, moveUnit, createGame } from '../engine/engine.js';
import { declareAttack, assignStep, unassignStep, clearAssignments, commitAssign,
         beginRetreat, retreatStep, retreatStepOptions, currentRetreatUnitId,
         eligibleAttackers, toggleAdvance, commitAdvance, skipAdvance } from '../engine/combat.js';
import { bombard, bombardTargets } from '../engine/artillery.js';
import { strongZoc } from '../engine/zoc.js';
import { isAiSide } from '../engine/setup.js';
import { aiStep, shouldAiDrive, pendingOwnerSide } from '../ai/ai-player.js';
import { createPanels } from './panels.js';
import { decodeState } from '../net/wire.js';
import { CMD } from '../net/protocol.js';
import { clearRoomToken } from '../net/client.js';

export function initApp(canvas, scenario, seed, setup, opts = {}) {
  const ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  // AI 步进间隔（毫秒）。测试注入 0 以同步跑完；正常游玩用 450 做逐步行进感。
  const aiStepDelayMs = Number.isFinite(opts.aiStepDelayMs) ? opts.aiStepDelayMs : 450;

  const net = opts.net || null;
  const isOnline = !!net;
  const seat = opts.seat || null;
  const initialSnapshot = opts.initialSnapshot || null;
  let state = (initialSnapshot && initialSnapshot.state)
    ? decodeState(initialSnapshot.state)
    : (opts.initialState || createGame(scenario, seed, setup));
  const getState = () => state;
  const ui = {
    selectedId: null, mode: 'idle', attackSel: null, flashMsg: '',
    stackChoices: null, commander: seat ? seat.commander : 'P1',
    ready: initialSnapshot && initialSnapshot.ready
      ? { P1: !!initialSnapshot.ready.P1, P2: !!initialSnapshot.ready.P2 }
      : { P1: false, P2: false },
    online: isOnline, seat, netBusy: false, netOffline: false,
    roomCode: net ? net.code : '',
    roomSeats: initialSnapshot && initialSnapshot.room ? initialSnapshot.room.seats : null,
    aiRunning: initialSnapshot ? !!initialSnapshot.aiRunning : false,
    aiHalted: false,
  };

  const els = {
    status: document.getElementById('status'),
    actions: document.getElementById('actions'),
    info: document.getElementById('info'),
    stackbar: document.getElementById('stackbar'),
    pending: document.getElementById('pending'),
    log: document.getElementById('log'),
    flash: document.getElementById('flash'),
  };
  const isCoop = () => !!(state.meta && state.meta.mode === 'coop-pve');
  // 可操作单位：AI 单位任何模式都不可操作；联机只能操作自己座位阵营；合作模式只能操作自己的单位
  const canOperate = u => !isAiSide(state, u.side)
    && (!isOnline || !seat || u.side === seat.side)
    && (!isCoop() || u.commander === ui.commander);

  // 联机：只有"轮到我"或"应手属于我"时才允许操作；本地热座不限制（AI 由 aiRunning 控制）
  function canTakeTurn() {
    if (state.over) return false;
    if (ui.aiRunning) return false;
    if (!isOnline) return true;
    if (ui.netBusy) return false;
    if (!seat) return false;
    if (state.pending) return pendingOwnerSide(state, state.pending) === seat.side;
    return state.activeSide === seat.side;
  }

  const panels = createPanels({ els, ui, getState, canOperate, canTakeTurn });

  function flash(msg) {
    ui.flashMsg = msg;
    els.flash.textContent = msg;
    setTimeout(() => { if (ui.flashMsg === msg) { ui.flashMsg = ''; els.flash.textContent = ''; } }, 3000);
  }
  function tryDo(fn) { try { fn(); } catch (e) { flash('⚠ ' + e.message); } }

  // 阶段/回合切换后清掉交互态，避免选中上一方单位或残留堆叠栏
  function resetInteraction() {
    ui.selectedId = null;
    ui.mode = 'idle';
    ui.attackSel = null;
    ui.stackChoices = null;
  }

  // 联机：发送指令（不本地改状态），等服务器快照回来再渲染；被拒则提示
  function sendCmd(cmd) {
    if (!isOnline) return false;
    ui.netBusy = true;
    render();
    net.send(cmd).then(res => {
      if (!res || res.ok !== true) {
        ui.netBusy = false;
        flash('⚠ ' + ((res && res.error) || '指令被拒绝'));
        render();
      }
    }).catch(e => {
      ui.netBusy = false;
      flash('⚠ 联机发送失败：' + (e && e.message ? e.message : e));
      render();
    });
    return true;
  }

  // 联机：用服务端全量快照替换本地镜像（客户端只做只读预览，不掷骰）
  function applySnapshot(msg) {
    if (!msg || !msg.state) return;
    const prev = state ? `${state.turn}|${state.activeSide}|${state.phase}|${state.over || ''}` : '';
    state = decodeState(msg.state);
    ui.aiRunning = !!msg.aiRunning;
    if (msg.ready) ui.ready = { P1: !!msg.ready.P1, P2: !!msg.ready.P2 };
    if (msg.room && Array.isArray(msg.room.seats)) ui.roomSeats = msg.room.seats;
    ui.netBusy = false;
    ui.netOffline = false;
    const next = `${state.turn}|${state.activeSide}|${state.phase}|${state.over || ''}`;
    if (prev !== next) resetInteraction();
    if (state.phase === 'move' && !state.pending && ui.selectedId) {
      const u = findUnit(state, ui.selectedId);
      if (u && !u.dead && u.side === state.activeSide && canOperate(u)) {
        const now = unitsAt(state, u.col, u.row).filter(x => x.side === state.activeSide && canOperate(x));
        ui.stackChoices = now.length >= 2 ? { col: u.col, row: u.row, ids: now.map(x => x.id) } : null;
      } else if (!u || u.dead) {
        ui.selectedId = null;
        ui.stackChoices = null;
      }
    }
    render();
  }

  const canStopAt = (unit, hex) => {
    const nfo = computeReachable(state, unit).get(hexKey(hex));
    return !!(nfo && nfo.stoppable && nfo.cost > 0);
  };
  const bombardCandidate = u => !u.moved && !u.attacked && !u.suppressLevel && u.supplied !== false;

  // ---------- AI 驱动（步进 + 延迟动画；人类应手处自动暂停） ----------
  // 不只驱动 AI 的整个回合：人类回合内若 pendingOwnerSide 判定应手属于 AI
  // （人类攻击 AI 守军产生损步/撤退），也由这里自动结算，人类只处理自己的应手。
  function maybeKickAi() {
    const st = getState();
    // 联机时 AI 由服务端驱动，客户端绝不自行 aiStep
    if (isOnline || ui.aiRunning || ui.aiHalted || !shouldAiDrive(st)) return;
    ui.aiRunning = true;
    render();
    (async () => {
      let failed = false;
      let guard = 0;
      try {
        while (shouldAiDrive(st) && guard++ < 100) {
          const r = aiStep(st);
          render();
          // 关键：每次 aiStep 后立刻重判归属——若下一步应手已交还人类，
          // 不进入 await，人类面板不会在 AI 运行态下被遮住/误操作
          if (r !== 'continue' || !shouldAiDrive(st)) break;
          await new Promise(res => setTimeout(res, aiStepDelayMs));
        }
        if (guard >= 100 && shouldAiDrive(st)) {
          failed = true;
          st.log.push('【AI异常】步数超过上限，自动行动已暂停（可手动结算当前战斗）');
          flash('⚠ AI 步数超过上限，已暂停自动行动');
        }
      } catch (e) {
        failed = true;
        const msg = e && e.message ? e.message : String(e);
        st.log.push('【AI异常】' + msg);
        flash('⚠ AI 出错：' + msg);
      } finally {
        ui.aiRunning = false;
        if (failed) ui.aiHalted = true;
        render();
      }
    })();
  }

  // ---------- 渲染 ----------
  function computeHighlights() {
    const h = { reachableStoppable: null, retreatHexes: null, bombardHexes: null,
                attackTarget: ui.attackSel ? ui.attackSel.target : null,
                strongZoc: state.over ? null : strongZoc(state, other(state.activeSide)) };
    if (state.pending && state.pending.step === 'retreat') {
      const uid = currentRetreatUnitId(state);
      if (uid) h.retreatHexes = new Set(retreatStepOptions(state).map(x => hexKey(x)));
    } else if (!state.pending && ui.selectedId && state.phase === 'move') {
      const u = findUnit(state, ui.selectedId);
      if (u && !u.dead && u.side === state.activeSide && !u.moved) {
        const set = new Set();
        for (const [k, nfo] of computeReachable(state, u)) {
          if (nfo.stoppable && nfo.cost > 0) set.add(k);
        }
        h.reachableStoppable = set;
      }
    }
    if (ui.mode === 'bombard' && ui.selectedId) {
      const arty = findUnit(state, ui.selectedId);
      if (arty) h.bombardHexes = new Set(bombardTargets(state, arty).map(x => hexKey(x)));
    }
    return h;
  }
  function render() {
    draw(ctx, state, computeHighlights());
    panels.renderStatus();
    panels.renderActions();
    panels.renderInfo();
    panels.renderStackBar();
    panels.renderPending();
    panels.renderLog();
    maybeKickAi();
  }

  // ---------- 交互 ----------
  canvas.addEventListener('click', e => {
    if (!canTakeTurn()) return;   // 联机时非我方回合/非我方应手；AI 行动中同样拦截
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const hex = pointToHex((e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale,
                           state.width, state.height);
    (window.__clicks = window.__clicks || []).push({
      phase: state.phase, hex: hex ? hex.col + ',' + hex.row : null,
      ai: ui.aiRunning, pending: !!state.pending, mode: ui.mode, sel: ui.selectedId,
    });
    if (!hex) return;

    if (state.pending) { handlePendingClick(hex); render(); maybeKickAi(); return; }
    const occ = unitsAt(state, hex.col, hex.row);

    if (state.phase === 'move') {
      const own = occ.filter(u => u.side === state.activeSide && canOperate(u));
      const foreign = occ.find(u => u.side === state.activeSide && !canOperate(u));
      const sel = ui.selectedId ? findUnit(state, ui.selectedId) : null;
      const movableSel = sel && !sel.moved && sel.side === state.activeSide && canOperate(sel)
          && !(sel.col === hex.col && sel.row === hex.row);
      const canMove = movableSel && canStopAt(sel, hex);
      if (canMove) {
        if (isOnline) {
          sendCmd({ t: CMD.MOVE, unitId: sel.id, col: hex.col, row: hex.row });
          ui.mode = 'idle';
        } else {
          tryDo(() => moveUnit(state, sel.id, hex));
          ui.mode = 'idle';
          const now = unitsAt(state, hex.col, hex.row)
            .filter(x => x.side === state.activeSide && canOperate(x));
          ui.stackChoices = now.length >= 2 ? { col: hex.col, row: hex.row, ids: now.map(x => x.id) } : null;
        }
      } else {
        // 已选中单位却停不进这个友军格：明确提示原因（满格可穿不可停最容易误解为"移入失败"）
        if (movableSel && (own.length > 0 || foreign)) {
          const nfo = computeReachable(state, sel).get(hexKey(hex));
          if (!nfo) flash('⚠ 目标格不可达（移动力不足或被敌 ZOC/河流阻断）');
          else if (!nfo.stoppable) flash('⚠ 该格堆叠已满（上限3点），可以穿过但不能停留');
        }
        if (own.length >= 2) {
          // 多单位堆叠格：弹出选择栏
          ui.stackChoices = { col: hex.col, row: hex.row, ids: own.map(x => x.id) };
        } else if (own.length === 1) {
          ui.selectedId = own[0].id;
          ui.stackChoices = null;
          ui.mode = 'idle';
        } else {
          if (foreign) flash('⚠ 该单位属于' + foreign.commander + '（当前操作：' + ui.commander + '）');
          ui.selectedId = null;
          ui.stackChoices = null;
          ui.mode = 'idle';
        }
      }
    } else if (state.phase === 'combat') {
      const operable = x => x.side === state.activeSide && canOperate(x);
      if (ui.mode === 'bombard' && ui.selectedId) {
        const arty = findUnit(state, ui.selectedId);
        if (isOnline) sendCmd({ t: CMD.BOMBARD, unitId: arty.id, col: hex.col, row: hex.row });
        else tryDo(() => bombard(state, arty.id, hex));
        ui.mode = 'idle';
        ui.selectedId = null;
      } else if (occ.some(u => u.side !== state.activeSide)) {
        openAttackPanel(hex);
      } else {
        const mine = occ.find(operable);
        const foreign = occ.find(u => u.side === state.activeSide && !canOperate(u));
        if (foreign) flash('⚠ 该单位属于' + foreign.commander + '（当前操作：' + ui.commander + '）');
        else if (mine && mine.type === 'artillery' && bombardCandidate(mine)) {
          ui.selectedId = mine.id;
          ui.mode = 'bombard';
        } else if (mine) {
          ui.selectedId = mine.id;
          ui.mode = 'idle';
        } else {
          ui.selectedId = null;
          ui.mode = 'idle';
          ui.attackSel = null;
        }
      }
    }
    render();
    maybeKickAi();
  });

  function openAttackPanel(hex) {
    const elig = eligibleAttackers(state, hex);
    if (elig.length === 0) { flash('⚠ 没有可攻击该格的单位（需相邻且未攻击）'); return; }
    ui.selectedId = null;
    ui.mode = 'idle';
    ui.attackSel = { target: hex, included: new Set(elig.map(u => u.id)) };
  }

  function handlePendingClick(hex) {
    const p = state.pending;
    if (p.step === 'retreat' && currentRetreatUnitId(state)) {
      const legal = retreatStepOptions(state).some(x => x.col === hex.col && x.row === hex.row);
      if (legal) {
        if (isOnline) sendCmd({ t: CMD.RETREAT_STEP, col: hex.col, row: hex.row });
        else tryDo(() => retreatStep(state, hex));
      } else flash('⚠ 该格不能作为撤退路线（绿色高亮为可走的下一格）');
    }
  }

  // ---------- 双确认门槛（仅合作模式） ----------
  function onReady(cmd) {
    if (isOnline) { sendCmd({ t: CMD.READY, kind: state.phase }); return; }
    ui.ready[cmd] = !ui.ready[cmd];
    if (isCoop() && ui.ready.P1 && ui.ready.P2) {
      ui.ready = { P1: false, P2: false };
      tryDo(() => { endPhase(state); resetInteraction(); });
    }
  }

  // 本地直接执行 / 联机发指令
  function act(cmd, fn) {
    if (isOnline) { sendCmd(cmd); return; }
    fn();
  }

  // ---------- 事件委托 ----------
  function bindDelegation(sel) {
    document.querySelector(sel).addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const a = btn.dataset.action;
      const roomAction = a === 'backToSetup' || a === 'newGame';
      if (!roomAction && !canTakeTurn()) return;  // 非我方回合/应手、AI 行动中、同步中
      if (a === 'newGame' && !isOnline && ui.aiRunning) return;  // 本地 AI 行动中不打断
      if (isOnline && a === 'switchCommander') return;
      tryDo(() => {
        switch (a) {
          case 'readyMove': case 'readyCombat': onReady(btn.dataset.cmd); break;
          case 'switchCommander': ui.commander = ui.commander === 'P1' ? 'P2' : 'P1'; break;
          case 'backToSetup':
            if (isOnline && net) {
              clearRoomToken(net.code);
              try { net.close(); } catch { /* ignore */ }
              try { history.replaceState(null, '', '/'); } catch { /* ignore */ }
            }
            location.reload();
            break;
          case 'newGame': {
            if (isOnline) {
              sendCmd({ t: CMD.NEW_GAME });
              resetInteraction();
              break;
            }
            state = createGame(scenario, Math.floor(Math.random() * 1e9), setup);
            resetInteraction();
            ui.ready = { P1: false, P2: false };
            ui.aiHalted = false;
            break;
          }
          case 'pickStack': ui.selectedId = btn.dataset.unit; ui.mode = 'idle'; break;
          case 'confirmAttack': {
            const selA = ui.attackSel;
            if (!selA) break;
            act({
              t: CMD.DECLARE_ATTACK,
              attackerIds: [...selA.included],
              target: { col: selA.target.col, row: selA.target.row },
            }, () => declareAttack(state, [...selA.included], selA.target));
            ui.attackSel = null;
            break;
          }
          case 'cancelAttack': ui.attackSel = null; break;
          case 'assign':
            act({ t: CMD.ASSIGN, who: btn.dataset.who, unitId: btn.dataset.unit },
              () => assignStep(state, btn.dataset.who, btn.dataset.unit));
            break;
          case 'unassign':
            act({ t: CMD.UNASSIGN, who: btn.dataset.who, unitId: btn.dataset.unit },
              () => unassignStep(state, btn.dataset.who, btn.dataset.unit));
            break;
          case 'clearAssign':
            act({ t: CMD.CLEAR_ASSIGN, who: btn.dataset.who },
              () => clearAssignments(state, btn.dataset.who));
            break;
          case 'commit':
            act({ t: CMD.COMMIT, who: btn.dataset.who },
              () => commitAssign(state, btn.dataset.who));
            break;
          case 'retreatBegin':
            act({ t: CMD.BEGIN_RETREAT, unitId: btn.dataset.unit },
              () => beginRetreat(state, btn.dataset.unit));
            break;
          case 'toggleAdvance':
            act({ t: CMD.TOGGLE_ADVANCE, unitId: btn.dataset.unit },
              () => toggleAdvance(state, btn.dataset.unit));
            break;
          case 'commitAdvance':
            act({ t: CMD.COMMIT_ADVANCE }, () => commitAdvance(state));
            break;
          case 'skipAdvance':
            act({ t: CMD.SKIP_ADVANCE }, () => skipAdvance(state));
            break;
          case 'cancelBombard': ui.mode = 'idle'; ui.selectedId = null; break;
          case 'endMove': case 'endTurn':
            act({ t: CMD.END_PHASE }, () => { endPhase(state); resetInteraction(); });
            break;
        }
      });
      if (a === 'confirmAttack' || a === 'cancelAttack') ui.attackSel = null;
      render();
      maybeKickAi();
    });
  }
  bindDelegation('#actions');
  bindDelegation('#info');
  bindDelegation('#stackbar');
  bindDelegation('#pending');

  // 攻击面板的参战单位勾选
  els.info.addEventListener('click', e => {
    const chip = e.target.closest('[data-toggle]');
    if (!chip || !ui.attackSel) return;
    const id = chip.dataset.toggle;
    if (ui.attackSel.included.has(id)) ui.attackSel.included.delete(id);
    else ui.attackSel.included.add(id);
    render();
    maybeKickAi();
  });

  // ---------- 联机快照订阅 ----------
  if (isOnline && net) {
    net.onMessage(msg => {
      if (msg.t === 'snapshot') applySnapshot(msg);
      else if (msg.t === 'notice') {
        ui.netBusy = false;
        flash('⚠ ' + msg.message);
        render();
      }
    });
    net.onError(() => {
      if (ui.netOffline) return;
      ui.netOffline = true;
      flash('⚠ 联机连接中断，正在自动重连…');
      render();
    });
  }

  render();
  maybeKickAi();
  return { getState: () => state, getUi: () => ui };
}
