# 项目长期记忆 MEMORY.md

## 定位与结构
- 工作目录 = `C:/Users/yongguichen/WorkBuddy/OKX Trader/agent`（= `ROOT`/`AGENT_ROOT`，脚本里 `ROOT=dirname(dirname(__file__))`）。2026-09-15 起 git 仓库根就是 agent 本身（此前仓库根在父目录、文件带 `agent/` 前缀，已用 subtree split 重写历史并强推）。
- 远程：`origin https://github.com/virtualman333/okx_trader_agent.git`（分支 main）。无 gh CLI；Release 用 GitHub API + 凭据管理器里的 PAT。
- Python 脚本 `scripts/`（21 个）；运行时数据（.gitignore 排除，不入库）：`logs/`、`state/`、`ledger/`、`news/`、`reports/`、`data/store.json`、`data/observations.db`、`data/scalper_candles.db`、`electron/config.json`、`experts/*/knowledge/lessons.md`。
- `agent/` = TS 自主交易 Agent（LangGraph 多专家，5 分钟自驱）。拓扑 `collect → plan →(Send 并行)→ 专家 → adjudge → execute → archive`；graph.ts 只编排，main.ts 负责副作用（取数/下单/归档/报告）。
- 章程 `AGENT_TRADING_RULES.md` v2.1：L1 硬约束 10 条（仅 USDT 永续、杠杆≤5、live 只读、止损必挂、单笔风险≤2.5%、月度回撤 12% 熔断、归档只追加、clOrdId 幂等、禁双向、禁亏损加仓）；其余 L2 可裁量，偏离须写五项（baseline/actual/rationale/falsifier/riskDelta）。环境：仅 okx-demo 可交易，live 只读。

