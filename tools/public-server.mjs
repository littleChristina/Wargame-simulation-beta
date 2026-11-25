// 一键公网服务（由 start-public.bat 调用）：
//   1. 在本机 8090 上以 strict 模式启动游戏服务（端口不漂移，匹配 cloudflared ingress）
//   2. 等 /api/network 就绪
//   3. 启动 cloudflared 隧道
//   4. 隧道连上后自动打开公网地址
//   5. Ctrl+C 时同时关闭游戏与隧道；已装成服务的 cloudflared 不会被杀掉
//
// 真实域名/隧道名放在本地 public.local.json（已在 .gitignore，不会上传）：
//   { "publicUrl": "https://your-domain.example", "tunnel": "your-tunnel-name" }
// 首次使用复制 public.local.example.json 并填写。也可用环境变量覆盖。
//
//   DUKOU_PUBLIC_PORT=8090
//   DUKOU_PUBLIC_HOST=127.0.0.1   (只走隧道；需要局域网直连改 0.0.0.0)
//   DUKOU_PUBLIC_URL=https://your-domain.example
//   DUKOU_TUNNEL=your-tunnel-name
//   DUKOU_CLOUDFLARED_CONFIG=%USERPROFILE%\.cloudflared\config.yml
//   DUKOU_CLOUDFLARED=cloudflared
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_CONFIG_FILE = path.join(ROOT, 'public.local.json');
let localConfig = {};
try {
  localConfig = JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8'));
} catch (e) {
  if (e && e.code !== 'ENOENT') console.warn('[warn] public.local.json 读取失败：' + e.message);
}
const PORT = parseInt(process.env.DUKOU_PUBLIC_PORT || '8090', 10);
const HOST = process.env.DUKOU_PUBLIC_HOST || '127.0.0.1';
const PUBLIC_URL = process.env.DUKOU_PUBLIC_URL || localConfig.publicUrl || 'https://your-domain.example';
const TUNNEL = process.env.DUKOU_TUNNEL || localConfig.tunnel || 'your-tunnel-name';
const CONFIG = process.env.DUKOU_CLOUDFLARED_CONFIG
  || path.join(os.homedir(), '.cloudflared', 'config.yml');
const CHECK = process.argv.slice(2).some(a => a === 'check' || a === '--check');
const OPEN_DELAY_MS = 6000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function findCloudflared() {
  if (process.env.DUKOU_CLOUDFLARED) return process.env.DUKOU_CLOUDFLARED;
  const candidates = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return 'cloudflared';
}
const CLOUDFLARED = findCloudflared();

function cfProcessRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/NH'], { encoding: 'utf8' });
    return /cloudflared\.exe/i.test(r.stdout || '');
  } catch { return false; }
}

async function getJson(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
const gameUrl = `http://127.0.0.1:${PORT}/api/network`;
const gameUp = async () => !!(await getJson(gameUrl));

function prefixStream(stream, prefix) {
  if (!stream) return;
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) if (line.trim()) log(`${prefix} ${line}`);
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    try {
      spawn('cmd', ['/c', 'start', '', url], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    } catch { /* 打不开就让用户手动点控制台里的地址 */ }
  }
}

async function checkMode() {
  const major = Number(process.versions.node.split('.')[0]);
  log('===== 环境检查 =====');
  log(`Node:          ${process.version}${major >= 18 ? '' : '  (需要 18+)'}`);
  log(`cloudflared:   ${CLOUDFLARED}${fs.existsSync(CLOUDFLARED) ? '  (found)' : '  (will use PATH)'}`);
  log(`config:        ${CONFIG}${fs.existsSync(CONFIG) ? '  OK' : '  MISSING'}`);
  log(`game origin:   http://${HOST}:${PORT}`);
  log(`game service:  ${(await gameUp()) ? 'RUNNING' : 'not running'}`);
  log(`cloudflared:   ${cfProcessRunning() ? 'RUNNING' : 'not running'}`);
  log(`local config:  ${fs.existsSync(LOCAL_CONFIG_FILE) ? 'public.local.json (present)' : 'none (using placeholders; copy public.local.example.json)'}`);
  log(`tunnel:        ${TUNNEL}`);
  log(`public URL:    ${PUBLIC_URL}`);
  log('====================');
  process.exit(major >= 18 ? 0 : 1);
}

