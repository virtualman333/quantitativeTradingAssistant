# quantitativeTradingAssistant（量化交易助手）

> 仓库：<https://github.com/virtualman333/quantitativeTradingAssistant>

一个 **TypeScript 常驻进程**的 OKX 自主交易 Agent：每 5 分钟自驱完成一轮「取数 → 调度专家 → 汇总拍板 → 执行 → 归档」，不依赖人工聊天会话；配合 Electron + Vue3 桌面端，内置超短线策略库与多周期批量回测。

它是交易章程（`AGENT_TRADING_RULES.md`）的工程化实现——L1 硬约束在类型与执行层守住，其余裁量交给多专家 + 主 Agent。

## 仓库结构

本仓库**根目录即工程本体**，单仓库三层协作：

- **TS 体系（根 `src/`）**：自主决策 Agent（LangGraph 多专家编排）。
- **Python 体系（`scripts/`）**：行情扫描 / 新闻采集 / 复盘 / 归档 / 邮件等确定性脚本；TS 侧通过 `src/okx.ts` 复用它们完成取数与下单副作用。
- **桌面端（`electron/` + `ui/`）**：Electron 主进程 + Vite/Vue3 界面，多窗口（行情 / 持仓 / 日志 / 报告 / 回测 / 设置）。

运行时数据（`logs/`、`state/`、`ledger/`、`news/`、`reports/`、`data/store.json`）含真实账户信息，已在 `.gitignore` 中排除，不入库。

## 架构拓扑

```
collect → plan →(Send 并行扇出)→ 专家们 → adjudge → execute → archive
```

| 节点 | 职责 |
|------|------|
| `collect` | 取数：账户 + 行情（`main.ts`） |
| `plan` | 主 Agent 调度模块决定召唤哪些专家 |
| 专家们 | 并行给出观点（ReAct 简化工具循环） |
| `adjudge` | 主 Agent 汇总冲突、拍板 |
| `execute` | 执行下单（副作用在 `main.ts`，图内仅占位） |
| `archive` | 归档（只追加，`archive_round.py`） |

`graph.ts` 只做编排，`main.ts` 负责副作用，图可独立测试与回放。

## 目录结构

```
quantitativeTradingAssistant/
├── src/                # 核心源码
│   ├── main.ts         # 主入口（副作用：取数/下单/归档）
│   ├── graph.ts        # LangGraph 编排图
│   ├── experts.ts      # 专家注册表 + 知识库 + 自动进化
│   ├── obfuscate.ts    # 提示词混淆层（防 LLM 提供方记录泄密）
│   ├── llm.ts          # 多模型适配（OpenAI 兼容 / Anthropic / mock）
│   ├── mcp.ts          # MCP 客户端（写操作不走 MCP）
│   ├── okx.ts          # 复用 scripts/ 下 Python 脚本的受控通道
│   ├── store.ts        # JSON 本地持久化（data/store.json）
│   └── ...
├── experts/            # 专家定义（可插拔，见下）
│   └── <id>/
│       ├── expert.json       # 声明式专家定义
│       └── knowledge/        # 专家专属知识库（*.md）
├── electron/           # Electron 主进程 + preload（桌面壳）
├── ui/                 # Vite + Vue3 界面
├── strategies/         # 策略库（内置 + 自定义，strategy.py + meta.json）
├── skills/             # 技能定义（可插拔）
├── scripts/            # Python 确定性脚本（取数/归档/复盘/回测）
└── data/               # 运行时配置（store.json）
```

## 专家（可插拔）

专家定义外置在 `experts/<id>/expert.json`，**增删专家 = 增删目录**，无需改代码，重启即生效。

内置 8 个专家：

| id | 名称 | 是否必召 |
|----|------|----------|
| `trading` | 交易系统专家 | |
| `news` | 新闻资讯专家 | ✅（事件闸门，空仓也看） |
| `factor` | 因子评分专家 | |
| `risk` | 风控专家 | |
| `funding` | 资金费率与资金流专家 | |
| `onchain` | 链上数据专家 | |
| `sentiment` | 市场情绪与持仓结构专家 | |
| `execution` | 执行与滑点专家 | |

