# 项目长期记忆 MEMORY.md

## 定位与结构（2026-09-03 起：agent 自包含）
- git 仓库根 `C:/Users/yongguichen/WorkBuddy/OKX Trader`，父目录只留 `.git`/`.gitignore`/`.workbuddy`/`agent/`；一切代码数据都在 `agent/`，`ROOT`/`PROJECT_ROOT`/`AGENT_ROOT` 均指向 agent 自身。
- Python 脚本在 `agent/scripts/`（21 个），脚本内 `ROOT=dirname(dirname(__file__))` 自动=agent，迁移后无需改 .py。
- 运行时数据（.gitignore 排除）：`logs/`（含 rounds.jsonl 只追加）、`state/`、`ledger/trades.csv`、`news/`、`reports/`、`data/store.json`。
- `agent/` = TS 自主交易 Agent（LangGraph 多专家，5 分钟自驱）。拓扑 `collect → plan →(Send 并行)→ 专家 → adjudge → execute → archive`；graph.ts 只编排，main.ts 负责副作用（取数/下单/归档/报告）。
- 章程 `AGENT_TRADING_RULES.md` v2.1：L1 硬约束 10 条（仅 USDT 永续任意标的、杠杆≤5、live 只读、止损必挂、单笔风险≤2.5%、月度回撤 12% 熔断、归档只追加+偏离留痕、clOrdId 幂等、禁双向、禁亏损加仓）；其余为 L2 可裁量，偏离须写五项（baseline/actual/rationale/falsifier/riskDelta）。
- 环境：仅 okx-demo 可交易，live 只读。

## 关键模块
- `store.ts`：JSON 持久化 `data/store.json`（模型/角色/MCP/settings/recentRounds），必须存在；`loadStore` 有模块级缓存，常驻进程需 `reloadStore()`（每轮开头调）。
- `okx.ts`：不重写签名，复用 scripts 下 python（mcp_call/order_id/market_scan/archive_round）；runPy 用 python 解释器（tsx 下 process.execPath 是 node）。
- `experts.ts` + `experts/<id>/expert.json`（+`knowledge/*.md`、`lessons.md`）：可插拔专家，三层来源=文件→store.roles 覆盖→内置兜底。8 专家：trading/news/factor/risk/funding/onchain/sentiment/execution。每轮 `reflectExperts()`（LLM 复盘提炼 ≤3 条可证伪教训）写 lessons.md。
- `skills.ts` + `skills/<id>/skill.json`：同构可插拔（16 个）。新增=放 JSON + 在 RUNNERS 注册 run。
- `guard.ts`：L1 运行时硬校验，下单前必过；L1-1 只做本质校验 `USDT_RE=/USDT/i` + 本轮 knownInsts 白名单，不写死交易所命名格式。
- `mcp.ts`：MCP 客户端，Windows 需 cmd /c 包装；写操作一律走 okx.ts 受控通道。`mcpPresets.ts` 内置 6 个预设（5 交易所 + 金十 data）。
- `portfolio.ts` / `tools/mcpBridge.ts`：持仓汇总=LLM 调各交易所 MCP **只读**工具（只桥接 kind=exchange），归并统一 schema。`isReadOnlyMcpTool` 过滤写动词。
- `alert.ts`：告警写 `state/alerts.jsonl` + 邮件，30 分钟同 subject 去重。
- `obfuscate.ts`：LLM 调用前混淆敏感标识（§SYM1§ 等），只在 decide 路径，不混 MCP 工具名与风控阈值。
- `report.ts`：轮次 HTML 报告（见下）。

