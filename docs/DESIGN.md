# 兵棋《渡口》设计文档（迁移交接）

更新：2026-11-25。本文档是项目迁移的核心交接文件——新 agent / 新开发者从这里开始。

## 一、项目概述

二战题材六角格网页兵棋，剧本《渡口》（渡河攻坚）。**零依赖**：纯 ES Modules + Canvas + Node 内置 http，无构建步骤，Node 18+ 即可。

```
运行：双击 start.bat（或 node server.js）→ http://localhost:8090（8090 占用时自动 8091…；控制台同时打印局域网地址）
公网一键：start-public.bat → 严格 8090 游戏 + cloudflared + 自动打开 public.local.json 里的公网地址
自测：双击 test.bat（或 npm test）——engine 24 项 + ui 8 项 + net 5 项 + lobby 2 项，必须全过
```

玩法：热座 PvP / 单人 PVE / 双人合作 PVE（AI 执一方）/ 局域网联机。12 回合，攻方终局占 3 个目标点中 2 个即胜。

## 二、联机层（不改规则，只加通道）

- **权威服务端**：对局 `state` 只存在于 Node 房间进程；浏览器只发"意图指令"，收全量快照（`src/net/wire.js` 序列化；`Set` 转数组、`rngState` 不下发）。掷骰/合法性/应手归属都在服务端判定。
- **传输**：同源 **SSE 下发快照 + `POST /api/cmd` 上传指令**（零依赖，`EventSource` 自动重连）；`server/rooms.js` 管理房间/座位/AI，`server/http.js` 管理静态白名单/API/SSE；以后可只换传输层为 WebSocket。
- **座位与指令校验**：P1=房主、P2=加入者；PVP 双方异侧，合作同侧。移动/炮击/开战按 `activeSide` 与 `commander`（合作）校验；步损/撤退/挺进按 `pendingOwnerSide` 校验；AI 在服务端用 `shouldAiDrive` + `aiStep` 驱动。**人类自己的应手仍由人类提交。**
- **开局**：房主选模式/阵营/兵力分配/种子 → 建房；客人加入并连上 SSE；**双方都连上才建 `createGame` 并广播**，避免 AI 在没人看时先手。刷新/断线用本地 token 恢复。
- **安全边界**：静态文件白名单（只放行 `index.html` 与 `/src/` 的 js/css/图片，屏蔽 `.git`/`.vs`/test/docs/server）；CSP/`nosniff`；房间号 + token；建房/加入限流；请求体上限。**仅面向局域网 HTTP，不要直接映射公网**；远程加入的下一步是 Cloudflare Tunnel + Access（见路线图）。

## 三、已封版机制（改任何一条前先读完本节；调平衡改数值，勿动结构）