### 定义一个专家

```json
{
  "id": "funding",
  "name": "资金费率与资金流专家",
  "duty": "负责资金费率、资金流与持仓成本的边际信号",
  "systemPrompt": "你是【资金费率专家】……",
  "skills": ["market_scan", "read_charter"],
  "mcpServers": ["okx-trade-mcp"],
  "enabled": true,
  "alwaysInvoke": false
}
```

- `alwaysInvoke: true` = 每轮必召（如消息面事件闸门），不交给调度模块裁量。
- `skills` / `mcpServers` = 该专家的最小权限。

### 专家知识库 + 自动进化

- 每个专家 `knowledge/*.md` 是其专属经验库，运行时整体注入该专家的 system prompt。
- 每轮结束后，`evolveExpert()` 把该专家本轮的 `stance/confidence/summary` + 主 Agent 决策 + 执行结果**只追加**到 `knowledge/lessons.md`（超限自动裁剪最旧一半）。
- 预置的 `00-领域经验.md` 来自公开资料整理的领域最佳实践，可据实际数据反驳。

## 提示词混淆

LLM 提供方通常记录请求原文，为防策略泄露，`obfuscate.ts` 在每轮发送前把敏感标识（标的代码、项目名、章程、环境）替换为代号，返回结果再反向还原，上层无感知。

> 诚实边界：对外部 LLM「绝对保密」做不到（LLM 能懂 = 提供方能懂）。混淆的价值是①对抗关键词扫描 ②提高逆向/拼接成本 ③避免单条日志泄露完整策略。刻意不混淆 MCP 工具名（会破坏匹配）与风控阈值（会让约束失效）。

## 编译（三套 tsconfig，勿合并）

| 配置 | 输出 | 说明 |
|------|------|------|
| `tsconfig.json` | `dist/src` | src ESM |
| `tsconfig.electron.json` | `dist/electron` | 主进程 ESM NodeNext |
| `tsconfig.preload.json` | `dist/preload` | preload **CommonJS** |

⚠️ preload 一旦是 ESM 就加载失败 → `window.api` 缺失 → 界面所有操作静默失效。`resolvePreload()` 必须优先选 `dist/preload/preload.js`。

## 运行

```bash
pnpm install

# 联调（不联网、不耗 token）
LLM_PROVIDER=mock pnpm run once

# 真实决策一轮（需配置 API Key）
pnpm run once

# 常驻（5 分钟一轮）
pnpm run dev

# 只读数据+决策，不下单
pnpm run dry

# 桌面界面
pnpm run ui        # 构建 + Electron
pnpm run ui:dev    # Vite dev server + Electron（热更新）

# 自测（L1 硬约束回归，零额外依赖）
pnpm test
```

### 测试

`tests/guard.test.ts` 是 `src/guard.ts` 的回归测试——guard 是「LLM 意图 → 能否下单」之间唯一的硬闸门，任何一次重构若改坏了 5x 杠杆上限、止损必挂、禁双向/禁亏损加仓，都会在这里红灯。

`tests/scalper.test.ts` 锁的是**回测参数契约**（`src/scalper.ts` 的 `backtestArgv`）：用户看到的每个回测数字都来自这条 argv → `scripts/scalper_backtest.py` 的链路，参数漏拼不会报错、只会静默按默认值跑。这里同时有一条「反重复」断言，盯着 `backtestArgv` 是回测 argv 的**唯一来源**——此前同步版与 job 版各写了一份，同步版漏传 `--rr` / `--slippage-bps` / `--max-hold` / `--job-id`，即属此类漂移。

用 Node 22 内置 test runner + `tsx` loader 运行（`tsx` 负责把源码里的 `.js` 后缀解析回 `.ts`，否则只能测那些「零运行时 import」的模块），无需 jest/vitest。**改动 `guard.ts` 或章程 §1 的 L1 条款后，必须同步更新 guard 测试；改回测参数后必须同步更新 scalper 测试。**