## 超短线策略系统（2026-09-04 定）
- 产品形态（用户原话）：超短线回测支持进度显示 / LLM 分析改进 / 多策略——自己写策略脚本（用 LLM 写，内置规则约束），写完可回测或应用到超短线量化循环。
- 存储 `agent/strategies/<id>/{strategy.py,meta.json}`，meta 含 `category`（趋势跟踪/均值回归/突破通道/自定义）与 `builtin?`；TS 管理 src/strategies.ts（CRUD/apply/validate/generateStrategy/backfillMetaFromCode），LLM 生成/改写走 `llm.complete()`，system 注入接口规范+安全红线+参考模板。
- 内置策略（2026-09-05 起 7 个：斜率顺势/双均线/MACD/布林回归/RSI 反转/唐奇安突破/放量突破）以 `BUILTIN_STRATEGIES` 为唯一事实源，`ensureBuiltins()` 还原磁盘镜像（electron loadStrategies 每次先调）；内置不可删除、不可覆盖保存（UI 提供「复制为自定义」另存）。
- 策略=仅一个 `signal(ctx)->{direction:long|short|flat,reason,atr_mult?,rr?}`；ctx 传全量序列引用+n(当前根)+atr+price，无未来数据；脚本策略接口经 scripts/strategy_loader.py（call_signal 兜底 flat）；scripts/strategy_check.py 做语法/红线 import/冒烟 gate。
- scalper.py（实盘信号）与 scalper_backtest.py（回测）同加 `--strategy <dir>`：同一定义源既回测也实盘；store.scalper.strategyId 空=内置趋势（行为不变）。
- 回测 job+进度：scalper_backtest.py `--job-id` 向 stderr 周期写 {"p","stage","msg"}；main.ts scalper:btStart spawn（PYTHONIOENCODING=utf-8、240s 看门狗、btJobs Map），`scalper:btEvent` 广播全窗口，UI 进度条+轮询兜底 scalper:btGet。回测缓存库 data/scalper_candles.db（已 gitignore）。
- UI 在 ScalperView.vue：「策略库」面板（内置默认+自定义：回测/应用到循环/编辑/删除）+ 新建/编辑 modal（思路→LLM 生成→手改→保存并校验）；弹窗复用全局 `.modal/.box/.body/.foot`。

- **报告是 HTML**：每轮归档后由 LLM 生成（职责边界：语义/排版/解读交给模型，落盘与聚合留在 TS），输出 `reports/<round_id>/summary.html` + `<expert>.html`；`reports/index.html` 记录表由 TS 确定性生成。LLM 失败/mock → 纯数据兜底页，保证每轮都有详情。
- HTML 必须走 `llm.complete()`（不能用 `decide()`：其 `extractJson()` 会被 `<style>{...}` 花括号破坏）。
- `main.ts` 归档后调 `generateRoundReport(payload)`；启动时 `generateAllReports(false)` 补历史（不耗 token）。
- **界面多报告查看**：`reports:rounds`（列表 + `ensureRoundReports()` 补缺失兜底页 + indexPath）、`reports:html`（读全文，iframe srcdoc 渲染，路径越界校验）、`reports:regen`（用 LLM 重新生成某轮）。`ReportsView.vue` = 左列表（全部历史轮次，新的在前）+ 右预览（汇总/各角色 tab 切换），另有日报/周报（report.py 生成的 Markdown，文本预览）。
- round_id 递增：loadRuntime 读 `j.round_no ?? j.round_count`（archive_round.py 写的是 round_count，读错会导致永远 R000001）。

## LLM 调用约定
- 两条路径别混：`decide()`（专家/调度/拍板/测试连接，非流式）与 `streamChat()`（对话/持仓汇总，流式）。只支持流式的网关（如 copilot.tencent.com/v2 的 Hy3，400/11101）→ llm.ts 自动改走流式并记住模型 id。
- `DEFAULT_MAX_TOKENS=16000`（推理模型思考链吃预算，正文被截断时翻倍重试，封顶 128k）；三处 provider 统一引用。
- `LANG_HINT` 注入 system 要求中文思考；`onReasoning` 回调把推理流推给观测页。
- fetch 有 3 分钟超时（网关挂起会卡死整轮）。

## 前端（ui/，Vite + Vue3 SFC）
- **独立窗口（2026-09-03 定）**：Electron 子窗口复用同一套 UI，靠 URL hash 路由（`#/win/kline?instId=xxx`）；主进程 `win:open` 按 key 复用（`ui/lib/nav.js` 的 `openWin/openKlineWin/openDocWin`），无桥接时自动回退页内全屏弹窗（`fallbackWin`）。新增窗口类型=往 `WinFrame.vue` 的 VIEWS/TITLES 注册 + `ui/components/win/` 下加组件。
- 产物 `dist/ui` 由 Electron file:// 加载（vite base 必须 `./`）。`ui:dev` = vite(默认 8088，自动探测空闲端口) + Electron（UI_DEV=1）；三处统一 IPv4 `127.0.0.1`（Vite 默认 localhost 解析到 ::1 会导致 waitPort 永不就绪）。
- **UI 约定**：颜色/圆角/阴影只在 `ui/styles/main.css` 的 `:root`（浅色默认 + `[data-theme="dark"]`，localStorage 持久化），组件不写死色值（历史 `--c-*` 别名已补齐）；高度一律 flex 分配，禁止 `calc(100vh - 常数)`；需要撑满的页用 `main:has(.xxx-page)` + `.xxx-page{flex:1;min-height:0}`（log-page / rep-page）；表格统一 thead/tbody + 表头 sticky。
- 界面与 Electron 原生菜单文案一律中文（`role` 不负责翻译）。

