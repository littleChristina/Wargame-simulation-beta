// 开局设置屏：对局模式 → 阵营 → 双人兵力分配表（均分预设 + 手动勾选）。
// 确认后回调 onStart(setup, seed) 开始本地对局；传入 onOnline 时额外提供局域网建房/加入。
// setup 结构见 engine/setup.js。
import { MODE } from '../engine/setup.js';
import { UNIT_STATS } from '../engine/state.js';
import { isValidRoomCode } from '../net/protocol.js';

const TYPE_NAME = { infantry: '步兵', armor: '装甲', artillery: '炮兵' };
const stackOf = type => UNIT_STATS[type].stack;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function showSetupScreen(root, scenario, onStart, opts = {}) {
  const { onOnline = null } = opts;
  const initialCode = opts.initialCode && isValidRoomCode(String(opts.initialCode).toUpperCase())
    ? String(opts.initialCode).toUpperCase() : '';
  const ui = {
    mode: null, faction: null, split: null,
    seed: '20261124', joinCode: initialCode, lanMsg: '',
  };
  const seedDefault = 20261124;

  // 单位显示名：按阵营+类型编号（与引擎建局时的编号规则一致）
  const named = (() => {
    const counters = {};
    return scenario.units.map(u => {
      const k = `${u.side}-${u.type}`;
      counters[k] = (counters[k] || 0) + 1;
      return { ...u, i: scenario.units.indexOf(u), name: `${TYPE_NAME[u.type]}${counters[k]}` };
    });
  })();

  // 均分：按堆叠点降序贪心，尽量让 P1/P2 点数持平
  function evenSplit() {
    const pts = scenario.units.map(u => (u.side === ui.faction) ? stackOf(u.type) : -1);
    const order = pts.map((p, i) => ({ p, i })).filter(x => x.p >= 0).sort((x, y) => y.p - x.p || x.i - y.i);
    const res = new Array(pts.length).fill('P2');
    const t = { P1: 0, P2: 0 };
    let toggle = 'P1';
    for (const { p, i } of order) {
      let target;
      if (t.P1 === t.P2) target = toggle; else target = t.P1 < t.P2 ? 'P1' : 'P2';
      res[i] = target;
      t[target] += p;
      toggle = toggle === 'P1' ? 'P2' : 'P1';
    }
    return res;
  }

  function humanSplitCounts() {
    const c = { P1: 0, P2: 0 };
    if (!ui.split || !ui.faction) return c;
    scenario.units.forEach((u, i) => {
      if (u.side !== ui.faction) return;
      c[ui.split[i] === 'P1' ? 'P1' : 'P2'] += 1;
    });
    return c;
  }

  function canOnlineCreate() {
    if (!onOnline) return false;
    if (ui.mode !== MODE.PVP && ui.mode !== MODE.COOP_PVE) return false;
    if (!ui.faction) return false;
    if (ui.mode === MODE.COOP_PVE) {
      const c = humanSplitCounts();
      if (!c.P1 || !c.P2) return false;
    }
    return true;
  }

  function readSeed() {
    const el = document.getElementById('seedInput');
    const v = el ? String(el.value).trim() : ui.seed;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : seedDefault;
  }

  function render() {
    let html = `<div class="setup-card"><h2>兵棋《渡口》— 开局设置 <span class="dim">v0.3 · 局域网联机</span></h2>`;
    html += `<div class="row"><span class="lbl">对局模式</span>` +
      `<button class="chip ${ui.mode === MODE.SOLO_PVE ? 'on' : ''}" data-a="mode" data-v="${MODE.SOLO_PVE}">单人 PVE</button>` +
      `<button class="chip ${ui.mode === MODE.COOP_PVE ? 'on' : ''}" data-a="mode" data-v="${MODE.COOP_PVE}">双人合作 PVE</button>` +
      `<button class="chip ${ui.mode === MODE.PVP ? 'on' : ''}" data-a="mode" data-v="${MODE.PVP}">热座 PvP</button></div>`;
    if (ui.mode) {
      const facs = ui.mode === MODE.PVP
        ? [['attacker', '玩家1 执攻方'], ['defender', '玩家1 执守方']]
        : ui.mode === MODE.COOP_PVE
          ? [['attacker', '人类方执攻方（AI 守）'], ['defender', '人类方执守方（AI 攻）']]
          : [['attacker', '人类执攻方（AI 执守方）'], ['defender', '人类执守方（AI 执攻方）']];
      html += `<div class="row"><span class="lbl">阵营</span>` +
        facs.map(([s, t]) => `<button class="chip ${ui.faction === s ? 'on' : ''}" data-a="faction" data-v="${s}">${t}</button>`).join('') + `</div>`;
    }
    if (ui.mode === MODE.COOP_PVE && ui.faction && ui.split) {
      const mine = named.filter(u => u.side === ui.faction);
      const c = humanSplitCounts();
      const pts = { P1: 0, P2: 0 };
      for (const u of mine) pts[ui.split[u.i]] += stackOf(u.type);
      html += `<div class="row"><span class="lbl">兵力分配</span>` +
        `<button class="chip" data-a="even">均分预设</button>` +
        `<span class="dim">勾选 = 玩家1，未勾 = 玩家2（整局有效）　P1：${c.P1}个单位/${pts.P1}点　P2：${c.P2}个单位/${pts.P2}点</span></div>`;
      html += `<table class="alloctable"><tr><th>归玩家1</th><th>单位</th><th>类型</th><th>位置</th><th>堆叠点</th></tr>`;
      for (const u of mine) {
        html += `<tr><td><input type="checkbox" data-i="${u.i}" ${ui.split[u.i] === 'P1' ? 'checked' : ''}></td>` +
          `<td>${u.name}</td><td>${TYPE_NAME[u.type]}</td><td>(${u.col},${u.row})</td><td>${stackOf(u.type)}</td></tr>`;
      }
      html += `</table>`;
    }
    html += `<div class="row"><span class="lbl">种子</span><input id="seedInput" value="${esc(ui.seed)}" size="10"></div>`;
    if (onOnline) {
      const disabled = canOnlineCreate() ? '' : 'disabled';
      html += `<div class="row"><span class="lbl">局域网联机</span>` +
        `<button class="chip" data-a="lanCreate" ${disabled}>创建房间</button>` +
        `<input id="roomCode" value="${esc(ui.joinCode)}" size="6" maxlength="4" placeholder="房间号">` +
        `<button class="chip" data-a="lanJoin">加入房间</button>` +
        `<span class="dim">点「创建房间」后会生成<b>邀请链接</b>；朋友在同一局域网打开链接，或输入 4 位房间号加入。</span></div>`;
      if (ui.mode === MODE.SOLO_PVE) {
        html += `<div class="row"><span class="warn">联机仅支持热座 PvP / 双人合作 PVE，请先切换模式。</span></div>`;
      }
      if (ui.lanMsg) html += `<div class="row"><span class="warn">${esc(ui.lanMsg)}</span></div>`;
    }
    html += `<button data-a="start" class="primary" ${!ui.mode || !ui.faction ? 'disabled' : ''}>开 战（本地）</button>`;
    html += `<div class="dim" style="margin-top:10px">规则速览：2d6结果表 · 步进翻面 · 双层ZOC · 炮兵压制 · 补给放血 · 堆叠3点 · 撤退逐格</div></div>`;
    root.innerHTML = html;
  }

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-a], [data-m], [data-f]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'mode') { ui.mode = b.dataset.v; ui.faction = null; ui.split = null; ui.lanMsg = ''; }
    else if (a === 'faction') {
      ui.faction = b.dataset.v;
      ui.split = evenSplit();   // 默认均分，合作双方各有一半兵力
      ui.lanMsg = '';
    } else if (a === 'even') {
      ui.split = evenSplit();
    } else if (a === 'lanCreate') {
      if (!canOnlineCreate()) {
        ui.lanMsg = '请先选择 PvP / 双人合作、阵营，并为两位玩家分配兵力';
        render();
        return;
      }
      onOnline({
        kind: 'create',
        setup: { mode: ui.mode, p1Side: ui.faction, split: ui.mode === MODE.COOP_PVE ? ui.split : null },
        seed: readSeed(),
      });
      return;
    } else if (a === 'lanJoin') {
      const el = document.getElementById('roomCode');
      const code = String(el ? el.value : ui.joinCode).trim().toUpperCase();
      ui.joinCode = code;
      if (!isValidRoomCode(code)) {
        ui.lanMsg = '房间号应为 4 位（字母/数字，去除 I/O/0/1 等易混字符）';
        render();
        return;
      }
      onOnline({ kind: 'join', code });
      return;
    } else if (a === 'start') {
      if (!ui.mode || !ui.faction) return;
      const seed = readSeed();
      root.innerHTML = '';
      onStart({ mode: ui.mode, p1Side: ui.faction, split: ui.mode === MODE.COOP_PVE ? ui.split : null }, seed);
      return;
    }
    render();
  });

  // 保留输入框内容：复选框、种子、房间号
  root.addEventListener('input', e => {
    if (e.target.id === 'seedInput') ui.seed = e.target.value;
    else if (e.target.id === 'roomCode') ui.joinCode = e.target.value;
  });
  root.addEventListener('change', e => {
    if (e.target.matches('input[type="checkbox"]')) {
      ui.split[e.target.dataset.i] = e.target.checked ? 'P1' : 'P2';
      render();
    } else if (e.target.id === 'seedInput') {
      ui.seed = e.target.value;
    } else if (e.target.id === 'roomCode') {
      ui.joinCode = e.target.value;
    }
  });

  render();
}