`tests/riskbrief.test.ts` 与 `tests/riskbrief-ui.test.ts` 覆盖**每轮风控体检**（`src/riskbrief.ts` → 归档 payload 的 `risk_brief` → 总览页「本轮风控体检」面板）。其中 `riskbrief.test.ts` 用 100 组参数空间锁住「体检显示超限 ⟺ guard 判 L1-2 违规」，防的是体检口径与 guard 口径各算一套；`riskbrief-ui.test.ts` 则拿真的 `buildRiskBrief()` 输出喂给界面展示层（`ui/lib/riskbrief.js`），断言每个单元格零 NaN —— 界面读的是 payload 里的字段名，字段一改名界面**不会报错**、只会静默显示「—」，这条断言就是为它准备的。

`tests/scalperstats.test.ts` 覆盖**超短线战绩**（`src/scalperstats.ts` → `getScalperOverview().stats` → 超短线页「战绩」面板），以及展示层的曲线几何（`ui/lib/sparkline.js`）。它锁的核心是一条容易静默出错的语义：**「未同步」不等于「0 盈亏」**。`syncTrades()` 取不到平仓价时只能把单子标成 `closed` 而不写 `pnl`；旧汇总用 `Number(t.pnl ?? 0)` 兜底，于是这些单被按「刚好打平」计入总收益，还被算进样本数把胜率一起稀释。因此断言里特意包含「全是未同步的单 → 样本为 0、胜率为 `null`」与「分组/分桶计数守恒」两类守恒性用例。**改动 `netPnlOf()` 的口径或 `ScalperStats` 的字段名后，必须同步更新这份测试与「战绩」面板。**

`tests/scalperrange.test.ts` 覆盖**日期区间**（`rangeBounds()` / `filterByRange()` / `getScalperRange()` → 战绩面板与成交表共用同一区间）。断言分三类：**边界**（闭区间含首尾整天，`T23:59:59` 少写 `.999` 就会静默漏单，有专门一条盯着）、**同一区间**（表里的笔数 == 统计的分母 + 未同步 + 持仓中，且三段互不重叠的日区间之和 == 全量）、**不设区间不改变任何数字**（清空筛选不能让结果悄悄变一次；无法解析的日期当作「不设限」而不是「设成 0」）。另有一条**真实台账守恒**用例：直接拿 `data/scalper_trades.jsonl` 逐日取一次，样本与净盈亏之和必须等于全量 —— 合成数据看不出跨日边界的漏单。

`tests/priceformat.test.ts` 覆盖**界面价格展示口径**（`ui/lib/format.js::fmtPrice`）。价格和金额在界面上是两种东西，却长期共用 `fmtNum(v, 2)`：金额（权益 / 浮盈 / 手续费 / 名义价值）固定 2 位是对的，价格不行 —— 实测 OKX 当日 483 个 USDT 永续里，BTC 是 75815、SATS 是 `9.949e-9`，相差 12 个数量级。固定 2 位会让**价格 < 0.005 的 30 个标的**在持仓页与总览页的「开仓价 / 标记价 / 强平价 / 止损触发价」全部显示成 `0.00`；前一版局部实现的「≥0.01 给 5 位、否则给 8 位」又把 SATS 写成 `0.00000001`（只剩 1 位有效数字，同一页面里入场价与标记价看起来是同一个数）。这份测试锁四件事：**非零价格不得显示成 `0.00`**（含极端小值的兜底）、**不得出现科学计数法**（直接打印原始 number 就会有）、**有效数字 ≥ 4**、以及结构上 **`fmtPrice` 的定义只允许有一处**（此前 DashboardView / MarketView / KlineChart / KlineWindow 各写一份逐字相同的副本）+ **ui/ 下每个价格字段的渲染都必须走它**（扫描所有 `{{ }}` 插值）。金额字段仍走 `fmtNum`，两种口径不要互相复用。