- **单位**：步兵 5-6/MP4、装甲 8-5/MP9、炮兵 防3/MP3/射程2-6（不进近战、不施ZOC）。步进翻面：受损面攻减半、防减半+1（步 3-4、装 4-4）；炮兵无受损面，损步即死。
- **CRT（2d6，8 行）**：1:3/1:2/1:1/1.5:1/2:1/3:1/4:1/5:1+。记号：C 无事；A1/A2 攻方损步；DR/DRR 守方退 1/2 格；DR1/DRR1 退+损 1 步；D1 守方原地损 1 步（1:1 行骰 6、7）；D2 守方损 2 步。2:1 行无 D2，3:1 才是歼灭门槛。比值四舍五入到最近行、平手取对攻方劣行、1:3 封底。**DR1/DRR1 含守方损步**（期望计算勿漏）。
- **地形＝CRT 行修正**（防御系数已废除）：森林/丘陵/城镇 −1 行；平原/道路 0；跨小河 −1、跨大河 −2（含桥）；叠加、1:3 封底。**迂回豁免**：同岸攻击力严格大于总量一半 → 无视河流行修正（仅路径型修正适用，地形格不适用）。
- **河流沿格边**：大河不可跨越（桥/渡口格边按道路 0.5MP，进攻仍 −2）；小河跨越耗该单位最大 MP 一半（攻方行修正 −1）；ZOC 与补给不跨大河（桥除外）；撤退不可跨大河、跨小河免费。
- **炮兵＝debuff 系统**：不走 CRT、无攻击力。必中压制（攻防 −1，持续到施放方下回合开始）；同格 2 门打同一目标 −2 封顶；每格炮兵 ≤2 门；被压制＝哑火；移动或射击二选一；不能打相邻；压制覆盖目标整格；炮击不触发放血。
- **双层 ZOC**：弱 ZOC（非炮兵周围 6 格）无任何效果；≥2 敌单位弱 ZOC 重叠 = 强 ZOC：踩入即停、已在强 ZOC 不可移入另一强 ZOC 格（挺进豁免）、撤退不可进、补给不可穿（该格有己方单位除外）。
- **补给**：回合开始判定；源 = 剧本指定（默认己方后方地图边）；补给线不可穿敌强 ZOC（有己方单位格除外）、不可跨大河（桥除外）；断供炮兵哑火，步兵装甲战力不变，但**缺补给单位参战即自损 1 步**（不论 CRT 结果，与 CRT 伤害叠加，仅缺补给方掉血）。补给状态只在回合开始刷新。
- **堆叠**：每格 3 点（步 1、装 2、炮 0 且每格 ≤2 门）。满格友军格可穿过不可停留；敌占格任何时候不可进。攻/防合并比值；A 结果攻方自选承担；D 步损守方任意分配可集中；应损步数超过可承受步数时按可承受数结算。
- **移动**：各单位完全独立行动（逐格扣自己的 MP，费用表见 terrain.js，跨小河=半最大MP）。满格可穿不可停。ZOC 判定用"当前结算可达图"。
- **撤退＝逐单位逐格**：守方玩家逐个挑撤退单位，退多格时逐格规划路线；每进一格判 ZOC（不走回头路）；堆叠只在终点判：终点超堆叠损 1 步并再撤 1 格（可连环）；某格无路可走 → 剩余格数各损 1 步原地停留；无主动放弃撤退。撤退不计地形 MP；摧毁覆盖撤退。
- **挺进＝多选+确认**：击退/歼灭后候选单位全列出（带堆叠点数），勾选合计 ≤3 点后确认；超限拒绝且停留挺进阶段可改选。AI 同样贪心填格。
- **回合流程（阶段制）**：攻方先行，双方同构：①回合开始处理（压制到期移除→补给判定）②移动阶段 ③战斗阶段——逐个宣告、逐一结算、顺序自定（炮击→突击 combo 依赖此）：CRT→步损分配→逐格撤退→放血→多选挺进 ④结束回合。阶段③存在守方应手（撤退目的地、步损分配）——**AI/联机必须支持应手交还**（见 ai-player.js 的 `pendingOwnerSide` / `shouldAiDrive`）。
- **合作模式（双人 PVE）**：兵力分配表开局勾选（均分预设 + 手动），整局有效；同侧回合内 P1/P2 各自操作自己的单位、顺序自由；**双确认门槛**（移动→战斗、战斗→结束回合两处，需双方就绪）；战斗/挺进面板合并同侧全部单位（借火力提示 + 归属标注）。
- **胜负**：12 回合，攻方占 3 目标点中 2 胜，歼灭分平局判定；一方全灭立即终局。

## 四、架构与文件

