# Cloudflare Tunnel + 自有域名（origin 固定 8090）

> 目标：局域网的《渡口》继续用 `http://<房主IP>:8090`；远程朋友打开
> `https://wargame.example.com/?room=XXXX` 加入。**cloudflared 永远指向 `http://127.0.0.1:8090`**，不猜端口。
> 示例部署：隧道 `<你的隧道名>`（UUID `<TUNNEL_UUID>`）、公网 `wargame.example.com`、origin `127.0.0.1:8090`。真实值只放在本地的 `public.local.json`（已 gitignore）。

## 0. 一键启动（推荐）

前提：cloudflared 已安装、`%USERPROFILE%\.cloudflared\config.yml` 里游戏 hostname 的 ingress 已指向 `http://127.0.0.1:8090`。

首次使用：复制 `public.local.example.json` 为 **`public.local.json`**，填写 `publicUrl` / `tunnel`（该文件已在 `.gitignore`，不会上传）。

**双击 `start-public.bat`**（本地脚本；仓库中可直接 `node tools/public-server.mjs`）：

- 以 strict 8090 启动游戏（不会漂端口）；
- 等 `/api/network` 就绪后启动 `cloudflared tunnel run <public.local.json 里的隧道名>`；
- 隧道连上（最迟约 6 秒）后自动打开 `public.local.json` 里的公网地址；
- Ctrl+C 同时停止游戏与隧道；如果检测到 cloudflared 已作为服务/进程运行，则只启动游戏并复用隧道；
- `start-public.bat check`（或 `node tools/public-server.mjs check`）只检查环境，不启动任何服务。

流程由 [tools/public-server.mjs](../tools/public-server.mjs) 实现；真实域名/隧道名从 `public.local.json`（或环境变量）读取。如果改过 `config.yml` 且 cloudflared 是 Windows 服务，需要手动重启该服务让新 ingress 生效。

## 0.1 端口约定

| 用途 | 地址 |
| --- | --- |
| 游戏服务 origin | `http://127.0.0.1:8090` |
| Cloudflare 公网入口 | `https://wargame.example.com`（443，由 CF 终止 TLS） |
| 局域网入口（可选） | `http://<房主局域网IP>:8090` |

- 8090 被占用时，本地 `start.bat` 会自动尝试 8091…8099；**隧道模式必须关闭自动换端口**，用 `DUKOU_STRICT_PORT=1`。
- 8080 上如果还有旧进程（杀不掉也无所谓），**不要把它接进隧道**，它跑的是旧版。

## 1. 手动启动游戏服务（不使用一键脚本时）

在游戏目录开一个 PowerShell 窗口：

```powershell
cd "E:\dshtool\Wargame simulation beta"
$env:PORT=8090
$env:DUKOU_STRICT_PORT=1
$env:DUKOU_OPEN=0          # 隧道模式不要自动打开 localhost
$env:HOST="127.0.0.1"      # 只给 cloudflared 访问；若还要局域网直连，改成 "0.0.0.0"
node server.js
```

看到：

```
兵棋《渡口》v0.3（局域网联机）已启动
  本机:   http://localhost:8090
  绑定:   127.0.0.1:8090（仅本机/隧道访问，局域网入口不可用）
  端口锁定 8090 模式（适合 Cloudflare Tunnel，不会自动换端口）。
```

自检：

```powershell
Invoke-WebRequest http://127.0.0.1:8090/api/network -UseBasicParsing | Select-Object -Expand Content
```

如果 8090 被占用，strict 模式会直接报错退出——先关掉占用进程，或把 `PORT` 和隧道 ingress 一起改。

## 2. 安装 cloudflared（Windows）

任选一种：

- `winget install --id Cloudflare.cloudflared`
- 或从 <https://github.com/cloudflare/cloudflared/releases> 下载 `cloudflared-windows-amd64.exe`，改名 `cloudflared.exe` 放到 `C:\Windows\System32` 或 PATH 中。

验证：

```powershell
cloudflared --version
```

## 3. 先做一次临时隧道（不建域名，最快验证）

游戏服务在 8090 上跑着，另开一个 PowerShell：

```powershell
cloudflared tunnel --url http://127.0.0.1:8090
```

输出里会有一个 `https://<随机>.trycloudflare.com` 地址。用它打开：

1. 房主**用这个 https 地址**打开页面（不要用 localhost），确认标题是 `v0.3 · 局域网联机`。
2. 创建房间，邀请链接会自动是 `https://<随机>.trycloudflare.com/?room=XXXX`。
3. 用手机蜂窝网络（不要连家里 Wi-Fi）打开这个邀请链接，确认能进、能行动。
4. 试一下 SSE：对方行动时自己的页面应实时刷新；如果卡住，见第 7 节。

临时地址每次重启 cloudflared 都会变，只适合验证。

## 4. 命名隧道 + 自有域名（长期用）

> 如果你已经建好隧道（名字写在本地 `public.local.json`）并配好域名，下面是新建/排障时参考的命令，**不需要重复执行**。

前提：域名已托管在 Cloudflare（Cloudflare 用作 DNS）。

```powershell
cloudflared tunnel login
cloudflared tunnel create dukou
cloudflared tunnel route dns dukou wargame.example.com
```

