// 面板渲染：状态栏、行动按钮、信息卡、堆叠选择栏、战斗结算面板、战报。
// 只负责画 DOM 与展示，不做输入处理（输入事件在 app.js 的委托里统一分发）。
import { eligibleAttackers, previewAttack, currentRetreatUnitId,
         maxStepsFor } from '../engine/combat.js';
import { UNIT_STATS, MAX_STACK, unitAttack, unitDefense, unitLabel, findUnit,
         sideName } from '../engine/state.js';
import { ROWS } from '../engine/crt.js';
import { bombardTargets } from '../engine/artillery.js';
import { isAiSide } from '../engine/setup.js';
import { pendingOwnerSide } from '../ai/ai-player.js';

export function createPanels({ els, ui, getState, canOperate, canTakeTurn }) {
  const coop = () => { const g = getState(); return !!(g.meta && g.meta.mode === 'coop-pve'); };
  const aiTurn = () => { const g = getState(); return ui.aiRunning || isAiSide(g, g.activeSide); };
  // 合作模式下给单位名标注归属指挥官
  const tag = u => (coop() && u.commander && u.commander !== 'AI') ? `（${u.commander}）` : '';

  const online = () => !!ui.online;
  const mySide = () => ui.seat && ui.seat.side;
  const otherCommander = () => (ui.commander === 'P1' ? 'P2' : 'P1');
  const isHost = () => !online() || (ui.seat && ui.seat.id === 'P1');
  const pendingOwner = () => { const g = getState(); return g.pending ? pendingOwnerSide(g, g.pending) : null; };
  const waitingOpponent = () => {
    const g = getState();
    if (!online() || g.over) return false;
    if (ui.aiRunning || ui.netBusy) return false;
    if (g.pending) {
      if (isAiSide(g, pendingOwner())) return false;
      return pendingOwner() !== mySide();
    }
    if (isAiSide(g, g.activeSide)) return false;
    return g.activeSide !== mySide();
  };
  const waitText = () => {
    const g = getState();
    if (g.pending) return '等待对方结算…';
    return '等待对方行动…';
  };
  const opponentDisconnected = () => {
    const g = getState();
    if (!online() || g.over || !ui.roomSeats || !ui.seat) return false;
    const other = ui.roomSeats.find(s => s.id !== ui.seat.id);
    return !!(other && other.connected === false);
  };

  function renderStatus() {
    const g = getState();
    if (g.over) {
      let s = `<b class="over">🏁 战役结束：${sideName(g.over)}胜利</b><br>${g.turns}回合 · 渡河攻坚`;
      if (online() && ui.seat) s += `<br><span class="dim">联机 · 房间 ${ui.roomCode} · 你执 ${ui.seat.id}</span>`;
      els.status.innerHTML = s;
      return;
    }
    const phaseName = g.phase === 'move' ? '移动阶段' : '战斗阶段';
    const who = aiTurn()
      ? (g.pending && ui.aiRunning ? '<b>AI 正在结算…</b>' : '<b>AI 行动中…</b>')
      : `<b>${sideName(g.activeSide)}行动</b>${coop() && !online() ? `（当前操作：${ui.commander}）` : ''}`;
    let s = `<b>回合 ${g.turn}/${g.turns}</b>　${who}　${phaseName}　<span class="dim">种子 ${g.seedText}</span>`;
    if (online() && ui.seat) {
      s += `<br><span class="dim">联机 · 房间 ${ui.roomCode} · 你执 ${ui.seat.id}（${sideName(ui.seat.side)}）</span>`;
      if (ui.netBusy) s += `　<span class="warn">同步中…</span>`;
      if (ui.netOffline) s += `<br><span class="warn">连接中断，正在自动重连…</span>`;
      if (opponentDisconnected()) s += `<br><span class="warn">⚠ 对方已断线，等待重连…</span>`;
      if (waitingOpponent()) s += `<br><span class="warn">⏳ ${waitText()}</span>`;
    }
    if (coop() && !aiTurn() && !g.pending) {
      if (online()) {
        const me = ui.commander, other = otherCommander();
        if (!ui.ready[me] && ui.ready[other]) s += `<br><span class="warn">⏳ 队友已准备，等待你…</span>`;
        else if (ui.ready[me] && !ui.ready[other]) s += `<br><span class="warn">⏳ 你已准备，等待队友…</span>`;
      } else {
        const need = [];
        if (!ui.ready.P1) need.push('玩家1');
        if (!ui.ready.P2) need.push('玩家2');
        if (need.length) s += `<br><span class="warn">⏳ 等待 ${need.join('、')} 确认阶段结束</span>`;
      }
    }
    els.status.innerHTML = s;
  }

  function renderActions() {
    const g = getState();
    const common = (isHost() ? `<button data-action="newGame" class="ghost">新对局（新种子）</button>` : '') +
      `<button data-action="backToSetup" class="ghost">返回设置</button>`;
    if (g.over) { els.actions.innerHTML = common; return; }
    if (aiTurn()) { els.actions.innerHTML = `<span class="dim">AI 行动中，请稍候…</span>` + common; return; }
    if (online()) {
      if (ui.netBusy) { els.actions.innerHTML = `<span class="dim">同步中…</span>` + common; return; }
      if (waitingOpponent()) { els.actions.innerHTML = `<span class="dim">${waitText()}</span>` + common; return; }
      let html = '';
      if (coop()) {
        if (!g.pending) {
          const me = ui.commander, other = otherCommander();
          const label = ui.ready[me] ? '✓ ' : '';
          if (g.phase === 'move') html += `<button data-action="readyMove">${label}我准备好了（结束移动）</button>`;
          else if (g.phase === 'combat') html += `<button data-action="readyCombat">${label}我准备好了（结束战斗）</button>`;
          html += `<span class="dim">队友：${ui.ready[other] ? '已准备' : '未准备'}</span>`;
        }
      } else {
        if (g.phase === 'move' && !g.pending) html += `<button data-action="endMove">进入战斗阶段</button>`;
        else if (g.phase === 'combat' && !g.pending) html += `<button data-action="endTurn">结束回合</button>`;
        if (g.pending) html += `<span class="dim">结算中…</span>`;
      }
      els.actions.innerHTML = html + common;
      return;
    }
    let html = '';
    if (coop()) {
      if (g.phase === 'move' && !g.pending) {
        html += `<button data-action="readyMove" data-cmd="P1">${ui.ready.P1 ? '✓ ' : ''}玩家1 移动结束</button>` +
          `<button data-action="readyMove" data-cmd="P2">${ui.ready.P2 ? '✓ ' : ''}玩家2 移动结束</button>`;
      } else if (g.phase === 'combat' && !g.pending) {
        html += `<button data-action="readyCombat" data-cmd="P1">${ui.ready.P1 ? '✓ ' : ''}玩家1 战斗结束</button>` +
          `<button data-action="readyCombat" data-cmd="P2">${ui.ready.P2 ? '✓ ' : ''}玩家2 战斗结束</button>`;
      }
      html += `<button data-action="switchCommander" class="ghost">切换操作（当前：${ui.commander}）</button>`;
    } else {
      if (g.phase === 'move' && !g.pending) html += `<button data-action="endMove">进入战斗阶段</button>`;
      else if (g.phase === 'combat' && !g.pending) html += `<button data-action="endTurn">结束回合</button>`;
    }
    els.actions.innerHTML = html + common;
  }

  function renderInfo() {
    const g = getState();
    let html = '';
    const u = ui.selectedId ? findUnit(g, ui.selectedId) : null;
    if (u && !u.dead) {
      const st = UNIT_STATS[u.type];
      html += `<div class="card"><b>${unitLabel(u)}</b>${tag(u)}<br>` +
        `攻 ${u.type === 'artillery' ? '—' : unitAttack(u)} / 防 ${unitDefense(u)}　移动力 ${st.mp / 2}<br>` +
        `状态：${u.moved ? '已移动 ' : ''}${u.attacked ? '已攻击/射击 ' : ''}` +
        `${u.suppressLevel ? `被压制−${u.suppressLevel} ` : ''}${u.supplied === false ? '<b class="warn">未补给</b>' : '补给正常'}</div>`;
    }
    if (ui.attackSel) {
      const pv = previewAttack(g, [...ui.attackSel.included], ui.attackSel.target);
      const shifts = [];
      if (pv.terrainShift) shifts.push(`地形${pv.terrainShift}`);
      if (pv.riverShift) shifts.push(`跨河${pv.riverShift}${pv.exempt ? '（迂回豁免）' : ''}`);
      const noRow = pv.finalRow === null;
      const oddsHtml = noRow
        ? `<span class="warn">${pv.atks.length === 0 ? '未选择参战单位' : '目标格没有守军'}</span>`
        : `比值 ${pv.ratioText}${shifts.length ? '　' + shifts.join('，') : ''}<br>` +
          `基础行 ${ROWS[pv.baseRow].name} → 结算行 <b>${ROWS[pv.finalRow].name}</b><br>` +
          `<span class="dim">${pv.odds}</span>`;
      html += `<div class="card"><b>攻击预览 → (${ui.attackSel.target.col},${ui.attackSel.target.row})</b><br>` +
        `守军：${pv.defenders.map(x => unitLabel(x) + tag(x)).join('、')}<br>` + oddsHtml + `<br>`;
      if (!noRow && coop()) {
        const borrow = [...ui.attackSel.included]
          .map(id => findUnit(g, id))
          .filter(x => x && x.commander !== ui.commander).length;
        if (borrow) html += `<span class="warn">本次冲击将借用其他指挥官的单位 ×${borrow}</span><br>`;
      }
      html += `<div class="chips" style="margin-top:6px">参战单位（点击勾选/取消）：`;
      for (const au of eligibleAttackers(g, ui.attackSel.target)) {
        const on = ui.attackSel.included.has(au.id);
        html += `<button class="chip ${on ? 'on' : ''}" data-toggle="${au.id}">${unitLabel(au)}${tag(au)} 攻${unitAttack(au)}</button>`;
      }
      html += `</div><button data-action="confirmAttack" ${noRow ? 'disabled' : ''}>发起攻击</button> ` +
        `<button data-action="cancelAttack" class="ghost">取消</button></div>`;
    }
    if (ui.mode === 'bombard' && ui.selectedId) {
      html += `<div class="card">炮击模式：点击橙色高亮格（射程2–6）压制目标，<button data-action="cancelBombard">取消</button></div>`;
    }
    els.info.innerHTML = html || '<span class="dim">（点击单位查看详情）</span>';
  }

  function renderStackBar() {
    const g = getState();
    const sc = ui.stackChoices;
    if (!sc || g.over || g.pending || g.phase !== 'move' || aiTurn() || !canTakeTurn()) {
      els.stackbar.innerHTML = '';
      return;
    }
    const units = sc.ids.map(id => findUnit(g, id))
      .filter(x => x && !x.dead && x.side === g.activeSide && canOperate(x)
        && x.col === sc.col && x.row === sc.row);
    if (units.length < 2) { els.stackbar.innerHTML = ''; return; }
    let html = `<b>堆叠格 (${sc.col},${sc.row})：选择要操作的单位</b><div class="chips">`;
    for (const u of units) {
      const on = ui.selectedId === u.id;
      html += `<button class="chip ${on ? 'on' : ''}" data-action="pickStack" data-unit="${u.id}">${unitLabel(u)}${tag(u)}</button>`;
    }
    html += `</div>`;
    els.stackbar.innerHTML = html;
  }

  function renderPending() {
    const g = getState();
    const p = g.pending;
    if (!p) { els.pending.innerHTML = ''; return; }
    // 应手属于 AI 时面板只做只读提示，绝不让人类接管 AI 的步损/撤退/挺进
    if (ui.aiRunning) {
      const stepName = p.step === 'assign' ? '步损分配' : p.step === 'retreat' ? '撤退' : p.step === 'advance' ? '挺进' : p.step;
      els.pending.innerHTML = `<div class="pending"><b>AI 正在结算（${stepName}）…</b></div>`;
      return;
    }
    // 联机：应手不是我的 → 只读，等待对方/AI 结算
    if (online() && p && pendingOwner() !== mySide()) {
      const stepName = p.step === 'assign' ? '步损分配' : p.step === 'retreat' ? '撤退' : p.step === 'advance' ? '挺进' : p.step;
      const who = isAiSide(g, pendingOwner()) ? 'AI' : '对方';
      els.pending.innerHTML = `<div class="pending"><b>等待${who}结算（${stepName}）…</b></div>`;
      return;
    }
    let html = `<div class="pending">`;
    if (p.step === 'assign') {
      const who = p.needAttackerSteps > 0 ? 'attacker' : 'defender';
      const need = p.needAttackerSteps > 0 ? p.needAttackerSteps : p.needDefenderSteps;
      const sum = Object.values(p.assign[who]).reduce((a, b) => a + b, 0);
      const ids = who === 'attacker' ? p.attackerIds : p.defenderIds;
      html += `<b>${who === 'attacker' ? '攻方' : '守方'}玩家：分配步损（需 ${need} 步，已分 ${sum}）</b><div class="chips">`;
      for (const id of ids) {
        const u = findUnit(g, id);
        if (!u || u.dead) continue;
        const n = p.assign[who][id] || 0;
        html += `<span class="chip">` +
          `<button data-action="unassign" data-who="${who}" data-unit="${id}">−</button>` +
          ` ${unitLabel(u)}${tag(u)} [${n}/${maxStepsFor(u)}] ` +
          `<button data-action="assign" data-who="${who}" data-unit="${id}">＋</button></span>`;
      }
      html += `</div><button data-action="commit" data-who="${who}" ${sum !== need ? 'disabled' : ''}>确认分配</button> ` +
        `<button data-action="clearAssign" data-who="${who}" class="ghost">清空</button>`;
    } else if (p.step === 'retreat') {
      const uid = currentRetreatUnitId(g);
      const u = uid ? findUnit(g, uid) : null;
      if (u) {
        html += `<b>守方玩家：${unitLabel(u)}${tag(u)} 撤退（结果 ${p.result}，需退 ${p.retreatHexes} 格` +
          `${p.retreatPushes ? `，因终点超出堆叠已加退 ${p.retreatPushes} 格` : ''}，余 ${p.retreatQueue.length + 1} 个单位）</b><br>` +
          `点击地图<b>绿色高亮格</b>走下一格（不可进敌强ZOC、敌占格，不可跨大河，不可走回头路；终点超出堆叠会损1步并再退1格）`;
      } else {
        const queued = p.retreatQueue.map(id => findUnit(g, id)).filter(x => x && !x.dead);
        html += `<b>守方玩家：选择要撤退的单位（结果 ${p.result}，需退 ${p.retreatHexes} 格，共 ${queued.length} 个单位）</b><div class="chips">`;
        for (const q of queued) {
          html += `<button class="chip" data-action="retreatBegin" data-unit="${q.id}">${unitLabel(q)}${tag(q)}</button>`;
        }
        html += `</div><span class="dim">选定后在地图上点绿色高亮格逐格撤退</span>`;
      }
    } else if (p.step === 'advance') {
      const pickedPts = p.advancePick.reduce((s2, id) => { const x = findUnit(g, id); return s2 + (x ? UNIT_STATS[x.type].stack : 0); }, 0);
      html += `<b>攻方玩家：勾选要挺进的单位（进入 (${p.target.col},${p.target.row})，合计不超 ${MAX_STACK} 点，已选 ${pickedPts} 点）</b><div class="chips">`;
      for (const id of p.advanceCandidates) {
        const x = findUnit(g, id);
        if (x && !x.dead) {
          const on = p.advancePick.includes(id);
          html += `<button class="chip ${on ? 'on' : ''}" data-action="toggleAdvance" data-unit="${id}">${unitLabel(x)}${tag(x)}（${UNIT_STATS[x.type].stack}点）</button>`;
        }
      }
      html += `</div><button data-action="commitAdvance" ${p.advancePick.length === 0 ? 'disabled' : ''}>确认挺进</button> ` +
        `<button data-action="skipAdvance" class="ghost">不挺进</button>`;
    }
    html += `</div>`;
    els.pending.innerHTML = html;
  }

  function renderLog() {
    const g = getState();
    const lines = g.log.slice(-80);
    els.log.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    els.log.scrollTop = els.log.scrollHeight;
  }

  return { renderStatus, renderActions, renderInfo, renderStackBar, renderPending, renderLog };
}
