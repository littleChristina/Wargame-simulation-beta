// 界面控制器：热座双人。回合流程严格走引擎阶段；战斗结算按待办逐步引导。
import { CANVAS_W, CANVAS_H, draw, pointToHex } from './renderer.js';
import { hexKey, unitsAt, findUnit, unitLabel, UNIT_STATS, MAX_STACK, unitAttack, unitDefense,
         other, sideName } from '../engine/state.js';
import { computeReachable } from '../engine/move.js';
import { strongZoc } from '../engine/zoc.js';
import { moveUnit, endPhase, createGame } from '../engine/engine.js';
import { eligibleAttackers, previewAttack, declareAttack, assignStep, unassignStep,
         clearAssignments, commitAssign, assignedSum, maxStepsFor,
         currentRetreatUnitId, retreatStepOptions, retreatStep, beginRetreat,
         toggleAdvance, commitAdvance, skipAdvance } from '../engine/combat.js';
import { canBombard, bombardTargets, bombard } from '../engine/artillery.js';
import { ROWS, RESULT_INFO } from '../engine/crt.js';

export function initApp(canvas, scenario, initialSeed) {
  const ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;

  let state = createGame(scenario, initialSeed);
  const ui = { selectedId: null, mode: 'idle', attackSel: null, flashMsg: '' };

  const $ = sel => document.querySelector(sel);
  const panels = { status: $('#status'), actions: $('#actions'), info: $('#info'), stackbar: $('#stackbar'),
                   pending: $('#pending'), log: $('#log'), flash: $('#flash') };

  function flash(msg) {
    ui.flashMsg = msg;
    panels.flash.textContent = msg;
    setTimeout(() => { if (ui.flashMsg === msg) { ui.flashMsg = ''; panels.flash.textContent = ''; } }, 3000);
  }

  function tryDo(fn) {
    try { fn(); } catch (e) { flash('⚠ ' + e.message); }
  }

  // ---------- 交互 ----------
  canvas.addEventListener('click', e => {
    if (state.over) return;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const hex = pointToHex((e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale,
                           state.width, state.height);
    if (!hex) return;

    if (state.pending) {
      handlePendingClick(hex);
      render();
      return;
    }
    const occ = unitsAt(state, hex.col, hex.row);

    if (state.phase === 'move') {
      const own = occ.filter(u => u.side === state.activeSide);
      const sel = ui.selectedId ? findUnit(state, ui.selectedId) : null;
      // 已选中的单位且该格是它的合法停留格 → 移入（可并入友军堆叠）
      const canMove = sel && !sel.moved && sel.side === state.activeSide
          && !(sel.col === hex.col && sel.row === hex.row)
          && canStopAt(state, sel, hex);
      if (canMove) {
        tryDo(() => moveUnit(state, sel.id, hex));
        ui.mode = 'idle';
        const now = unitsAt(state, hex.col, hex.row).filter(x => x.side === state.activeSide);
        ui.stackChoices = now.length >= 2 ? { col: hex.col, row: hex.row, ids: now.map(x => x.id) } : null;
      } else if (own.length >= 2) {
        // 多单位堆叠格：弹出选择栏，让玩家挑要操作的单位
        ui.stackChoices = { col: hex.col, row: hex.row, ids: own.map(x => x.id) };
      } else if (own.length === 1) {
        ui.selectedId = own[0].id;
        ui.stackChoices = null;
        ui.mode = 'idle';
      } else {
        ui.selectedId = null;
        ui.stackChoices = null;
        ui.mode = 'idle';
      }
    } else if (state.phase === 'combat') {
      if (ui.mode === 'bombard' && ui.selectedId) {
        const arty = findUnit(state, ui.selectedId);
        tryDo(() => bombard(state, arty.id, hex));
        ui.mode = 'idle';
        ui.selectedId = null;
      } else if (occ.some(u => u.side !== state.activeSide)) {
        openAttackPanel(hex);
      } else {
        const mine = occ.find(u => u.side === state.activeSide);
        if (mine && mine.type === 'artillery' && bombardCandidate(mine)) {
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
  });

  function bombardCandidate(u) {
    return !u.moved && !u.attacked && !u.suppressLevel && u.supplied !== false;
  }

  // 已选单位能否停入该格（可达且未超堆叠）
  function canStopAt(state, unit, hex) {
    const info = computeReachable(state, unit).get(hexKey(hex));
    return !!(info && info.stoppable && info.cost > 0);
  }

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
      const legal = retreatStepOptions(state).some(h => h.col === hex.col && h.row === hex.row);
      if (legal) tryDo(() => retreatStep(state, hex));
      else flash('⚠ 该格不能作为撤退路线（绿色高亮为可走的下一格）');
    }
  }

  // ---------- 面板 ----------
  function render() {
    draw(ctx, state, computeHighlights());
    renderStatus();
    renderActions();
    renderInfo();
    renderStackBar();
    renderPending();
    renderLog();
  }

  function computeHighlights() {
    const h = { reachableStoppable: null, retreatHexes: null, bombardHexes: null,
                attackTarget: ui.attackSel ? ui.attackSel.target : null,
                strongZoc: state.over ? null : strongZoc(state, other(state.activeSide)) };
    if (state.pending && state.pending.step === 'retreat') {
      if (currentRetreatUnitId(state)) h.retreatHexes = new Set(retreatStepOptions(state).map(hexKey));
    } else if (!state.pending && ui.selectedId && state.phase === 'move') {
      const u = findUnit(state, ui.selectedId);
      if (u && !u.dead && u.side === state.activeSide && !u.moved) {
        const nodes = computeReachable(state, u);
        const set = new Set();
        for (const [k, info] of nodes) if (info.stoppable && info.cost > 0) set.add(k);
        h.reachableStoppable = set;
      }
    }
    if (ui.mode === 'bombard' && ui.selectedId) {
      const arty = findUnit(state, ui.selectedId);
      if (arty) h.bombardHexes = new Set(bombardTargets(state, arty).map(hexKey));
    }
    return h;
  }

  function renderStackBar() {
    const sc = ui.stackChoices;
    if (!sc || state.pending || state.phase !== 'move') { panels.stackbar.innerHTML = ''; return; }
    const units = sc.ids.map(id => findUnit(state, id))
      .filter(u => u && !u.dead && u.col === sc.col && u.row === sc.row);
    if (units.length < 2) { panels.stackbar.innerHTML = ''; return; }
    let html = `<b>堆叠格 (${sc.col},${sc.row})：选择要操作的单位</b><div class="chips">`;
    for (const u of units) {
      const on = ui.selectedId === u.id;
      html += `<button class="chip ${on ? 'on' : ''}" data-action="pickStack" data-unit="${u.id}">${unitLabel(u)}</button>`;
    }
    html += `</div>`;
    panels.stackbar.innerHTML = html;
  }

  function renderStatus() {
    const phaseName = state.phase === 'move' ? '移动阶段' : '战斗阶段';
    let s = `<b>回合 ${state.turn}/${state.turns}</b>　${sideName(state.activeSide)}行动　${phaseName}　<span class="dim">种子 ${state.seedText}</span>`;
    if (state.over) {
      s = `<b class="over">🏁 战役结束：${sideName(state.over)}胜利</b><br>${state.turns}回合 · 渡河攻坚`;
    }
    panels.status.innerHTML = s;
  }

  function renderActions() {
    let html = '';
    if (!state.over) {
      if (state.phase === 'move' && !state.pending) {
        html += `<button data-action="endMove">进入战斗阶段</button>`;
      } else if (state.phase === 'combat' && !state.pending) {
        html += `<button data-action="endTurn">结束回合</button>`;
      }
    }
    html += `<button data-action="newGame" class="ghost">新对局（新种子）</button>`;
    panels.actions.innerHTML = html;
  }

  function renderInfo() {
    let html = '';
    const u = ui.selectedId ? findUnit(state, ui.selectedId) : null;
    if (u && !u.dead) {
      const st = UNIT_STATS[u.type];
      html += `<div class="card"><b>${unitLabel(u)}</b>（${sideName(u.side)}）<br>` +
        `攻 ${u.type === 'artillery' ? '—' : unitAttack(u)} / 防 ${unitDefense(u)}　移动力 ${st.mp / 2}<br>` +
        `状态：${u.moved ? '已移动 ' : ''}${u.attacked ? '已攻击/射击 ' : ''}` +
        `${u.suppressLevel ? `被压制−${u.suppressLevel} ` : ''}${u.supplied === false ? '<b class="warn">未补给</b>' : '补给正常'}</div>`;
    }
    if (ui.attackSel) {
      const pv = previewAttack(state, [...ui.attackSel.included], ui.attackSel.target);
      const shifts = [];
      if (pv.terrainShift) shifts.push(`地形${pv.terrainShift}`);
      if (pv.riverShift) shifts.push(`跨河${pv.riverShift}${pv.exempt ? '（迂回豁免）' : ''}`);
      // 未选参战单位（或目标格无守军）时引擎不取行：只提示，不显示比值
      const noRow = pv.finalRow === null;
      const oddsHtml = noRow
        ? `<span class="warn">${pv.atks.length === 0 ? '未选择参战单位' : '目标格没有守军'}</span>`
        : `比值 ${pv.ratioText}${shifts.length ? '　' + shifts.join('，') : ''}<br>` +
          `基础行 ${ROWS[pv.baseRow].name} → 结算行 <b>${ROWS[pv.finalRow].name}</b><br>` +
          `<span class="dim">${pv.odds}</span>`;
      html += `<div class="card"><b>攻击预览 → (${ui.attackSel.target.col},${ui.attackSel.target.row})</b><br>` +
        `守军：${pv.defenders.map(unitLabel).join('、')}<br>` + oddsHtml + `<br>` +
        `<div class="chips" style="margin-top:6px">参战单位（点击勾选/取消）：`;
      for (const au of eligibleAttackers(state, ui.attackSel.target)) {
        const on = ui.attackSel.included.has(au.id);
        html += `<button class="chip ${on ? 'on' : ''}" data-toggle="${au.id}">${unitLabel(au)} 攻${unitAttack(au)}</button>`;
      }
      html += `</div><button data-action="confirmAttack"${noRow ? ' disabled' : ''}>发起攻击</button> ` +
        `<button data-action="cancelAttack" class="ghost">取消</button></div>`;
    }
    if (ui.mode === 'bombard' && ui.selectedId) {
      html += `<div class="card">炮击模式：点击橙色高亮格（射程2–6）压制目标，<button data-action="cancelBombard">取消</button></div>`;
    }
    panels.info.innerHTML = html || '<span class="dim">（点击单位查看详情）</span>';
  }

  function renderPending() {
    const p = state.pending;
    if (!p) { panels.pending.innerHTML = ''; return; }
    let html = `<div class="pending">`;
    if (p.step === 'assign') {
      const who = p.needAttackerSteps > 0 ? 'attacker' : 'defender';
      const need = p.needAttackerSteps > 0 ? p.needAttackerSteps : p.needDefenderSteps;
      const sum = assignedSum(p, who);
      const ids = who === 'attacker' ? p.attackerIds : p.defenderIds;
      html += `<b>${who === 'attacker' ? '攻方' : '守方'}玩家：分配步损（需 ${need} 步，已分 ${sum}）</b><div class="chips">`;
      for (const id of ids) {
        const u = findUnit(state, id);
        if (!u || u.dead) continue;
        const n = p.assign[who][id] || 0;
        html += `<span class="chip">` +
          `<button data-action="unassign" data-who="${who}" data-unit="${id}">−</button>` +
          ` ${unitLabel(u)} [${n}/${maxStepsFor(u)}] ` +
          `<button data-action="assign" data-who="${who}" data-unit="${id}">＋</button></span>`;
      }
      html += `</div><button data-action="commit" data-who="${who}" ${sum !== need ? 'disabled' : ''}>确认分配</button> ` +
        `<button data-action="clearAssign" data-who="${who}" class="ghost">清空</button>`;
    } else if (p.step === 'retreat') {
      const uid = currentRetreatUnitId(state);
      if (uid) {
        const u = findUnit(state, uid);
        html += `<b>守方玩家：${unitLabel(u)} 撤退（结果 ${p.result}，需退 ${p.retreatHexes} 格` +
          `${p.retreatPushes ? `，因终点超出堆叠已加退 ${p.retreatPushes} 格` : ''}）</b><br>` +
          `还需退 ${p.retreatRemaining} 格：点击地图<b>绿色高亮格</b>走下一格` +
          `（不可进敌强ZOC、敌占格，不可跨大河，不可走回头路；终点超出堆叠会损1步并再退1格）`;
      } else {
        html += `<b>守方玩家：选择下一个撤退的单位（每个单位退 ${p.retreatHexes} 格，尚余 ${p.retreatQueue.length} 个）</b><div class="chips">`;
        for (const id of p.retreatQueue) {
          const u = findUnit(state, id);
          if (u && !u.dead) html += `<button class="chip" data-action="retreatBegin" data-unit="${id}">${unitLabel(u)}</button>`;
        }
        html += `</div>`;
      }
    } else if (p.step === 'advance') {
      const pickedPts = p.advancePick.reduce((s, id) => { const u = findUnit(state, id); return s + (u ? UNIT_STATS[u.type].stack : 0); }, 0);
      html += `<b>攻方玩家：勾选要挺进的单位（进入 (${p.target.col},${p.target.row})，合计不超 ${MAX_STACK} 点，已选 ${pickedPts} 点）</b><div class="chips">`;
      for (const id of p.advanceCandidates) {
        const u = findUnit(state, id);
        if (u && !u.dead) {
          const on = p.advancePick.includes(id);
          html += `<button class="chip ${on ? 'on' : ''}" data-action="toggleAdvance" data-unit="${id}">${unitLabel(u)}（${UNIT_STATS[u.type].stack}点）</button>`;
        }
      }
      html += `</div><button data-action="commitAdvance" ${p.advancePick.length === 0 ? 'disabled' : ''}>确认挺进</button> ` +
        `<button data-action="skipAdvance" class="ghost">不挺进</button>`;
    }
    html += `</div>`;
    panels.pending.innerHTML = html;
  }

  function renderLog() {
    const lines = state.log.slice(-80);
    panels.log.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    panels.log.scrollTop = panels.log.scrollHeight;
  }

  // ---------- 事件委托 ----------
  function bindDelegation(sel) {
    $(sel).addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const a = btn.dataset.action;
      tryDo(() => {
        switch (a) {
          case 'endMove': endPhase(state); break;
          case 'endTurn': endPhase(state); break;
          case 'newGame': {
            const seed = Math.floor(Math.random() * 1e9);
            state = createGame(scenario, seed);
            ui.selectedId = null; ui.mode = 'idle'; ui.attackSel = null;
            break;
          }
          case 'assign': assignStep(state, btn.dataset.who, btn.dataset.unit); break;
          case 'unassign': unassignStep(state, btn.dataset.who, btn.dataset.unit); break;
          case 'clearAssign': clearAssignments(state, btn.dataset.who); break;
          case 'commit': commitAssign(state, btn.dataset.who); break;
          case 'retreatBegin': beginRetreat(state, btn.dataset.unit); break;
          case 'pickStack': ui.selectedId = btn.dataset.unit; ui.mode = 'idle'; break;
          case 'toggleAdvance': toggleAdvance(state, btn.dataset.unit); break;
          case 'commitAdvance': commitAdvance(state); break;
          case 'skipAdvance': skipAdvance(state); break;
          case 'cancelBombard': ui.mode = 'idle'; ui.selectedId = null; break;
          case 'confirmAttack': {
            const sel = ui.attackSel;
            if (!sel) break;
            declareAttack(state, [...sel.included], sel.target);
            ui.attackSel = null;
            break;
          }
          case 'cancelAttack': ui.attackSel = null; break;
        }
      });
      if (a === 'confirmAttack' || a === 'cancelAttack') ui.attackSel = null;
      render();
    });
  }
  bindDelegation('#actions');
  bindDelegation('#info');
  bindDelegation('#stackbar');
  bindDelegation('#pending');

  // 攻击面板的参战单位勾选（在 info 面板内）
  panels.info.addEventListener('click', e => {
    const chip = e.target.closest('[data-toggle]');
    if (!chip) return;
    const id = chip.dataset.toggle;
    if (ui.attackSel.included.has(id)) ui.attackSel.included.delete(id);
    else ui.attackSel.included.add(id);
    render();
  });

  render();
  return { getState: () => state };
}
