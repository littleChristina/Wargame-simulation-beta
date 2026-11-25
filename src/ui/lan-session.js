// 局域网联机会话界面：创建/加入/恢复 → 等待双方连接 → 交棒给对局 UI。
// 传输是 SSE + POST；开局后由 app.js 订阅同一 client 的快照。
import { createRoomRemote, joinRoomRemote, resumeRoomRemote, closeRoomRemote,
         fetchLanAddresses, createGameClient, saveRoomToken, clearRoomToken } from '../net/client.js';
import { sideName } from '../engine/state.js';
import { MODE } from '../engine/setup.js';
import { isValidRoomCode } from '../net/protocol.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function modeName(mode) {
  if (mode === MODE.PVP) return '热座 PvP（联机）';
  if (mode === MODE.COOP_PVE) return '双人合作 PVE（联机）';
  return '联机';
}

async function inviteLink(code) {
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
  const port = location.port ? ':' + location.port : '';
  let host = location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (local) {
    const addrs = await fetchLanAddresses();
    const ip = addrs.map(a => a.address).find(Boolean);
    if (ip) host = ip;
  }
  return `${protocol}//${host}${port}/?room=${encodeURIComponent(code)}`;
}

export function startLanSession({ action, root, layout, onGame, onCancel }) {
  let client = null;
  let seat = null;
  let code = '';
  let token = '';
  let created = false;
  let started = false;
  let roomInfo = null;
  let hostSeat = false;

  function setStatus(text) {
    const el = document.getElementById('lan-status');
    if (el) el.textContent = text;
  }

  function renderError(message) {
    root.innerHTML = `<div class="setup-card lan-card">
      <h2>联机失败</h2>
      <p class="warn">${esc(message)}</p>
      <p class="dim">请确认服务已启动、房间号正确，且与房主在同一局域网。</p>
      <button data-lan="cancel" class="ghost">返回设置</button>
    </div>`;
  }

  function renderWaiting() {
    if (!seat) return;
    const sid = seat.id;
    const side = sideName(seat.side);
    const mode = roomInfo ? modeName(roomInfo.mode) : modeName(action.setup && action.setup.mode);
    root.innerHTML = `<div class="setup-card lan-card">
      <h2>局域网联机 · 房间 <span class="lan-code">${esc(code)}</span></h2>
      <p>${esc(mode)}　你是 <b>${esc(sid)}</b>（${esc(side)}）</p>
      <div class="row"><span class="lbl">邀请链接</span>
        <input id="lan-link" readonly size="46" value="正在获取局域网地址…">
      </div>
      <p class="dim">同一局域网的朋友用浏览器打开链接即可；也可以让他在开局设置里输入房间号 <b>${esc(code)}</b> 加入。</p>
      <p id="lan-status" class="warn">等待另一位玩家加入…</p>
      <button data-lan="copy">复制链接</button>
      <button data-lan="cancel" class="ghost">返回设置</button>
    </div>`;
    inviteLink(code).then(link => {
      const el = document.getElementById('lan-link');
      if (el) el.value = link;
    }).catch(() => {});
  }

  function updateWaiting(msg) {
    if (started) return;
    if (msg && msg.room) roomInfo = msg.room;
    const seats = roomInfo && Array.isArray(roomInfo.seats) ? roomInfo.seats : [];
    const other = seats.find(s => s.id !== (seat && seat.id));
    if (!other || !other.connected) {
      setStatus(other ? '对方已加入，等待连接…' : '等待另一位玩家加入…');
    } else {
      setStatus('双方已连接，正在开局…');
    }
  }

  function finish(snapshot) {
    if (started) return;
    started = true;
    root.innerHTML = '';
    root.style.display = 'none';
    layout.style.display = 'flex';
    onGame({ client, seat, snapshot });
  }

  const onClick = e => {
    const btn = e.target.closest('[data-lan]');
    if (!btn) return;
    if (btn.dataset.lan === 'copy') {
      const inp = document.getElementById('lan-link');
      if (inp) {
        inp.focus(); inp.select();
        try { document.execCommand('copy'); setStatus('链接已复制，发给朋友即可'); }
        catch { setStatus('已选中链接，请按 Ctrl+C 复制'); }
      }
      return;
    }
    if (btn.dataset.lan === 'cancel') {
      if (!started && created && hostSeat && code && token) {
        closeRoomRemote(code, token).catch(() => {});
      }
      if (code) clearRoomToken(code);
      try { client?.close(); } catch { /* ignore */ }
      client = null;
      try { history.replaceState(null, '', '/'); } catch { /* ignore */ }
      onCancel();
      return;
    }
  };
  root.addEventListener('click', onClick);

  async function begin() {
    root.innerHTML = `<div class="setup-card"><h2>局域网联机</h2><p class="dim">正在连接服务器…</p></div>`;
    let res;
    if (action.kind === 'create') {
      res = await createRoomRemote(action.setup, action.seed);
      created = true;
    } else if (action.kind === 'join') {
      res = await joinRoomRemote(action.code);
    } else if (action.kind === 'resume') {
      res = await resumeRoomRemote(action.code, action.token);
    } else {
      renderError('未知的联机动作');
      return;
    }
    if (!res || !res.ok) { renderError(res && res.error ? res.error : '联机失败'); return; }
    code = res.code || (action.code || '');
    token = res.token || action.token || '';
    seat = res.seat || null;
    roomInfo = res.room || null;
    hostSeat = !!(seat && seat.id === 'P1');
    if (!isValidRoomCode(code)) { renderError('房间号异常'); return; }
    saveRoomToken(code, token);
    try { history.replaceState(null, '', `/?room=${encodeURIComponent(code)}`); } catch { /* ignore */ }

    client = createGameClient({ code, token });
    client.onError(() => { if (!started) setStatus('连接中断，正在自动重连…'); });
    client.onMessage(msg => {
      if (started) return;
      if (msg.t === 'hello') {
        if (msg.seat) seat = msg.seat;
        if (msg.room) roomInfo = msg.room;
        hostSeat = !!(seat && seat.id === 'P1');
        renderWaiting();
        updateWaiting(msg);
      } else if (msg.t === 'snapshot') {
        if (msg.room) roomInfo = msg.room;
        if (msg.state) finish(msg);
        else updateWaiting(msg);
      }
    });
    renderWaiting();
    client.open();
    if (action.kind === 'resume') setStatus(res.started ? '正在恢复对局…' : '已重新连接，等待开局…');
    setTimeout(() => { if (!started) setStatus('仍未收到对局数据；请确认房主页面仍在运行'); }, 8000).unref?.();
  }

  begin().catch(e => renderError(e && e.message ? e.message : String(e)));
}
