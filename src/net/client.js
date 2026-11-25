// 浏览器联机客户端：SSE 收快照，POST 发指令。传输接口留白，方便以后换 WebSocket。
import { API } from './protocol.js';

const STORAGE_PREFIX = 'dukou.room.';

export function saveRoomToken(code, token) {
  try { localStorage.setItem(STORAGE_PREFIX + code, token); } catch { /* 隐私模式 */ }
}
export function loadRoomToken(code) {
  try { return localStorage.getItem(STORAGE_PREFIX + code); } catch { return null; }
}
export function clearRoomToken(code) {
  try { localStorage.removeItem(STORAGE_PREFIX + code); } catch { /* ignore */ }
}

async function postJson(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (json && typeof json.ok === 'boolean') return { ...json, status: res.status };
    return { ok: false, status: res.status, error: '服务器响应异常（HTTP ' + res.status + '）' };
  } catch (e) {
    return { ok: false, error: '无法连接服务器：' + (e && e.message ? e.message : e) };
  }
}

export function createRoomRemote(setup, seed) { return postJson(API.create, { setup, seed }); }
export function joinRoomRemote(code) { return postJson(API.join, { code }); }
export function resumeRoomRemote(code, token) { return postJson(API.resume, { code, token }); }
export function closeRoomRemote(code, token) { return postJson(API.close, { code, token }); }

export async function fetchLanAddresses() {
  try {
    const res = await fetch(API.network);
    const json = await res.json();
    return Array.isArray(json.addresses) ? json.addresses : [];
  } catch { return []; }
}

// 创建联机客户端。消息通过 onMessage 分发；EventSource 自带断线重连。
export function createGameClient({ code, token }) {
  const listeners = new Set();
  let es = null;
  let closed = false;
  let errorHandler = null;
  let offline = false;

  function emit(msg) {
    for (const fn of [...listeners]) {
      try { fn(msg); } catch (e) { console.error(e); }
    }
  }
  function onMessage(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function onError(fn) { errorHandler = fn; }

  function open() {
    if (closed) return;
    const url = `${API.events}?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`;
    es = new EventSource(url);
    es.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      offline = false;
      emit(msg);
    };
    es.onerror = () => {
      if (closed) return;
      if (!offline) {
        offline = true;
        if (errorHandler) errorHandler();
      }
    };
  }

  async function send(cmd) {
    try {
      const res = await fetch(API.cmd, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, token, cmd }),
      });
      const json = await res.json().catch(() => ({ ok: false, error: '服务器响应异常' }));
      return json;
    } catch (e) {
      return { ok: false, error: '网络错误：' + (e && e.message ? e.message : e) };
    }
  }

  function close() {
    closed = true;
    try { es?.close(); } catch { /* ignore */ }
    es = null;
  }

  return { code, token, onMessage, onError, open, send, close };
}
