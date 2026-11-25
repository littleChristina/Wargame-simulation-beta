// 局域网联机 HTTP 服务：静态文件（白名单）+ 房间 API + SSE 事件流。
// 零依赖：只用 node:http / fs / path / os。SSE 下发快照，POST /api/cmd 上传指令。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RoomManager, publicSeat } from './rooms.js';
import { API, MAX_BODY_BYTES, ROOM_TTL_MS, MAX_ROOMS } from '../src/net/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};
const STATIC_EXT = new Set(Object.keys(MIME));

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'";

const VIRTUAL_IF = /vmware|virtualbox|vbox|hyper-?v|vethernet|tailscale|zerotier|wsl|docker|loopback|bluetooth|npcap|tap|tun/i;
const LAN_IF = /wlan|wi-?fi|wireless|无线|ethernet|以太网|en\d|eth\d/i;
const PRIVATE_IP = /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./;

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  // 先排除 VMware/Hyper-V/Tailscale 等虚拟网卡，再优先 WLAN/以太网；
  // 房主真正给朋友用的通常是 WLAN/eth 的 192.168/10/172 私有地址。
  const score = a => {
    let s = 0;
    if (VIRTUAL_IF.test(a.name)) s -= 10;
    if (LAN_IF.test(a.name)) s += 4;
    if (PRIVATE_IP.test(a.address)) s += 2;
    return s;
  };
  return out.sort((a, b) => score(b) - score(a));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        const e = new Error('请求体过大');
        e.status = 413;
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { const e = new Error('JSON 格式错误'); e.status = 400; reject(e); }
    });
    req.on('error', reject);
  });
}

// 静态文件白名单：只允许 index.html 与 /src/ 下的 .js/.css/图片；
// 其余（.git、.vs、docs、test、server、README、package.json…）一律 404。
function resolveStatic(pathname) {
  if (pathname === '/' || pathname === '/index.html') return path.join(ROOT, 'index.html');
  if (!pathname.startsWith('/src/')) return null;
  const rel = pathname.slice(1);
  const segs = rel.split('/');
  if (segs.some(seg => seg === '' || seg.startsWith('.'))) return null;
  if (!STATIC_EXT.has(path.extname(rel).toLowerCase())) return null;
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

export function createGameServer({
  scenario,
  aiStepDelayMs = 250,
  roomTtlMs = ROOM_TTL_MS,
  maxRooms = MAX_ROOMS,
  logger = console,
} = {}) {
  const rooms = new RoomManager({ scenario, aiStepDelayMs, roomTtlMs, maxRooms, logger });

  const limited = new Map(); // ip -> { t, n }（只用于建房/加入的轻量限流）
  function allow(ip, key, max, windowMs) {
    const bucketKey = key + '|' + ip;
    const now = Date.now();
    let b = limited.get(bucketKey);
    if (!b || now - b.t > windowMs) { b = { t: now, n: 0 }; limited.set(bucketKey, b); }
    b.n += 1;
    return b.n <= max;
  }
  const clientIp = req => (req.headers['cf-connecting-ip'] && req.socket.remoteAddress === '127.0.0.1')
    ? String(req.headers['cf-connecting-ip'])
    : (req.socket.remoteAddress || 'unknown');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { sendJson(res, 400, { ok: false, error: '非法路径' }); return; }

    // ---------- API ----------
    if (pathname === API.create) {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET 不支持' }); return; }
      if (!allow(clientIp(req), 'create', 10, 60_000)) {
        sendJson(res, 429, { ok: false, error: '创建房间太频繁，请稍后再试' }); return;
      }
      const body = await readJson(req);
      let created;
      try { created = rooms.create({ setup: body.setup, seed: body.seed }); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message }); return; }
      const { room, seat } = created;
      sendJson(res, 200, { ok: true, code: room.code, token: seat.token, seat: publicSeat(seat) });
      return;
    }
    if (pathname === API.join) {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET 不支持' }); return; }
      if (!allow(clientIp(req), 'join', 30, 60_000)) {
        sendJson(res, 429, { ok: false, error: '加入太频繁，请稍后再试' }); return;
      }
      const body = await readJson(req);
      const room = rooms.room(body.code);
      if (!room) { sendJson(res, 404, { ok: false, error: '房间不存在或已过期' }); return; }
      let guest;
      try { guest = rooms.join(room); }
      catch (e) { sendJson(res, 409, { ok: false, error: e.message }); return; }
      sendJson(res, 200, { ok: true, code: room.code, token: guest.token, seat: publicSeat(guest) });
      // 若房主 SSE 已连接，加入后双方都连上就会开局；否则等两人都连上。
      rooms.maybeStart(room);
      return;
    }
    if (pathname === API.resume) {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET 不支持' }); return; }
      const body = await readJson(req);
      try {
        const { room, seat } = rooms.resume(body.code, body.token);
        sendJson(res, 200, {
          ok: true, code: room.code, seat: publicSeat(seat),
          started: !!room.state, room: rooms.publicRoom(room),
        });
      } catch (e) { sendJson(res, 404, { ok: false, error: e.message }); }
      return;
    }
    if (pathname === API.close) {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET 不支持' }); return; }
      const body = await readJson(req);
      let found;
      try { found = rooms.resume(body.code, body.token); }
      catch (e) { sendJson(res, 404, { ok: false, error: e.message }); return; }
      const { room, seat } = found;
      if (seat.id !== 'P1') { sendJson(res, 403, { ok: false, error: '只有房主可以关闭房间' }); return; }
      if (room.state) { sendJson(res, 400, { ok: false, error: '对局已开始，不能关闭房间' }); return; }
      rooms.closeRoom(room);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === API.cmd) {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET 不支持' }); return; }
      const body = await readJson(req);
      const room = rooms.room(body.code);
      if (!room) { sendJson(res, 404, { ok: false, error: '房间不存在或已过期' }); return; }
      const seat = rooms.seatByToken(room, body.token);
      if (!seat) { sendJson(res, 403, { ok: false, error: '身份已失效' }); return; }
      try {
        const out = rooms.apply(room, seat, body.cmd);
        sendJson(res, 200, out);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }
    if (pathname === API.events) {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'POST 不支持' }); return; }
      const code = url.searchParams.get('code');
      const token = url.searchParams.get('token');
      const room = rooms.room(code);
      if (!room) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('room not found'); return; }
      const seat = rooms.seatByToken(room, token);
      if (!seat) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('bad token'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      res.flushHeaders?.();
      rooms.attach(room, seat, res);
      return;
    }
    if (pathname === API.network) {
      sendJson(res, 200, { ok: true, addresses: lanAddresses() });
      return;
    }

    // ---------- 静态 ----------
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: '方法不支持' });
      return;
    }
    const file = resolveStatic(pathname);
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    try {
      const data = await readFile(file);
      const headers = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      };
      if (path.extname(file).toLowerCase() === '.html') headers['Content-Security-Policy'] = CSP;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      logger.error?.('[http]', e);
      if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
      sendJson(res, e.status || 500, { ok: false, error: e.status ? e.message : '服务器内部错误' });
    });
  });

  const close = () => new Promise(resolve => {
    rooms.dispose();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

  return { server, rooms, close };
}
