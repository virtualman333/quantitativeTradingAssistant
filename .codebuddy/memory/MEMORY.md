# 项目长期记忆 MEMORY.md

## 项目全貌（2026-09-02 全面通读后整理）

**单仓库双套系统**。git 仓库根在 `E:/ai_project/okx_trader_agent/`（注意：`agent/` 是子目录；在 agent 下执行 git 命令时路径显示为相对 agent）。

### A. 交易决策系统（父目录 Python 体系）
- 决策依据文档：`AGENT_TRADING_RULES.md`（章程 v2.0）、`DASHBOARD.md`（每轮自动更新面板）、`EVOLUTION.md`（复盘流水只追加）、`PLAYBOOK.md`（提案区）、`NEWS_SOURCES.md`（数据源实测）。
- 章程 v2.0 核心：**L1 硬约束 10 条不可裁量**（L1-1 仅 BTC/ETH 永续、L1-2 杠杆≤5、L1-3 live 只读、L1-4 止损必挂、L1-5 单笔风险≤2.5%、L1-6 月度回撤 12% 熔断、L1-7 归档只追加+偏离留痕、L1-8 clOrdId 幂等、L1-9 禁双向、L1-10 禁亏损加仓）；其余全部为 **L2 可裁量基准**，偏离须写 §0.3 五项（baseline/actual/rationale/falsifier/riskDelta），绩效由 §0.4 独立核算。
- `scripts/*.py`（16 个）：market_scan（行情/共振分）、news_fetch/news_verify/news_log（消息面，双源验证）、review_trade（复盘）、dashboard、archive_round（归档唯一入口只追加）、report/mail_report/mail_send（邮件）、mcp_call（MCP 降级通道，live 拒写）、order_id（clOrdId 生成）、deviation_stats、trade_round（--loop 5 分钟轮）、jin10_client、其他。
- 运行时数据（已被 .gitignore 排除入库）：`logs/`（YYYY-MM 日志 + rounds.jsonl 只追加）、`state/`（runtime.json、round_input_R*.json、decision、snapshots）、`ledger/trades.csv`、`news/news.jsonl`、`reports/`。
- **运行环境**：仅 okx-demo 模拟盘可交易；okx-live 只读监控已于 2026-09-02 停止监控。起始权益约 79,894 USDT。运行时（2026-09-02 22:15）round_no 19，1 个持仓，当日 -0.88%。

### B. agent/ —— TS 自主决策 Agent（当前工作区）
- **定位**：OKX 自主交易 Agent 常驻进程（LangGraph 多专家版），5 分钟自驱，替代"依赖聊天会话"方式。package.json name: okx-trader-agent。
- 拓扑：`collect → plan →(Send 并行)→ 专家 → adjudge → execute → archive`。graph.ts 只编排、main.ts 负责副作用（取数/下单/归档）。
- 源文件：src/{main,graph,okx,mcp,skills,experts,llm,store,orchestrator,types}.ts + electron/{main,preload}.ts + ui/index.html。
  - `store.ts`：JSON 本地持久化（agent/data/store.json）：模型/角色/MCP 配置/settings/recentRounds。**必须存在**（graph/llm/mcp/experts 都依赖它）——曾有 list 未显示但它存在。
  - `okx.ts`：不重写签名，复用父目录 python 脚本（mcp_call/order_id/market_scan/archive_round），runPy 用 python 解释器不能用 process.execPath（tsx 下是 node.exe）。
  - `mcp.ts`：MCP 客户端，Windows 垫片须 cmd /c 包装；写操作不走 MCP，一律走 okx.ts 受控通道。
  - `experts.ts`：内置 4 专家（trading/news/factor/risk），ReAct 简化版工具循环（≤4 次），支持从 store 动态角色覆盖。
  - `graph.ts`：LangGraph 图，Send 动态扇出专家，Annotation.Reducer 合并 opinions；execute/archive 为占位节点（实际在 main.ts）。
  - `electron/main.ts`：启动即拉起 agent 子进程（tsx src/main.ts），UI 直接可用；config.json 在 agent/electron/（旧简单配置）与 store.json（新，多模型）并存，注意两者未完全打通。
- **前端（2026-09-02 重写）**：Vite + Vue3 SFC 构建模式（`ui/`：main.js、App.vue、store/index.js、lib/{api,feedback,format}.js、components/*.vue、styles/main.css），产物 dist/ui 由 Electron 用 file:// 加载（vite base 必须 "./"）。`npm run ui:dev` = Vite dev server(5173) + Electron（UI_DEV=1）。
- **UI 约定**：所有颜色/圆角/阴影只在 `ui/styles/main.css` 的 `:root` 变量里定义，组件不写死色值；布局高度一律用 flex 分配（`#app` 列向 flex，main `flex:1;min-height:0`），禁止 `calc(100vh - 常数)` —— 页签换行时会错位。表格统一 `thead/tbody`，表头 sticky。
- **界面文案一律中文**（含 Electron 原生部分）：顶层菜单在 `electron/main.ts` 的 `buildMenu()`、右键菜单在 `attachContextMenu()`。Electron 的 `role` 只管行为不负责翻译，label 必须自己写中文；`app.name` 要在 app ready 前设置。
- **对话与工具**：src/chat.ts（ReAct 循环，事件 delta/tool_start/tool_result/confirm/done/error）+ src/tools/*（read_file/write_file/list_dir/search_files/web_search/web_fetch/get_status/list_rounds/run_skill/run_round/bash，路径沙箱 PROJECT_ROOT，write/bash/run_round 需确认）。llm.ts 的 streamChat 统一 OpenAI function-calling 与 Anthropic tool_use。
- **编译分三套**（勿合并）：tsconfig.json → src ESM；tsconfig.electron.json → electron/main.ts **ESM NodeNext**（主进程需 `await import("file://")` 动态加载 dist/src，CJS require 解析不了 file://）；tsconfig.preload.json → electron/preload.ts **CommonJS** 输出到 dist/preload（贴 `{"type":"commonjs"}`，见 scripts/postbuild.mjs）。preload 一旦是 ESM 就加载失败 → window.api 缺失 → 界面所有操作静默失效。
- 运行：`LLM_PROVIDER=mock pnpm run once`（联调）；deepseek 需 DEEPSEEK_API_KEY；`pnpm dev` 常驻；`pnpm ui` = build + electron。**dry-run 是模式不是单轮；只有 --once 才跑一轮退出。**
- 输出：每轮写 state/round_input_R*.json 再调 archive_round.py 落库；日志 logs/agent/YYYY-MM-DD.log；轮次时间格式必须 `YYYY-MM-DD HH:MM:SS`（archive_round.py strptime 严格解析，toLocaleString 会 ValueError）。

## 关键约定/偏好
- 用户：完成开发任务后自动 git add + commit + push（push 因网络可能失败，本地提交即可）。
- 用户：不要每改一点就验证/截图/编译检查；除非关键运行时错误或明确要求。
- 章程序言规定 AI 自主决策但 L1 边界不可逾越；`agent/` 的 TS 实现即该章程的工程化版本。
- git 状态注意：agent 下 electron/、ui/、src/experts/graph/mcp/orchestrator/skills/store.ts、pnpm-lock/workspace 仍未提交（截至 2026-09-02）；package.json/main.ts/okx.ts/tsconfig.json 有修改；guard.ts 已删除（风控职责移入 orchestrator/graph 提示词 + L1 边界在类型/执行层）。
