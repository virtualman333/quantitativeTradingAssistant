# 项目长期记忆 MEMORY.md

## 项目全貌（2026-09-02 全面通读后整理）

**agent 自包含**（2026-09-03 起）。git 仓库根仍在 `C:/Users/yongguichen/WorkBuddy/OKX Trader`，但父目录只保留 `.git`/`.gitignore`/`.workbuddy`/`agent/`；原父目录的 scripts/state/news/ledger/reports/logs/AGENT_TRADING_RULES.md/.mcp.json 已全部迁入 `agent/`。代码里 `ROOT`/`PROJECT_ROOT` 现在都指向 `agent/`（不再指向父目录）。

### A. 交易决策系统（原父目录 Python 体系，2026-09-03 已迁入 agent/）
- 决策依据文档：`AGENT_TRADING_RULES.md`（章程 v2.1）、`DASHBOARD.md`（每轮自动更新面板）、`EVOLUTION.md`（复盘流水只追加）、`PLAYBOOK.md`（提案区）、`NEWS_SOURCES.md`（数据源实测）。
- 章程 v2.1 核心：**L1 硬约束 10 条不可裁量**（L1-1 仅 USDT 计价永续、交易所支持的任意标的、L1-2 杠杆≤5、L1-3 live 只读、L1-4 止损必挂、L1-5 单笔风险≤2.5%、L1-6 月度回撤 12% 熔断、L1-7 归档只追加+偏离留痕、L1-8 clOrdId 幂等、L1-9 禁双向、L1-10 禁亏损加仓）；其余全部为 **L2 可裁量基准**，偏离须写 §0.3 五项（baseline/actual/rationale/falsifier/riskDelta），绩效由 §0.4 独立核算。**v2.1（2026-09-03）**：L1-1 由「仅 BTC/ETH」放开为「任意 USDT 永续」；§3 合约规格由写死 BTC/ETH 改为每轮从 OKX instruments 动态获取（ctVal/lotSz/minSz/tickSz）；方向自由强调多空平等（net 模式单一方向）。
- `agent/scripts/*.py`（21 个，2026-09-03 从父目录迁入、删了 `_probe_mcp.py`）：market_scan（行情/共振分）、news_fetch/news_verify/news_log/news_db（消息面，双源验证+SQLite 复用）、review_trade（复盘）、dashboard、archive_round（归档唯一入口只追加）、report/mail_report/mail_send（邮件）、mcp_call（MCP 降级通道，live 拒写）、order_id（clOrdId 生成）、deviation_stats、trade_round、jin10_client、backtest/factor_analysis/funding_backtest/cross_market（回测/因子/跨市场分析）、polymarket_sentiment（情绪）。
- 运行时数据（已被 .gitignore 排除入库）：`logs/`（YYYY-MM 日志 + rounds.jsonl 只追加）、`state/`（runtime.json、round_input_R*.json、decision、snapshots）、`ledger/trades.csv`、`news/news.jsonl`、`reports/`。
- **运行环境**：仅 okx-demo 模拟盘可交易；okx-live 只读监控已于 2026-09-02 停止监控。起始权益约 79,894 USDT。运行时（2026-09-02 22:15）round_no 19，1 个持仓，当日 -0.88%。

### B. agent/ —— TS 自主决策 Agent（当前工作区）
- **定位**：OKX 自主交易 Agent 常驻进程（LangGraph 多专家版），5 分钟自驱，替代"依赖聊天会话"方式。package.json name: okx-trader-agent。
- 拓扑：`collect → plan →(Send 并行)→ 专家 → adjudge → execute → archive`。graph.ts 只编排、main.ts 负责副作用（取数/下单/归档）。
- 源文件：src/{main,graph,okx,mcp,skills,experts,llm,store,orchestrator,types}.ts + electron/{main,preload}.ts + ui/index.html。
  - `store.ts`：JSON 本地持久化（agent/data/store.json）：模型/角色/MCP 配置/settings/recentRounds。**必须存在**（graph/llm/mcp/experts 都依赖它）——曾有 list 未显示但它存在。
  - `okx.ts`：不重写签名，复用 `agent/scripts/` 下 python 脚本（mcp_call/order_id/market_scan/archive_round），runPy 用 python 解释器不能用 process.execPath（tsx 下是 node.exe）。`ROOT` = `AGENT_ROOT`（store.ts 导出，向上探测 package.json+src）= agent 自身；脚本内 `ROOT=dirname(dirname(__file__))` 自动=agent，故 scripts 迁入后所有相对路径无需改 .py。
  - `mcp.ts`：MCP 客户端，Windows 垫片须 cmd /c 包装；写操作不走 MCP，一律走 okx.ts 受控通道。
  - `experts.ts`：**可插拔专家体系**——专家声明式定义在 `experts/<id>/expert.json`（systemPrompt/skills/mcpServers/enabled/alwaysInvoke），可带 `experts/<id>/knowledge/*.md` 领域经验 + `lessons.md`（每轮 `evolveExpert()` 自动追加进化）。`loadExpertDefs()` 扫描加载，`listExpertRoles()` 三层来源：文件 → store.roles 覆盖 → 内置 `EXPERTS` 兜底。现有 8 专家：trading/news/factor/risk/funding/onchain/sentiment/execution。ReAct 简化版工具循环（≤4 次）。新增专家=放一个 JSON，无需改 TS。
  - `graph.ts`：LangGraph 图，Send 动态扇出专家，Annotation.Reducer 合并 opinions；execute/archive 为占位节点（实际在 main.ts）。
  - `electron/main.ts`：启动即拉起 agent 子进程（tsx src/main.ts），UI 直接可用；config.json 在 agent/electron/（旧简单配置）与 store.json（新，多模型）并存，注意两者未完全打通。
