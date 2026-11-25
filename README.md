# 兵棋《渡口》beta

二战题材六角格网页兵棋（热座 / 单人 PVE / 双人合作 PVE / 局域网联机）。**零依赖**：纯 ES Modules + Canvas + Node 内置 http，不需要 npm，没有构建步骤。

> **迁移/接手必读：[docs/DESIGN.md](docs/DESIGN.md)** —— 已封版机制全览、架构、当前状态与路线图都在这一份里。

## 运行

**一键启动：双击 `start.bat`**——服务器默认 **8090**；如果 8090 被占用，会自动改用 8091、8092… 并自动打开正确的浏览器地址。控制台会打印本机与局域网地址（含实际端口）。关闭那个窗口或按 Ctrl+C 即停止服务。

也可以手动：`node server.js`（同样自动换端口）。PowerShell 里想指定起始端口：`$env:PORT=8095; node server.js`，然后打开控制台打印的 URL（需要 Node 18+）。

> 旧版可能在 8080 上还有一个杀不掉的进程；**不用管它**。新版从 8090 开始，旧 8080 标签页直接关掉即可。
> 如果页面标题没有 `v0.3 · 局域网联机`、按钮还是“开 战”，说明你打开的是旧标签/旧服务。请用新控制台自动打开的 8090 地址，并 Ctrl+F5 强制刷新。
> Cloudflare Tunnel 固定用 8090 + strict 模式，见 [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)。

自测：双击 `test.bat`（规则引擎 + 界面点击链路 + 联机服务 + 大厅四套都跑），或手动：

```
node test/engine.test.js
node test/ui.test.js
node test/net.test.js
node test/lobby.test.js
```

## 局域网联机

1. 房主双击 `start.bat`，用**新弹出的浏览器页**（或控制台打印的地址，如 `http://192.168.1.23:8090`；8090 被占用时会自动换端口）。
2. 在开局设置里选 **热座 PvP** 或 **双人合作 PVE**、阵营（合作模式可调兵力分配），点 **创建房间**。
3. 把等待界面里的**邀请链接**发给同一局域网的朋友；对方打开链接（房间号会预填）后点 **加入房间**。也可以直接让朋友打开页面并输入 4 位房间号。
4. 双方页面都连上后服务端自动开局；先手方开始行动。对手断线时顶部会提示，刷新页面可凭本地保存的 token 自动重连。
5. 若朋友打不开：确认在**同一局域网**、Windows 防火墙允许 Node（专用网络），且用的是房主控制台打印的 IP，不是 `localhost`。

> 联机是**权威服务端**模式：对局状态只在 Node 进程里，浏览器发指令、收全量快照；AI 也在服务端行动。局域网是 HTTP（不加密），**不要直接端口映射到公网**。要朋友远程加入，用 Cloudflare Tunnel + 可选 Access，origin 固定 `http://127.0.0.1:8090`，详见 [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)。

## 一键公网服务（Cloudflare Tunnel）

前提：域名已托管在 Cloudflare、cloudflared 已安装、`%USERPROFILE%\.cloudflared\config.yml` 里游戏 hostname 的 origin 是 `http://127.0.0.1:8090`（配置见 [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)）。

首次使用：复制 `public.local.example.json` 为 **`public.local.json`**，填写你自己的公网地址和隧道名（该文件已在 `.gitignore`，不会上传）：

```json
{
  "publicUrl": "https://your-domain.example",
  "tunnel": "your-tunnel-name"
}
```

然后双击 **`start-public.bat`**（本地文件，默认被 `.gitignore` 忽略；仓库内也可以直接 `node tools/public-server.mjs`），它会：

1. 以 **strict 8090** 启动游戏（不会自动漂端口，保证和 cloudflared ingress 一致）；
2. 轮询 `http://127.0.0.1:8090/api/network` 等游戏就绪；
3. 启动 `cloudflared tunnel --config ... run <你的隧道名>`；
4. 隧道连上（或最迟约 6 秒）后自动打开 `public.local.json` 里的公网地址；
5. **Ctrl+C** 同时关闭游戏与隧道。如果检测到 cloudflared 已作为服务/进程在跑，则只启动游戏并复用已有隧道。

- 只检查不启动：`start-public.bat check` 或 `node tools/public-server.mjs check`（Node/cloudflared/config/8090/隧道进程）。
- 日志同一窗口，前缀 `[game]` / `[tunnel]`。
- 房主用自动打开的域名页面创建房间，邀请链接就是 `https://你的域名/?room=XXXX`；不要用 localhost 创建。
- 改过 `config.yml` 且 cloudflared 是 Windows 服务时，需要重启该服务（本脚本不会重启服务）。
- 默认只绑 `127.0.0.1`（只走隧道）；同时要局域网直连时，把 `tools/public-server.mjs` 里的 `DUKOU_PUBLIC_HOST` 设为 `0.0.0.0`。