```
src/engine   规则引擎（确定性，mulberry32 种子，不碰 DOM）
  hex.js 坐标(odd-r)/rng.js 种子随机/terrain.js 地形表/crt.js 结果表
  state.js 单位与堆叠/move.js 移动可达图/retreat.js 撤退逐格路线
  zoc.js 双层ZOC/supply.js 补给/combat.js 战斗结算状态机/artillery.js 炮兵
  victory.js 胜负/engine.js 回合流程/setup.js 指挥官与对局模式
src/ai       evaluate.js 数值核心（CRT期望/距离场/格子价值）
             ai-player.js 步进式决策（aiStep → 'done'/'yield'/'continue'；攻守两角色）
src/net      protocol.js 联机消息/房间码；wire.js 状态序列化；client.js 浏览器 SSE 客户端
src/ui       app.js 控制器（点击/委托/门槛/AI驱动/联机指令路由）/panels.js 面板渲染
             setup-screen.js 开局设置/lan-session.js 建房加入等待/renderer.js Canvas 绘制
src/data     scenario.js 剧本《渡口》（15×11 地图、编制、目标点）
server/      rooms.js 权威房间/座位/AI/快照；http.js 静态白名单 + API + SSE；server.js 入口
tools/       public-server.mjs 一键公网：strict 8090 + cloudflared + 等就绪 + 打开域名
test         engine.test.js 规则自测（24 项）
             ui.test.js 假 DOM 点击链路自测（8 项：堆叠/撤退/AI 应手/联机指令/座位/准备等）
             net.test.js 联机服务自测（5 项：开局/权限/重连/AI先手/静态安全）
             lobby.test.js 大厅/恢复自测（2 项：创建加入开局交棒 / 刷新恢复）
start.bat / start-public.bat / test.bat / index.html / src/main.js
```

设计原则：引擎与 UI 严格分离；AI 与玩家走**同一套动作 API**；同种子同结果（联机权威端持有 rngState）；**模块拆分后必须整链路回归**（曾有拆分漏导入导致点敌格静默崩溃的教训，见调试节）。

## 五、当前状态（2026-11-25：交接问题已修复 + 局域网联机已实现）

- 自测：`engine.test.js` 24 项 + `ui.test.js` 8 项 + `net.test.js` 5 项 + `lobby.test.js` 2 项全过；`test.bat` / `npm test` 四套都跑。界面视觉、联机手感与局域网真实双机仍需人工在 `start.bat` 中确认（假 DOM/SSE 测试不渲染像素、也不替人点浏览器）。
- **本次新增：局域网联机（SSE + POST，权威服务端）**：`server/rooms.js` 管房间/座位/快照/AI，`server/http.js` 管静态白名单 + API + SSE，`src/net/*` 管协议/序列化/浏览器客户端，`src/ui/lan-session.js` 管建房/加入/等待/恢复，`app.js` 把动作分成"本地直调 / 联机发指令"两路。方案细节见第二节。
- **已修复 1（AI 应手不被驱动）**：`ai-player.js` 新增 `shouldAiDrive(state)`（pending 归属 AI 或轮到 AI 行动时为真）；`app.js` 的 `maybeKickAi` 在人类回合内也据此驱动 `aiStep`。每次 `aiStep` 后立即重判归属，只有 AI 仍拥有应手才继续/延迟；AI 的步损分配、逐格撤退、挺进都会自动完成，人类只处理属于自己的应手（如攻方挺进）。AI 抛错或步数超限会写日志、flash 并置 `ui.aiHalted` 熔断（"新对局"复位），不会同步重入死循环。联机时 AI 改由服务端驱动，客户端 `maybeKickAi` 直接禁用。
- **已修复 2（堆叠操作）**：`app.js` 补齐 `pickStack` 事件（此前 `panels.js` 渲染了按钮但 switch 没有对应 case，点堆叠栏无反应）；堆叠栏按"当前行动方 + 可操作单位"过滤；阶段/回合切换调用 `resetInteraction()` 清空选中、攻击预览与堆叠栏；已选中单位无法停进满格友军格时明确提示"堆叠已满，可穿不可停"。引擎本身正确：步兵5 移入步兵4 所在格、3 点封顶、满格穿越均已有自测。
- **已修复 3（AI 不选撤退/分配/挺进）**：与 1 同源，修完 1 后由 `ui.test.js` 的 U4 与 `engine.test.js` 的应手用例复测通过。注意：**人类自己拥有的应手仍由人类操作**，这是设计而非缺陷（例如人类攻方击退 AI 后选择是否挺进；联机时由 `pendingOwnerSide` 决定哪个座位提交）。
- **附带修复**：多单位撤退时人类守方原本无入口（`retreatBegin` 有 handler 但面板从未渲染按钮，而引擎只在撤退队列剩 1 个单位时自动开始）→ 现在结算面板先列出可撤退单位供点选，选定后再点地图绿色高亮格逐格撤退。另：`ui.aiRunning` 期间全部人类输入被拦截，AI 结算面板只读；联机非我方回合/应手时同理只读。
- **联机棋子/规则未动**：引擎、CRT、剧本数值未改；`net.test.js` 的 AI 对局与原有确定性冒烟均通过。
- 仍待办：Cloudflare Tunnel + 私有域名 + Access（让局域网外的朋友输网址加入）、AI 难度档位与应手动画、道路连续性等（见路线图）。