`cloudflared tunnel create` 会给出隧道 UUID 和凭据文件路径（把 UUID 填进 `config.yml` 的 `tunnel:`）。

`%USERPROFILE%\.cloudflared\config.yml` 里游戏 hostname 这一段应为：

```yaml
ingress:
  - hostname: wargame.example.com
    service: http://127.0.0.1:8090
  - service: http_status:404
```

关键是 **游戏 hostname 必须用 `http://`，不能用 `tcp://`**（`tcp://` 是给 MC 那种裸 TCP 客户端用的，浏览器打不开）。

手工跑：

```powershell
cloudflared tunnel --config "%USERPROFILE%\.cloudflared\config.yml" run dukou
```

浏览器打开 `https://wargame.example.com`，确认页面、创建房间、邀请链接、朋友加入都正常。
装成开机自启服务：

```powershell
cloudflared service install
```

- 服务会读取 `%USERPROFILE%\.cloudflared\config.yml`；装完后在“服务”里确认自动启动。
- **游戏服务也要开机自启**，否则隧道在、origin 不在，朋友会看到 502/1033。可用计划任务或 NSSM 把第 1 节的启动命令做成服务；注意服务模式下 `DUKOU_OPEN=0`。
- 启动顺序：先游戏 8090，再 cloudflared（服务会自动等；origin 没起来时 CF 返回 502）。

## 5. 可选：Cloudflare Access

公网暴露前强烈建议加一层门禁：

1. Cloudflare Zero Trust → Access → Applications → Add an application → Self-hosted。
2. Application domain：`wargame.example.com`。
3. Policy：Action `Allow`，Include `Emails`，填入允许的朋友邮箱；身份提供方可用 One-time PIN（免费档，无需配置 IdP）。
4. 保存后，朋友打开邀请链接会先输邮箱验证码，再进游戏；之后会话 cookie 有效期内不用重复。

Access 之外，游戏自身的房间号 + token 仍然有效，是第二层。

## 6. 朋友怎么用

把等待界面的邀请链接（或直接 `https://wargame.example.com/?room=XXXX`）发给朋友：

1. 打开链接 → 通过 Access（如果开了）→ 开局设置里房间号已预填 → 点 **加入房间**。
2. 房主和朋友的页面都连上后服务端自动开局。
3. 中途刷新：URL 里的 `?room=` + 本地 token 会自动恢复座位。

**房主必须用 `https://wargame.example.com` 打开页面**，不要用 `http://localhost:8090`：
邀请链接是按浏览器地址生成的；用 localhost 打开时，链接会变成局域网 IP，远程朋友打不开。

## 7. SSE / 长连接排查

当前服务端已经：

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`
- 每 15s 一次 `: ping` 心跳
- `Connection: keep-alive`

在 CF 后实测：

- 朋友移动后，自己页面是否 1 秒内刷新；若“要等一段时间才一批刷新”，是代理缓冲/超时。
- 浏览器 Console → Network → `api/events`：连接是否保持、是否反复断线重连。
- 若 SSE 在 CF 下不稳定：把 [src/net/client.js](../src/net/client.js) 的传输换成 WebSocket（协议/房间/UI 不变，[server/rooms.js](../server/rooms.js) 可复用），CF 对 WebSocket 是第一级支持。

## 8. 安全与运维清单

- 反向隧道**不需要**路由器端口映射；cloudflared 只做出站连接，CGNAT 也能用。
- 不要把 8080 上的旧服务接进隧道；不要把 8090 直接暴露到公网。
- 静态白名单已屏蔽 `.git`、`.vs`、`test`、`docs`、`server`、README；公网前保持。
- 保留建房/加入限流、请求体上限、CSP、`nosniff`；Access 启用后由 CF 处理门禁。
- 主机不能睡眠；cloudflared 服务和游戏服务都设开机自启。
- 域名续费、CF 免费额度、Access 免费用户数（50）足够朋友规模。
- 公网化之前先跑一遍 [test/net.test.js](../test/net.test.js) 与 [test/lobby.test.js](../test/lobby.test.js)。

## 9. 常见故障

| 现象 | 检查 |
| --- | --- |
| 打开域名 502 / 1033 | 游戏是否在 8090 且 strict 未报错；`Invoke-WebRequest http://127.0.0.1:8090/api/network` 是否 200 |
| 页面还是旧版（无 v0.3） | 是否用了新的 8090 服务/域名；Ctrl+F5；是否打开了旧的 8080 标签 |
| 邀请链接是 `192.168.x.x` 或 localhost | 房主没通过域名打开页面；改用 `https://wargame.example.com` |
| 朋友能打开页面但点不动 | Access 是否通过；是否轮到对方回合；查看 Console 的 `/api/cmd` 返回 |
| 双方连不上、一直“等待另一位玩家” | 两边都要打开页面（SSE 都连上）才开局；检查是否有 403/404 |
| SSE 刷新延迟/中断 | 第 7 节；先试新开标签，再考虑换 WebSocket |
| 8090 被占用 | strict 模式会退出；找出占用进程，或同时修改 PORT 与 cloudflared ingress |