## 玩法速览

- **剧本《渡口》**：12 回合渡河攻坚。攻方（红，南岸）终局时占住西桥出口 / 东桥出口 / 城镇 3 个目标点中的 2 个即胜；守方（蓝，北岸）守住即胜。
- **回合流程**：①回合开始处理（压制到期、补给判定）→ ②移动阶段（点单位 → 点白罩格移动）→ ③战斗阶段（点敌格开战、点炮兵进入炮击模式）→ ④结束回合。
- **战斗**：攻防比值查 2d6 结果表。记号：A=攻方损步，D=守方损步，R=守方被击退格数，C=无事。损步=翻面到受损面，再损=摧毁；炮兵无受损面，损步即死。
- **地形＝行修正**：森林/丘陵/城镇/跨小河 −1 行，跨大河 −2 行（含桥）；同岸火力占总量过半可豁免跨河修正（迂回豁免）。
- **炮兵**：不查表，必中压制（攻防 −1），射程 2–6 不能打相邻，移动或射击二选一，被压制=哑火，断供不能射击。
- **双层 ZOC**：单个敌人挡不住任何东西；两个敌人的 ZOC 重叠成强 ZOC——踩入即停、堵补给、禁撤退。
- **补给**：每回合开始判定；断供步兵装甲战力不变，但缺补给单位一参战就自损 1 步。
- **堆叠**：每格 3 点（步 1、装 2、炮 0 且每格 ≤2 门）；满格可穿过不可停留。同格多单位时用下方**堆叠选择栏**切换操作对象。
- **撤退**：守方逐个挑单位、逐格规划路线（每格判 ZOC、不走回头路），终点超出堆叠损 1 步并再撤 1 格；无主动放弃撤退。多单位撤退时先在结算面板**点选要撤退的单位**。
- **AI 应手**：人类回合内，AI 守军的步损分配 / 撤退 / 挺进自动结算；人类只处理属于自己的应手（如攻方挺进）。
- **挺进**：击退/歼灭后可选一个参战单位进占腾出的格。
- | 攻:防 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1:3 | A2 | A2 | A1 | A1 | A1 | A1 | C | C | C | C | C |
| 1:2 | A2 | A1 | A1 | A1 | C | C | C | C | DR | DR | DR |
| 1:1 | A2 | A1 | A1 | C | D1 | D1 | DR | DR | DR1 | DR1 | DR1 |
| 1.5:1 | A1 | A1 | C | C | DR | DR | DR1 | DR1 | DR1 | DRR1 | DRR1 |
| 2:1 | A1 | C | C | DR | DR | DR1 | DR1 | DR1 | DRR1 | DRR1 | DRR1 |
| 3:1 | C | DR | DR1 | DR1 | DR1 | DRR1 | DRR1 | D2 | D2 | D2 | D2 |
| 4:1 | DR | DR1 | DRR1 | DRR1 | D2 | D2 | D2 | D2 | D2 | D2 | D2 |
| 5:1+ | DRR1 | D2 | D2 | D2 | D2 | D2 | D2 | D2 | D2 | D2 | D2 |

## 代码结构

```
src/engine  规则引擎（确定性、带种子随机数，不碰 DOM）
src/data    剧本《渡口》（地图、河流、编制）
src/ui      Canvas 渲染与交互（热座 / PVE / 合作 / 联机对局）
src/net     联机协议、状态序列化、浏览器 SSE 客户端
server/     局域网房间服务（权威 state、座位、AI 驱动、静态白名单）
server.js   入口：静态页面 + 房间 API + SSE（默认 8090，本地占用时自动 8091…；隧道用 strict）
tools/      public-server.mjs 一键公网监督进程：strict 8090 + cloudflared + 打开域名
start-public.bat 公网一键启动（ASCII 入口，逻辑在 tools/public-server.mjs）
test        engine.test.js 规则 / ui.test.js 假 DOM 点击链路 / net.test.js 联机服务 / lobby.test.js 建房加入恢复
```

调平衡主要改 `src/data/scenario.js`（地形/编制/目标）和 `src/engine/crt.js`（结果表）。

## 已知简化

- 道路无连续性判定（可之字蹭相邻道路格）。
- 攻方按剧本预先摆在南岸，非入场制。
- 战斗结算中守方的步损分配、撤退路线均由守方玩家逐步点选，暂无"推荐默认"。
- 联机：房间在内存中（服务重启即丢）；无聊天/观战/断线托管；身份仅靠房间号 + token，适合局域网，不适合直接暴露公网。

## 路线图

热座 / 单人 PVE / 双人合作 PVE / 局域网联机（已可用）→ Cloudflare Tunnel + 私有域名 + Access（朋友输网址远程加入）→ 平衡调参。