## 六、路线图

1. **远程联机（下一步）**：Cloudflare Tunnel（`cloudflared`）+ 自有域名 + 可选 Access；服务端 origin 固定用 **8090**（`DUKOU_STRICT_PORT=1` + `HOST=127.0.0.1`），SSE 已在响应头加 `X-Accel-Buffering: no` 并有 15s 心跳，上线前只需实测 CF 的 SSE 行为；若被代理缓冲/超时，再把 `src/net/client.js` 的传输换成 WebSocket（协议/房间/UI 不动，`server/rooms.js` 可复用）。配置与步骤见 [CLOUDFLARE.md](CLOUDFLARE.md)。
2. 平衡性调参：`src/engine/crt.js`（结果表）、`src/data/scenario.js`（编制/地形）。
3. 可选：观战/聊天、AI 难度档位（调 ai-player.js 的 W 权重表）、AI 应手动画（app.js 已有步进延迟）。

## 七、调试手段

- 全局错误钩子：`window.__lastErr`（main.js，含文件：行号）。
- 点击轨迹：`window.__clicks`（app.js 画布处理器，记录 phase/hex/ai/pending/mode/sel）。
- 对局状态与交互态：`window.game.getState()` / `window.game.getUi()`（main.js 持有 initApp 返回值；联机时 `getUi()` 里有 `online/seat/netBusy/ready/roomSeats/roomCode`）。
- 自测：`node test\engine.test.js`（规则 24）、`node test\ui.test.js`（假 DOM 点击链路 8）、`node test\net.test.js`（真实 HTTP+SSE 联机 5）、`node test\lobby.test.js`（假 DOM + 真服务的大厅创建/加入/恢复 2）。
- 服务器：`node server.js` 会打印本机与局域网地址；联机 API：`POST /api/create|join|resume|cmd|close`、`GET /api/events`（SSE）、`GET /api/network`；静态只放行 `index.html` 与 `/src/` 的 js/css/图片。
- 联机排障顺序：房主/客人是否都打开页面（双方 SSE 都连上才开局）→ 是否同一局域网、用控制台打印的 IP 而非 localhost → 浏览器控制台是否有 EventSource 403/404（token/房间过期）→ `net.test.js` 是否过。
- 工作区内的诊断脚本（若可访问 ZCode 工作区）：check-initapp.mjs（假 DOM 复现 initApp）、check-attack.mjs（战斗逐条件排查）、diag-ai-scores.mjs（AI 打分复现）。本仓库的 `test/ui.test.js` 就是 check-initapp.mjs 思路的常驻化版本。

## 八、已知简化

- 道路无连续性判定（可之字蹭相邻道路格）；攻方按剧本预先摆在南岸（非入场制）；炮击无视线判定；无空军/天气/弹坑（二期候选）。
- 联机：房间只在内存（服务重启即丢）；无聊天/观战/断线托管/房主迁移；身份仅靠房间号 + token（localStorage），token 丢失无法找回座位；同一座位只保留一个 SSE（新连接顶掉旧连接）；超过 30 分钟无连接且空闲的房间会被清理。以上都适合局域网 beta，公网化前需按路线图加 Access/限流/部署脚本。