## 关键模块
- `store.ts`：`data/store.json`（模型/角色/MCP/settings/recentRounds），模块级缓存 → 常驻进程每轮开头 `reloadStore()`。
- `okx.ts`：不重写签名，复用 scripts 下 python（mcp_call/order_id/market_scan/archive_round）；runPy 必须用 python 解释器。
- `experts.ts` + `experts/<id>/expert.json`（knowledge/*.md、lessons.md）：可插拔专家，来源=文件→store.roles→内置兜底；8 个。每轮 `reflectExperts()` 写 lessons.md。
- `skills.ts` + `skills/<id>/skill.json`：同构可插拔（16 个），新增=放 JSON + RUNNERS 注册。
- `guard.ts`：L1 运行时硬校验，下单前必过；L1-1 只做 `USDT_RE=/USDT/i` + 本轮 knownInsts 白名单。
- `mcp.ts`：Windows 需 `cmd /c` 包装；写操作一律走 okx.ts 受控通道。`mcpPresets.ts` 6 个预设。`conn.close()` 必须 finally。
- `portfolio.ts`/`tools/mcpBridge.ts`：持仓汇总=LLM 调各交易所 MCP **只读**工具（kind=exchange）归并；`isReadOnlyMcpTool` 过滤写动词。
- `alert.ts`：告警写 `state/alerts.jsonl` + 邮件，30 分钟同 subject 去重。
- `obfuscate.ts`：LLM 前混淆标识（§SYM1§），只在 decide 路径。
- `report.ts`：HTML 报告，见下。

## 超短线策略系统
- 存储 `strategies/<id>/{strategy.py,meta.json}`，meta 含 `category`/`builtin?`；`src/strategies.ts` 管理 CRUD/apply/validate/generateStrategy；LLM 生成走 `llm.complete()`（system 注入接口规范+红线+模板）。
- 内置 7 个策略以 `BUILTIN_STRATEGIES` 为唯一事实源，`ensureBuiltins()` 还原磁盘镜像；内置不可删除/覆盖（UI 提供「复制为自定义」）。
- 策略接口：仅 `signal(ctx)->{direction:long|short|flat,reason,atr_mult?,rr?}`；ctx 传全量序列 + n + atr + price，无未来数据。加载 scripts/strategy_loader.py（兜底 flat），校验 scripts/strategy_check.py。
- `scalper.py` / `scalper_backtest.py` 同加 `--strategy <dir>`，同一定义源既回测也实盘；store.scalper.strategyId 空=内置趋势。
- 回测进度：python `--job-id` 向 stderr 逐行 `{"p","stage","msg"}`（stage: data/backtest → UI 映射中文）；main.ts spawn（PYTHONIOENCODING=utf-8、600s 看门狗、btJobs Map）→ `scalper:btEvent` 广播 + `scalper:btGet` 轮询兜底。
- 多周期/批量：本地只拉 1m K 线入 SQLite 缓存并聚合出 5m/15m/…；UI 策略×周期×时段笛卡尔展开，worker 池并行（上限 `min(CPU核,8)`，IPC `system:cpuCores`），结果进「批量回测矩阵」。Python `_db()` 必须 autocommit + WAL + busy_timeout，写走 `_tx()` BEGIN IMMEDIATE（否则多进程死锁）。
- 回测详情 + LLM 分析：`analyzeBacktest()`（非 decide 路径），IPC `scalper:btAnalyze`；内存 `btResults[key]` 缓存完整结果，sessionStorage 只存 summary。
- UI：`ScalperView.vue` 策略库面板 + 新建/编辑 modal；`BacktestView.vue` 顺序=策略库→控制台→批量矩阵→单跑结果。

## 报告
- 每轮归档后 LLM 生成 HTML：`reports/<round_id>/summary.html` + `<expert>.html`，`reports/index.html` 由 TS 生成；LLM 失败→纯数据兜底页。
- HTML 必须 `llm.complete()`（不能用 `decide()`：extractJson 被 `<style>{` 破坏）。
- IPC：`reports:rounds` / `reports:html` / `reports:regen`；`ReportsView.vue` 左列表右预览（含日报/周报 Markdown）。
- round_id 递增读 `j.round_no ?? j.round_count`（archive_round.py 写的是 round_count，读错会永远 R000001）。

## LLM 约定
- 两条路径：`decide()`（专家/调度/拍板/测试连接，非流式）vs `streamChat()`（对话/持仓汇总，流式）；只支持流式的网关 llm.ts 自动降级并记住模型 id。
- `DEFAULT_MAX_TOKENS=16000`（截断翻倍重试，封顶 128k）；`LANG_HINT` 要求中文思考；`onReasoning` 推观测页；fetch 3 分钟超时。

## 前端（ui/，Vite + Vue3 SFC）
- Electron 子窗口复用同一 UI，URL hash 路由（`#/win/kline?instId=`），主进程 `win:open` 按 key 复用；无桥接回退页内全屏弹窗。
- 产物 `dist/ui` 由 file:// 加载（vite base 必须 `./`）；`ui:dev`=vite(8088 自动探测端口)+Electron，统一 `127.0.0.1`（localhost→::1 会永不就绪）。
- UI 约定：颜色/圆角/阴影只在 `styles/main.css` 的 `:root`（+`[data-theme="dark"]`，localStorage 持久化）；高度用 flex，禁 `calc(100vh - 常数)`；撑满页用 `main:has(.x-page)` + `.x-page{flex:1;min-height:0}`；表头 sticky。菜单文案全中文。

## 编译与运行
- 三套 tsconfig 勿合并：src(ESM) / electron/main.ts(ESM NodeNext，`await import("file://")` 加载 dist/src) / electron/preload.ts(CJS→dist/preload，postbuild 贴 `{"type":"commonjs"}`)。
- `pnpm build`=三套 tsc+postbuild+vite build；`pnpm ui`=build+electron；`pnpm once` 跑一轮；`pnpm dev` 常驻。dry-run 只是模式。
- 轮次时间格式必须 `YYYY-MM-DD HH:MM:SS`（archive_round.py strptime 严格解析）。

## 踩过的坑
- **密钥不入库**：任何凭证走环境变量/本地配置，禁止写死（金十 token 曾入库过，已清理）。
- **IPC 克隆**：Vue Proxy 不能过 contextBridge → 在 `ui/lib/api.js` 的 `buildApi()` 复制成普通对象 + JSON 往返；**不能用 Proxy 包 `window.api`**。
- **preload 旧产物**：`resolvePreload()` 必须优先 `dist/preload/preload.js`。
- **Windows renameSync**：覆盖被占用 target 会 EPERM → 捕获后回退 `writeFileSync`。
- **spawn 空格路径**：把 `node_modules/.bin` 塞进 PATH，用裸命令名（`tsx.cmd`/`electron.cmd`）。
- **OKX 行情**：`volCcy24h` 是币数量（排序须 ×last）；tickSz 差异极大，价格/张数格式化要动态取 `instruments[inst].spec`。
- **git 中文编码**：命令行中文按 GBK 解码 → 必须 write UTF-8 消息文件 + `git -c i18n.commitEncoding=UTF-8 commit -F <file>`。
- **网络**：DNS 污染劫持 www.okx.com（脚本已做域名候选回退 + `OKX_PUBLIC_BASE` + 代理环境变量）；github push 偶发失败。
- **过拟合**：alpha 结论必须 ≥1 年样本（6 个月 PF1.62 → 1 年 PF0.92）。回测 `backtest.py` 必须用 `/market/history-candles` 分页（`/market/candles` 上限 300 根）。

## 用户偏好
- 完成开发后自动 `git add + commit` 并尝试 push（网络失败则本地提交即可）；提交信息简洁、中文编码正确。
- 不要每改一点就验证（截图/编译/接口测试）；仅关键运行时错误或明确要求时才验证。
- 脚本 vs 模型：确定性事务（指标/合约规格/clOrdId/下单参数/L1 校验/落盘）交给脚本；语义判断（选标的/方向/仓位止损/命名归一）交给模型。
