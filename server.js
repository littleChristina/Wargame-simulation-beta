// 零依赖入口：静态网页 + 局域网联机房间服务（SSE + POST）。
// 端口策略：默认 8090；本地启动时 8090 被占用会自动尝试 8091…8099。
// 走 Cloudflare Tunnel 时用 DUKOU_STRICT_PORT=1 固定 8090（不换端口）：
//   $env:PORT=8090; $env:DUKOU_STRICT_PORT=1; $env:HOST='127.0.0.1'; node server.js
// 端口来源优先级：PORT 环境变量 > 8090。
import { spawn } from 'node:child_process';
import { createGameServer, lanAddresses } from './server/http.js';
import { scenario } from './src/data/scenario.js';

const BASE_PORT = Number(process.env.PORT) || 8090;
const MAX_PORT_TRIES = 10;              // 8090..8099
const STRICT = process.env.DUKOU_STRICT_PORT === '1';
const HOST = process.env.HOST || '0.0.0.0';
const { server, rooms } = createGameServer({ scenario });

function openBrowser(port) {
  if (process.env.DUKOU_OPEN !== '1' || process.platform !== 'win32') return;
  try {
    spawn('cmd', ['/c', 'start', '', `http://localhost:${port}`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  } catch { /* 浏览器打不开就手动点控制台地址 */ }
}

function fail(err) {
  if (err && err.code === 'EADDRINUSE') {
    if (STRICT) {
      console.error(`端口 ${HOST}:${BASE_PORT} 已被占用；DUKOU_STRICT_PORT=1 下不会自动换端口。`);
      console.error('请关掉占用该端口的进程，或修改 PORT 并同步修改 cloudflared 的 ingress。');
    } else {
      console.error(`端口 ${BASE_PORT}~${BASE_PORT + MAX_PORT_TRIES - 1} 都已被占用。`);
      console.error('请关掉占用进程；或先 "set PORT=8091" 再运行 "node server.js"。');
    }
  } else {
    console.error(err);
  }
  process.exit(1);
}

function boot(port) {
  function onListening() {
    server.off('error', onError);
    const actual = server.address().port;
    console.log('兵棋《渡口》v0.3（局域网联机）已启动');
    console.log(`  本机:   http://localhost:${actual}`);
    if (HOST === '0.0.0.0' || HOST === '::') {
      for (const a of lanAddresses()) {
        console.log(`  局域网: http://${a.address}:${actual}   (${a.name})`);
      }
    } else {
      console.log(`  绑定:   ${HOST}:${actual}（仅本机/隧道访问，局域网入口不可用）`);
    }
    console.log('  联机：创建房间后，把邀请链接发给同一局域网的朋友即可。');
    if (STRICT) console.log(`  端口锁定 ${BASE_PORT} 模式（适合 Cloudflare Tunnel，不会自动换端口）。`);
    else if (actual !== BASE_PORT) console.log(`  （${BASE_PORT} 被占用，已自动改用 ${actual}）`);
    openBrowser(actual);
  }
  function onError(err) {
    server.off('listening', onListening);
    const canTryNext = !STRICT && port - BASE_PORT + 1 < MAX_PORT_TRIES;
    if (err && err.code === 'EADDRINUSE' && canTryNext) {
      const next = port + 1;
      console.warn(`  端口 ${port} 被占用，尝试 ${next}…`);
      setTimeout(() => boot(next), 40);
      return;
    }
    fail(err);
  }
  server.once('listening', onListening);
  server.once('error', onError);
  server.listen(port, HOST);
}

boot(BASE_PORT);

function shutdown() {
  rooms.dispose();
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref?.();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