## 编译与运行
- 三套 tsconfig 勿合并：`tsconfig.json`→src(ESM)；`tsconfig.electron.json`→electron/main.ts(ESM NodeNext，需 `await import("file://")` 加载 dist/src)；`tsconfig.preload.json`→electron/preload.ts(**CJS**→dist/preload，postbuild 贴 `{"type":"commonjs"}`)。
- `pnpm run build` = 三套 tsc + postbuild + vite build；`pnpm ui` = build + electron；`pnpm once`（一轮退出）；`pnpm dev` 常驻。dry-run 是模式，只有 `--once` 才跑一轮退出。
- 轮次时间格式必须 `YYYY-MM-DD HH:MM:SS`（archive_round.py strptime 严格解析）。

## 踩过的坑（改代码前先看）
- **IPC 克隆**：Vue Proxy 参数在 contextBridge 传参时即被 structuredClone 报错 → 修复在渲染进程 `ui/lib/api.js` 的 `buildApi()`（复制成新普通对象 + JSON 往返拍平）。**不能用 Proxy 包装 `window.api`**（冻结对象的 get 不变量会抛 TypeError）。
- **preload 旧产物**：`dist/electron/preload.js` 是遗留旧文件，`resolvePreload()` 须优先 `dist/preload/preload.js`。「api.xxx is not a function」先查是不是加载到旧 preload。
- **Windows renameSync**：覆盖被占用的 target 会 EPERM → 原子写须捕获 EPERM/EEXIST/EBUSY/EACCES 回退 `writeFileSync`。
- **spawn 空格路径**：绝对路径 + shell:true 在含空格目录（`OKX Trader`）会被拆断 → 统一把 `node_modules/.bin` 塞进 PATH，用裸命令名（`tsx.cmd`/`electron.cmd`）。
- **MCP 连接泄漏**：`conn.close()` 必须放 finally，否则 stdio 子进程每轮泄漏。
- **OKX 行情**：`volCcy24h` 是币数量，排序成交额须 ×last；tickSz 差异可达 10 个数量级，价格/张数格式化必须动态（用 market_scan 输出的 `instruments[inst].spec`）。
- **git 提交中文编码（2026-09-03 实测）**：本机把命令行里的中文按 GBK 解码（实测 node 收到"报告"已是"鎶ュ憡"），所以 `git commit -m "中文"` 与 `-F` 默认都会存成双重编码乱码。**唯一可靠写法**：先用 write_to_file 写 UTF-8 消息文件，再执行 `git -c i18n.commitEncoding=UTF-8 commit -F <file>`（校验：`node -e "console.log(Buffer.from('报告','utf8').toString('hex'))"` 应得 e68aa5e5918a，若为 e98eb6 则仍被误解码）。push 常因网络 reset 失败，本地提交即可。
- **网络**：DNS 污染会劫持 www.okx.com（CNAME awscn.okpool.top → 169.254.0.2）；脚本已做域名候选回退（www→aws→okx.com）+ `OKX_PUBLIC_BASE` + 代理环境变量。github push 也常连不上。
- **过拟合教训**：alpha 结论必须 ≥1 年样本（6 个月 43 笔的 PF 1.62 在 1 年 141 笔后变 PF 0.92）。

## Alpha 探索结论（2026-09-03 穷举后）
- 技术因子/均值回归/资金费率/跨市场 lead-lag/比价动量在 1 年尺度**全部无稳健 alpha**（BTC 完整策略 -24%）。ETH/BTC 比价 lb=24 曾显 PF 1.62，1 年样本推翻。
- 务实路线：稳定运行 + 辅助决策（监控告警、决策可解释），demo 盘积累真实数据 + review_trade 复盘。不盲目堆因子。
- 回测 `backtest.py` 必须用 `/market/history-candles` 分页（`/market/candles` 单次上限 300 根，会导致长窗口被截断成同一结果）。

## 用户偏好
- 完成开发任务后自动 `git add + commit`（+ 尝试 push，网络失败则本地提交即可）；提交信息简洁、中文编码正确。
- 不要每改一点就验证（截图/编译检查/接口测试）；仅关键运行时错误或明确要求时才验证。
- 脚本 vs 模型职责边界：确定性/不能错的事（行情指标、合约规格、clOrdId、下单参数、L1 校验、落盘）交给脚本；语义/判断/跨源归一（选标的、方向、仓位止损、交易所命名归一）交给模型。