## 界面：本轮风控体检

`ui/lib/riskbrief.js` 是纯函数展示层，`ui/components/DashboardView.vue` 的总览页把它渲染成两条预算用量条 + 逐笔明细（超限红 / 接近上限黄 / 充裕绿），并高亮章程 L2「单笔风险超 2% 需人工确认」的留痕提示。

两条硬规则：

- **界面不复制 guard 的 5x / 2.5% 常量**：界面上「/ 硬顶 5.0x」是从 payload 的「占上限百分比」反推出来的（`capOf`），章程改一次只需改 `guard.ts`。
- **「没算」与「充裕」必须区分**：`Number("")` 是 `0`，若不显式挡住空串，缺数据的笔会显示成绿色的「0% 上限 · 充裕」——即把最该警惕的情况装成最安全的样子。所有取值统一走 `num()`。

模型配置在界面「模型」页增删改（`data/store.json`）。`dry-run` 是**模式**不是单轮；只有 `--once` 才跑一轮就退出。

## 界面：超短线战绩

超短线页此前只有五个**绝对值**卡片（总净收益 / 已实现 / 未实现 / 手续费 / 笔数）。绝对值回答不了「这套参数该继续跑还是该关掉」，也回答不了「开了 LLM 介入到底有没有用」。`src/scalperstats.ts` 从同一份台账算出**分布**，随 `overview.stats` 下发，「战绩」面板负责显示：

- 四个指标：胜率（含赢/亏/平拆分）、盈亏比（盈利合计 ÷ 亏损合计）、每笔期望、最大回撤；
- 累计净收益曲线（`ui/lib/sparkline.js` 出几何，纯 SVG 零依赖）；
- **判断来源对比**：规则 vs LLM 各自的笔数 / 胜率 / 净盈亏 —— 「该不该开 LLM 介入」就看这两行；
- **循环为什么没开单**：把 184 条监测记录归成「策略观望 / 已有持仓等待 / 其它跳过 / 执行出错」四桶。

面板跟随页面上方的**日期区间**：填入起止日期后，成交明细表与全部战绩数字一起切到该区间，可用来对比「这段参数最近一周还行不行」。三条不能破的约定：

- **区间判定只有一份**（`src/scalperstats.ts` 的 `rangeBounds()` / `filterByRange()`）：主进程按同一份边界同时筛出明细与统计，界面**不再自己筛日期**。此前界面里有一份本地过滤，只作用于明细表，导致「表里剩 3 笔、战绩仍是全量胜率」——同一个筛选在同一个页面上有两种含义，而用户看不出差别。
- **边界是闭区间**，按**开单时间**、含首尾整天（`T23:59:59.999` 那一单必须算进来）。少写这个 `.999` 不会报错，只会静默漏掉区间末日晚间的单，所以测试里专门有一条断言盯着它。
- 区间统计**不联网**（`getScalperRange()` 只读本地台账）：界面每改一次日期都要重取，走 `getScalperOverview()` 那种会打交易所的路径不行。区间模式下监测记录读全量，避免「选到上周、看到的却全是今天的轮次」。

三条硬规则：

- **「未同步」必须区别于「0 盈亏」**：平仓价取不到的已平仓单，`netPnlOf()` 返回 `null`（不是 0），既不进金额也不进样本，只单独计数并在面板上说明「另有 N 笔未计入」。否则总收益被算歪、胜率被稀释，而用户看不出来。`settleTrade()` 在取不到价时会显式写 `pnlSynced: false`，让记录自带解释。
- **算不出来的比例显示「—」而不是 0**：样本为 0 时 `winRate` / `profitFactor` / `expectancy` 全是 `null`；样本里没有亏损时盈亏比也是 `null`（∞ 不是结论）。
- **净盈亏口径只有一份**：界面不聚合成交记录，全部来自 `src/scalperstats.ts`。界面若自己再算一遍，两边必然漂移。

