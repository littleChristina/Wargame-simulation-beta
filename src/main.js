import { scenario } from './data/scenario.js';
import { showSetupScreen } from './ui/setup-screen.js';
import { initApp } from './ui/app.js';
import { startLanSession } from './ui/lan-session.js';
import { loadRoomToken } from './net/client.js';
import { decodeState } from './net/wire.js';

// 先显示开局设置屏（本地/局域网），确认后进入对局。
// window.game 暴露对局状态读取器，供调试与联机开发使用。
// 全局错误钩子（诊断用）
window.addEventListener('error', e => {
  window.__lastErr = e.message + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno;
});

const setupEl = document.getElementById('setup');
const layoutEl = document.getElementById('layout');
const canvas = document.getElementById('map');
console.log('[渡口] v0.3 · 局域网联机 · ' + location.origin);

function startLocal(setup, seed) {
  setupEl.style.display = 'none';
  layoutEl.style.display = 'flex';
  window.game = initApp(canvas, scenario, seed, setup);
}

function startOnline(action) {
  startLanSession({
    action,
    root: setupEl,
    layout: layoutEl,
    onGame: ({ client, seat, snapshot }) => {
      const st = decodeState(snapshot.state);
      const seed = st ? (parseInt(st.seedText, 10) || 0) : 0;
      window.game = initApp(canvas, scenario, seed, null, {
        net: client, seat, initialSnapshot: snapshot,
      });
    },
    onCancel: () => location.reload(),
  });
}

try {
  const params = new URLSearchParams(location.search);
  const room = String(params.get('room') || '').toUpperCase();
  const token = room ? loadRoomToken(room) : null;
  if (room && token) {
    // 刷新/断线重连：凭本地 token 恢复对局
    startOnline({ kind: 'resume', code: room, token });
  } else {
    showSetupScreen(setupEl, scenario, startLocal, {
      initialCode: room,
      onOnline: startOnline,
    });
  }
} catch (e) {
  setupEl.textContent = '设置屏错误: ' + (e.stack || e);
}