const children = [];
let stopping = false;
let openTimer = null;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (openTimer) clearTimeout(openTimer);
  for (const c of children) {
    try { if (c.exitCode === null) c.kill(); } catch { /* ignore */ }
  }
  await sleep(1200);
  for (const c of children) {
    if (c.exitCode === null && process.platform === 'win32') {
      try { spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
  }
  process.exit(code);
}

async function main() {
  if (CHECK) { await checkMode(); return; }

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error('[错误] 需要 Node.js 18+（当前 ' + process.version + '）。');
    process.exit(1);
  }
  if (!fs.existsSync(CONFIG)) {
    console.error(`[错误] 找不到隧道配置：${CONFIG}`);
    process.exit(1);
  }

  log('==================================================');
  log('  兵棋《渡口》公网服务');
  log(`  游戏 origin : http://${HOST}:${PORT}`);
  log(`  公网地址    : ${PUBLIC_URL}`);
  log(`  隧道        : ${TUNNEL}`);
  log(`  配置        : ${CONFIG}`);
  log('  Ctrl+C 结束：会同时关闭由本脚本启动的游戏与隧道。');
  log('==================================================');
  if (!fs.existsSync(LOCAL_CONFIG_FILE) && !process.env.DUKOU_PUBLIC_URL) {
    log('[提示] 未找到 public.local.json，当前使用示例域名/隧道；');
    log('       请复制 public.local.example.json 为 public.local.json 并填写真实值。');
  }

  process.on('SIGINT', () => { log('\n正在停止...'); shutdown(0); });
  process.on('SIGTERM', () => shutdown(0));

  let gameStarted = false;
  if (await gameUp()) {
    log(`[提示] 检测到 ${PORT} 上已有游戏服务，直接复用。`);
  } else {
    log(`启动游戏服务（严格端口 ${PORT}）...`);
    const game = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), DUKOU_STRICT_PORT: '1', DUKOU_OPEN: '0', HOST },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    children.push(game);
    gameStarted = true;
    prefixStream(game.stdout, '[game]');
    prefixStream(game.stderr, '[game]');
    game.on('error', err => {
      console.error(`[错误] 启动游戏服务失败：${err.message}`);
      shutdown(1);
    });
    game.on('exit', code => {
      if (!stopping) {
        console.error(`[错误] 游戏服务退出（code ${code}），见上方 [game] 输出。`);
        shutdown(1);
      }
    });

    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 20000) {
      if (game.exitCode !== null) break;
      if (await gameUp()) { up = true; break; }
      await sleep(300);
    }
    if (!up) {
      console.error(`[错误] 游戏服务没有在 ${PORT} 就绪。`);
      console.error('        常见原因：8090 被占用、Node 版本过旧、或 server.js 报错（见上方 [game]）。');
      await shutdown(1);
      return;
    }
    log(`游戏服务已就绪：http://${HOST}:${PORT}`);
  }

  if (cfProcessRunning()) {
    log('[提示] 检测到 cloudflared 已在运行，跳过启动隧道（假设服务已连上）。');
    openBrowser(PUBLIC_URL);
    log(`公网地址：${PUBLIC_URL}`);
    log('本脚本保持运行；Ctrl+C 结束游戏服务（不会停止已运行的 cloudflared 服务）。');
    await new Promise(() => {});   // 由 SIGINT 退出
    return;
  }

  log(`启动 Cloudflare Tunnel（${TUNNEL}）...`);
  log('隧道连上后自动打开公网地址（最迟约 6 秒）。');
  let opened = false;
  const maybeOpen = () => {
    if (opened) return;
    opened = true;
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    openBrowser(PUBLIC_URL);
  };
  openTimer = setTimeout(maybeOpen, OPEN_DELAY_MS);

  const tunnel = spawn(CLOUDFLARED, ['tunnel', '--config', CONFIG, 'run', TUNNEL], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  children.push(tunnel);
  prefixStream(tunnel.stdout, '[tunnel]');
  prefixStream(tunnel.stderr, '[tunnel]');
  const watchRegistered = stream => stream?.on('data', chunk => {
    if (/Registered tunnel connection/i.test(chunk.toString())) maybeOpen();
  });
  watchRegistered(tunnel.stdout);
  watchRegistered(tunnel.stderr);
  tunnel.on('error', err => {
    if (stopping) return;
    if (openTimer) clearTimeout(openTimer);
    console.error(`[错误] 启动 cloudflared 失败：${err.message}`);
    console.error('        请确认 cloudflared 已安装（或设置 DUKOU_CLOUDFLARED 为完整路径）。');
    shutdown(1);
  });
  tunnel.on('exit', code => {
    if (stopping) return;
    log(`隧道已退出（code ${code}）。`);
    shutdown(code || 0);
  });
}

main().catch(err => {
  console.error(err);
  shutdown(1);
});