区间一样遵守上面三条：区间内没有样本时，胜率 / 盈亏比 / 期望全部显示「—」而不是 0；区间内已平仓但未同步的单，仍然只计数、不进金额也不进样本。

`tests/scalperguard.test.ts` 覆盖**超短线路径的 L1 闸门**（`guardScalperConfig()` → `scalpOnce()`）。它锁三件事：① 拒与放行的分界**就是** `MAX_LEVERAGE` / `MAX_RISK_PCT` 这两个常量（所以断言里也不写死 5 / 2.5%）；② 主 Agent 路径与超短线路径对同一个 `riskPct` 必须给出同样的 L1-5 结论 —— 防两条路径各改各的；③ **源码形态**：开单入口是否还在调闸门、有没有人又自造一份杠杆上限、上限常量是否只在 `guard.ts` 定义一次、界面是否又写死选项表与上限数字。第三类断言是必要的：**被删掉的闸门不会让任何行为断言变红**。另有两条把常量钉回 `AGENT_TRADING_RULES.md` 原文（改常量而不改章程会红灯）。

`tests/price.test.ts` 覆盖**下单价格格式化**（`src/price.ts`），拿 OKX 全部 468 个 USDT 永续里真实存在的 11 种 tick 小数位（`0.1` 到 `1e-12`）当输入。除数值断言外还有一组**结构锁**：两个下单入口必须从 `price.ts` 取、不许各自再写一份 `fmtTick`、触发价必须经 `snappedSlTp` 产出。见「下单价格格式化」一节。

## 下单价格格式化（tickSz 网格）

OKX 的 OCO 触发价**必须是 tickSz 的整数倍**，否则直接拒单；拒单 = 止损失效 = 触碰章程 L1-4「每笔持仓必须存在止损」。这条逻辑此前在 `main.ts` 与 `scalper.ts` 里各写了一份、逐字相同，而且两份都是错的：

```ts
const decimals = Math.max(0, Math.min(8, Math.round(-Math.log10(tickSz))));
```

两个缺陷：

- **小数位被硬夹到 8 位**，而 OKX 的 tickSz 最小到 `1e-12`。用真实行情算（入口价取接口现价、止损距离 0.5%）：`PEPE` / `BONK` / `SHIB`（tickSz `1e-9`）的触发价被截成 8 位，落在网格外 → 拒单；`SATS`（tickSz `1e-12`）更糟，`toFixed(8)` 把价格写成 `0.00000001`，而入场价是 `9.949e-9` —— **止损止盈双双跑到入场价上方**，`SL < entry < TP` 这个基本语义被彻底破坏。小数位只能从 tickSz 的十进制写法里取，不能用 `log10` 反推再去夹。
- **就近取整会把止损吸回入场价**。止损距离不足半个 tick 时，`Math.round(sl / tickSz) * tickSz` 会落回入场价上 —— 那等于「挂了止损但其实没有止损」。真实场景 `GPRO-USDT-SWAP`：entry `1.31`、tickSz `0.01`、止损距离 0.2%，最近取整把 `1.30738` 吸回 `1.31`。

修法是收敛到 `src/price.ts` 这**唯一一份实现**（`toPlainDecimal` / `tickDecimals` / `roundToTick` / `fmtTick` / `snappedSlTp`），两个下单入口各自删掉本地那份并改为 import。三条不能破的约定：

- **小数位从 tickSz 自己的十进制写法里数**：既不是 `-log10(tickSz)`（对 `0.5` 这种非 10 的整数次幂会算出 0 位，把 `6.5` 写成 `7`），也不是「乘 `10^d` 之后是否近似整数」（对 `1e-12` 会在 `d=0` 就被判成整数）。
- **止损必须在入场价的亏损侧，宁可多推一个 tick**：`snappedSlTp()` 负责这一点，并在「止损被推到 0 以下」这类走不通的情况下返回 `null`。
- **走不通就拒绝下单，不退兜底价**：两个入口拿到 `null` 一律不开这一单并说明原因。挂一个「等于入场价」的止损比不挂更危险 —— 它看起来像有保护。
- 源码形态由 `tests/price.test.ts` 的**结构锁**盯着：被删掉的闸门不会让任何行为断言变红，所以「有没有人又自造一份 `fmtTick`」必须用文本断言锁住。