- **前端（2026-09-02 重写）**：Vite + Vue3 SFC 构建模式（`ui/`：main.js、App.vue、store/index.js、lib/{api,feedback,format}.js、components/*.vue、styles/main.css），产物 dist/ui 由 Electron 用 file:// 加载（vite base 必须 "./"）。`npm run ui:dev` = Vite dev server(5173) + Electron（UI_DEV=1）。
- **UI 约定**：所有颜色/圆角/阴影只在 `ui/styles/main.css` 的 `:root` 变量里定义，组件不写死色值；布局高度一律用 flex 分配（`#app` 列向 flex，main `flex:1;min-height:0`），禁止 `calc(100vh - 常数)` —— 页签换行时会错位。表格统一 `thead/tbody`，表头 sticky。
- **LLM 两条调用路径，别混**：`decide()`（专家/调度/主 Agent/界面「测试连接」）是非流式请求，`streamChat()`（对话页）是流式。遇到「只支持流式」的网关（如 copilot.tencent.com/v2 的 Hy3，会返回 400 / 11101 "Non-stream chat request is currently not supported"）只有 decide 会挂。llm.ts 已内置自动回退：探测到该类响应即改走流式并记住该模型 id；默认 max_tokens=16000（推理模型思考链吃预算，正文被截断时翻倍重试兜底），三处 provider（OpenAI 兼容/Anthropic/Claude 原生）统一引用该常量。
- **界面文案一律中文**（含 Electron 原生部分）：顶层菜单在 `electron/main.ts` 的 `buildMenu()`、右键菜单在 `attachContextMenu()`。Electron 的 `role` 只管行为不负责翻译，label 必须自己写中文；`app.name` 要在 app ready 前设置。
- **对话与工具**：src/chat.ts（ReAct 循环，事件 delta/tool_start/tool_result/confirm/done/error）+ src/tools/*（read_file/write_file/list_dir/search_files/web_search/web_fetch/get_status/list_rounds/run_skill/run_round/bash，路径沙箱 PROJECT_ROOT，write/bash/run_round 需确认）。llm.ts 的 streamChat 统一 OpenAI function-calling 与 Anthropic tool_use。
- **编译分三套**（勿合并）：tsconfig.json → src ESM；tsconfig.electron.json → electron/main.ts **ESM NodeNext**（主进程需 `await import("file://")` 动态加载 dist/src，CJS require 解析不了 file://）；tsconfig.preload.json → electron/preload.ts **CommonJS** 输出到 dist/preload（贴 `{"type":"commonjs"}`，见 scripts/postbuild.mjs）。preload 一旦是 ESM 就加载失败 → window.api 缺失 → 界面所有操作静默失效。
- 运行：`LLM_PROVIDER=mock pnpm run once`（联调）；deepseek 需 DEEPSEEK_API_KEY；`pnpm dev` 常驻；`pnpm ui` = build + electron。**dry-run 是模式不是单轮；只有 --once 才跑一轮退出。**
- 输出：每轮写 state/round_input_R*.json 再调 archive_round.py 落库；日志 logs/agent/YYYY-MM-DD.log；轮次时间格式必须 `YYYY-MM-DD HH:MM:SS`（archive_round.py strptime 严格解析，toLocaleString 会 ValueError）。

## 观测链路（2026-09-03 定）
- 观测页 = 三来源：chat / portfolio（主进程内 wrapTrace 直发）+ agent（子进程轮次）。子进程经 `src/trace.ts` 向 stdout 写 `__TRACE__` 前缀 JSON 行（仅 AGENT_UI=1 时，spawnAgent 注入），electron/main.ts 的 `pipeAgentStdout()` 做**行缓冲**解析后广播 `llm:trace`。新增 LLM 调用点若要进观测，调用 trace()/traceRound() 即可；CLI 独立跑时 trace 静默，不污染 stdout。

## 多交易所持仓查看架构（2026-09-03 定）
- 持仓查看 = **LLM 调各交易所 MCP server 的只读工具** → 归并成统一 schema（`src/types.ts` 的 `UnifiedAccount/UnifiedPosition/UnifiedOrder/PortfolioSnapshot`）。UI 不再为某交易所写死字段；扩展多所 = 在 MCP 页加一个 server，不动 UI/引擎。
- 适配层即各交易所自己的 MCP server；agent 不写 per-exchange 代码。展示"两者都要"：结构化表格 + LLM 文字解读/风险。
- 桥接必须**只读**：`src/tools/mcpBridge.ts` 的 `isReadOnlyMcpTool` 过滤写动词，写操作一律走 okx.ts 受控通道（守 L1-3）。新增交易所 server 时务必确认它只暴露/LLM 只调只读工具。
- 汇总引擎 `src/portfolio.ts` 的 `summarizePortfolio()` 自带 ReAct 循环（复用 `llm.streamChat`），刻意与对话页 `chat.ts` 隔离，避免 MCP 工具污染全局对话工具集。

## 关键约定/偏好
- 用户：完成开发任务后自动 git add + commit + push（push 因网络可能失败，本地提交即可）。
- 用户：不要每改一点就验证/截图/编译检查；除非关键运行时错误或明确要求。
- 章程序言规定 AI 自主决策但 L1 边界不可逾越；`agent/` 的 TS 实现即该章程的工程化版本。
- **Electron IPC 坑（2026-09-03 修正修复位置）**：Vue `reactive`/`ref` 的 Proxy 参数在 `contextBridge` 传递（渲染进程→preload）时就被 `structuredClone` 抛 `An object could not be cloned`，发生在参数进 preload 之前。**正确修复在渲染进程侧** `ui/lib/api.js`：用 Proxy 统一包装 `window.api`，调用前先 `JSON.parse(JSON.stringify())` 拍平参数（undefined/函数原样、失败回退）。preload 的 `safeInvoke` 只是双保险，修不到 contextBridge 这层（旧记录说 safeInvoke 修复是错的）。
- **Electron preload 新旧产物坑（2026-09-03）**：`dist/electron/preload.js` 是早期配置的遗留旧产物（tsconfig.electron.json 现在只编 main.ts），缺新 API 会报 `api.xxx is not a function`。`resolvePreload()` 必须**优先选正规 CJS 产物 `dist/preload/preload.js`**，postbuild.mjs 会自动清理遗留文件。遇到「界面某功能报 not a function」先查加载到的 preload 是不是旧的（`npx tsc -p tsconfig.electron.json && node scripts/postbuild.mjs` 后重启应用）。
- **Windows renameSync 覆盖坑（2026-09-03）**：`fs.renameSync(tmp, target)` 在 Windows 下覆盖已存在的 target 时，若 target 被其他进程打开（哪怕只读）会报 `EPERM`（`fs.writeFileSync` 直写则没事）。本地 JSON 持久化（store.ts 的 saveStore 等）原子写必须捕获 `EPERM/EEXIST/EBUSY/EACCES` 回退直写，否则界面「保存」会偶发/持续失败。
- git 状态：2026-09-03 已全部提交并 push（b46e5c7），工作区干净。**仓库根在 `C:/Users/yongguichen/WorkBuddy/OKX Trader`**（agent 是子目录；注意 MEMORY 顶部记的 E 盘旧路径已失效）。`guard.ts` 已由「删除」改为「重新实现」——风控硬校验（L1 约束运行时拦截，见 src/guard.ts）。
- **动态合约规格 + 候选池（2026-09-03 v2.1）**：L1-1 已放开为任意 USDT 永续。执行层张数/价格必须用 `market_scan.py` 输出的 `instruments[inst].spec`（ctVal/lotSz/minSz/tickSz）动态计算，禁止硬编码面值或固定 `toFixed(2)` 价格（BTC tickSz=0.1、SATS tickSz=1e-12）。候选池按 24h 成交额排序时，OKX `volCcy24h` 是「币数量」须 `×last` 才是 USDT 成交额，否则 SATS/PEPE 等低价 meme 币会霸榜。guard L1-1 校验 = `USDT_RE=/USDT/i`（只守 USDT 计价）+ 本轮 knownInsts 白名单，**不写死交易所命名格式**。
- **脚本 vs 模型职责边界（2026-09-03 用户定）**：这是 Agent，语义/判断类的事交给模型，只有确定性的事交给脚本。**脚本**：行情与指标计算、合约规格抓取、clOrdId、下单固定参数、L1 风控硬校验、落盘归档。**模型**：解读行情、选标的选方向、仓位/止损参数，以及**把不同交易所的命名/字段语义归一成统一 TradeIntent**（币安 `BTCUSDT` == OKX `BTC-USDT-SWAP` 是模型的理解，不是脚本写死的映射表）。切换交易所时不做 per-exchange 脚本适配层，只换数据源 + 让白名单跟随数据源。