## 超短线路径的 L1 闸门

系统有**两条会下真单的路径**，章程 §L1 两条都得守：

| 路径 | 入口 | 下单参数来源 | 闸门 |
|------|------|--------------|------|
| 主 Agent | `src/main.ts` 的轮次执行 | LLM 意图（风险比例 / 止损距离） | `riskbrief.checkIntent()` → `guardIntent()` |
| 超短线 | `src/scalper.ts` 的 `scalpOnce()` | **用户在界面上直接配置** | `guardScalperConfig()` |

超短线这条路径此前一个 L1 检查都没有：界面提供 10x 杠杆选项（提示语自己写着「>5x 超过章程 L1-2 上限」）、单笔风险比例允许填到 10%（L1-5 硬顶是 2.5%），而 `scalper.ts` 只把杠杆 clamp 到 20 就照单执行 —— 章程「触碰 L1 → 一律不执行」在**第二条会下真单的路径**上等于不存在。现在：

- **每轮开单前先过闸门**，位置在取信号之前（不白打一次上游），也在 `--dry-run` 之前 —— 配置违规不是「这一轮不做」，演练也如实报出来。
- **上限只有一份**：`src/guard.ts` 的 `MAX_LEVERAGE` / `MAX_RISK_PCT`，两条路径共用；`scalper.ts` 里那个章程外的 `20` 已删掉。
- **界面不写死这两个数**：保存前调 `scalper:check` 拿主进程的裁决（与开单时的闸门是同一份 `guardScalperConfig`），超限直接拒绝保存并显示原因；杠杆下拉的选项由裁决返回的上限生成 —— 界面因此不可能放行一个开单时会被拒的配置。
- **存量非法配置不会被静默放行**：`data/store.json` 里若已存着 10x / 10%，页面顶部显示红色告警，开单时被拒，原因进本轮监测记录（`data/scalper_ticks.jsonl` → 战绩面板的「执行出错」桶）。
- L2 提示（单笔风险 > 2% 需人工确认）不阻断，但会跟在当轮结论字符串后面 —— 超短线是无人值守的循环，监测记录是唯一能让用户看到它的地方。

## 关键约定

- 时间格式必须 `YYYY-MM-DD HH:MM:SS`（`archive_round.py` 严格解析，`toLocaleString` 会报 ValueError）。
- 章程 §L1 的数值（杠杆 5x / 单笔风险 2.5%）**只在 `src/guard.ts` 定义一次**；要改上限必须先改 `AGENT_TRADING_RULES.md`，`tests/scalperguard.test.ts` 会比对两者。
- `state/month_state.json` 是 **L1-6 的分母**（`month_peak_equity` 只增不减，**抬高一次不可逆**）：**只有 `scripts/archive_round.py` 会写它**（全仓唯一调用 `month_risk.update_month_state()` 的地方）。看板 / 邮件走 `month_risk.month_metrics()` 的**只读**口径 —— 展示路径一律不得改动基准与峰值，否则一份手填的账户快照就能把真实回撤算成熔断。`tests/monthguard.test.ts` 用真跑 + 哈希比对钉住这一点。
- 下单价格格式化（tickSz 网格）**只在 `src/price.ts` 定义一次**，两个下单入口共用一个 `snappedSlTp()`；`tests/price.test.ts` 会检查有没有人又自造一份。
- 写操作一律走 `okx.ts` 受控通道（守 L1-3 live 只读），不直接经 MCP 写。
- 界面文案一律中文。
- `data/store.json` 必须存在（多模块依赖）；`.codebuddy/` 为项目数据目录，勿删。
