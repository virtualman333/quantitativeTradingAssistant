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

### 定义一个技能（**两步必须成对**）

技能 = `skills/<id>/skill.json`（元数据）+ `src/skills.ts` 的 `RUNNERS` 同名键（执行逻辑）。
只写一半**不会报错**，只会让这个技能静默消失：

| 只做了一半 | 后果（都不报错） |
|---|---|
| 有 `skill.json`、没有 `RUNNERS[id]` | 该技能被 `filter` 掉：专家 prompt、界面清单、`run_skill` 全看不见它 |
| 有 `RUNNERS[id]`、没有 `skill.json` | 死代码，永远走不到 |
| `skill.json` 的 `id` ≠ 所在目录名 | 按目录名找它的人找不到 |
| 整个 `skills/` 目录不在（安装版被打包漏掉） | 注册表为空，技能页显示「暂无 Skill」 |

扫描期发现的问题由 `skillRegistryIssues()` 收起来：界面**「Skill」页顶部直接列出来**，启动时也打日志；
`tests/skillregistry.test.ts` 拿**磁盘** `skill.json` 与**源码** `RUNNERS` 两份独立真值做两向对账。
`run_skill` 的能力清单同样从注册表现算（此前手抄了 6 个技能名，而注册表里有 15 个 ——
剩下 9 个在对话里等于不存在）。

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
- 每轮结束后，`reflectExperts()` 用 LLM 把本轮观点 / 主 Agent 决策 / 执行结果提炼成**可证伪的教训**，追加到 `knowledge/lessons.md`。
- 预置的 `00-领域经验.md` 来自公开资料整理的领域最佳实践，可据实际数据反驳。
- **界面上有「系统 → 经验库」页**：按专家看每个文件、直接改、直接删、新建自己的 .md。见「界面：经验库」。

这条链上原先有三处**静默**（现在都补上了落点，`tests/knowledge.test.ts` 逐条钉住）：

| 静默 | 后果 | 现在 |
|---|---|---|
| `evolveExpert(id)` 直接 `mkdir -p experts/<id>/knowledge`，而 `id` 来自 LLM 的 JSON 输出 | `../../x` 这种值能把文件写到仓库外面 | id 过白名单（`^[A-Za-z0-9_-]+$`）且解析后必须仍在 `experts/` 根之内 |
| 提示词让模型「无法归属时用 `main`」，而 `main` **不是任何专家** | 那些教训写进 `experts/main/knowledge/lessons.md`，**没有任何专家会读它** —— 自动进化的产出直接蒸发，日志却只说「提炼了 N 条教训」 | 统一落进共享桶 `_shared`，且 `loadKnowledge()` 会把共享桶注入给**每一个**专家 |
| 超上限裁掉最旧一半 / 注入超上限从中间砍断 | 文件头写着「只增不删」却删了；最后一句话被切成半句 | 裁剪在 `lessons.md` 顶部留一条记录并由 `evolveExpert()` 的返回值报出；注入改为**按文件**跳过并点名「以下文件本轮未注入」 |

`evolveExpert()` / `reflectExperts()` 的返回值现在会说明「有几条没归属、有没有文件被裁」，`main.ts` 把这两件事写进轮次日志 —— 复盘「提炼了几条」不再是唯一信息。

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

# 打包内容校验（运行期资源有没有进 app.asar）
pnpm run check:package
```

### 打包与安装版（**先看这条**）

`pnpm run dist` 打的是安装包，而**安装版和 dev 模式读的不是同一批文件**：dev 模式下 `AGENT_ROOT` 就是仓库根，
`skills / experts / scripts / strategies / AGENT_TRADING_RULES.md` 都在手边；安装版里 `AGENT_ROOT` 指向
`app.asar`，**只有 `build.files` 里声明过的路径才在包里**（2026-09-20 实测：修复前包内顶层只有
`node_modules / dist / package.json / src / ui`，上述资源一个都没有 → 技能页「暂无 Skill」、8 个专家全空、
所有 Python 能力找不到脚本，全程不报错）。

改完 `build.files` 之后跑 `pnpm run check:package` 复验：它现算磁盘上全部运行期只读资源，
先对 `build.files` 规则做静态匹配，若已打好包则再读 asar 头部做实证（缺一个就退出码非 0）。

⚠️ **安装版还差一步（尚未做）**：`state / data / logs / reports` 是运行期要**写**的目录，
而 asar 是只读的 —— 安装版需要一个可写根（如 `app.getPath("userData")`）。
dev 模式不受影响，所以本地怎么跑都是好的。

### 测试

`tests/guard.test.ts` 是 `src/guard.ts` 的回归测试——guard 是「LLM 意图 → 能否下单」之间唯一的硬闸门，任何一次重构若改坏了 5x 杠杆上限、止损必挂、禁双向/禁亏损加仓，都会在这里红灯。

`tests/stopprotect.test.ts` 覆盖 **L1-4 的执行侧**（`src/stopprotect.ts`）：决策函数三档边界（补挂 / 重试后平仓 / 挂不出去也要平仓）、止损存在性判据本身、以及全仓裸仓巡检 `findNakedPositions()`。它锁的两条最容易静默出错的语义：**「有挂单」不等于「有止损」**（一条只有止盈的委托不算止损）、**「不知道」不等于「有止损」**（取数失败时按 0 处理，反过来的话一次失败就能让裸仓被永久放过）。另有一半篇幅是结构锁：判据只有一份、`main.ts` 的巡检必须走它，反面扫描抓**两种**对手形状（`a.instId ===` 与 `algoOrders.map(a => a.inst)` + `Set.has` —— 后者 2026-09-21 实测从旧锁下面走了过去），并带一条自证防止「扫描恒绿 / 把合法投影误判红」。

`tests/scalper.test.ts` 锁的是**回测参数契约**（`src/scalper.ts` 的 `backtestArgv`）：用户看到的每个回测数字都来自这条 argv → `scripts/scalper_backtest.py` 的链路，参数漏拼不会报错、只会静默按默认值跑。这里同时有一条「反重复」断言，盯着 `backtestArgv` 是回测 argv 的**唯一来源**——此前同步版与 job 版各写了一份，同步版漏传 `--rr` / `--slippage-bps` / `--max-hold` / `--job-id`，即属此类漂移。

用 Node 22 内置 test runner + `tsx` loader 运行（`tsx` 负责把源码里的 `.js` 后缀解析回 `.ts`，否则只能测那些「零运行时 import」的模块），无需 jest/vitest。**改动 `guard.ts` 或章程 §1 的 L1 条款后，必须同步更新 guard 测试；改回测参数后必须同步更新 scalper 测试。**

`tests/riskbrief.test.ts` 与 `tests/riskbrief-ui.test.ts` 覆盖**每轮风控体检**（`src/riskbrief.ts` → 归档 payload 的 `risk_brief` → 总览页「本轮风控体检」面板）。其中 `riskbrief.test.ts` 用 100 组参数空间锁住「体检显示超限 ⟺ guard 判 L1-2 违规」，防的是体检口径与 guard 口径各算一套；`riskbrief-ui.test.ts` 则拿真的 `buildRiskBrief()` 输出喂给界面展示层（`ui/lib/riskbrief.js`），断言每个单元格零 NaN —— 界面读的是 payload 里的字段名，字段一改名界面**不会报错**、只会静默显示「—」，这条断言就是为它准备的。

`tests/scalperstats.test.ts` 覆盖**超短线战绩**（`src/scalperstats.ts` → `getScalperOverview().stats` → 超短线页「战绩」面板），以及展示层的曲线几何（`ui/lib/sparkline.js`）。它锁的核心是一条容易静默出错的语义：**「未同步」不等于「0 盈亏」**。`syncTrades()` 取不到平仓价时只能把单子标成 `closed` 而不写 `pnl`；旧汇总用 `Number(t.pnl ?? 0)` 兜底，于是这些单被按「刚好打平」计入总收益，还被算进样本数把胜率一起稀释。因此断言里特意包含「全是未同步的单 → 样本为 0、胜率为 `null`」与「分组/分桶计数守恒」两类守恒性用例。**改动 `netPnlOf()` 的口径或 `ScalperStats` 的字段名后，必须同步更新这份测试与「战绩」面板。**

`tests/scalperrange.test.ts` 覆盖**日期区间**（`rangeBounds()` / `filterByRange()` / `getScalperRange()` → 战绩面板与成交表共用同一区间）。断言分三类：**边界**（闭区间含首尾整天，`T23:59:59` 少写 `.999` 就会静默漏单，有专门一条盯着）、**同一区间**（表里的笔数 == 统计的分母 + 未同步 + 持仓中，且三段互不重叠的日区间之和 == 全量）、**不设区间不改变任何数字**（清空筛选不能让结果悄悄变一次；无法解析的日期当作「不设限」而不是「设成 0」）。另有一条**真实台账守恒**用例：直接拿 `data/scalper_trades.jsonl` 逐日取一次，样本与净盈亏之和必须等于全量 —— 合成数据看不出跨日边界的漏单。

`tests/priceformat.test.ts` 覆盖**界面价格展示口径**（`ui/lib/format.js::fmtPrice`）。价格和金额在界面上是两种东西，却长期共用 `fmtNum(v, 2)`：金额（权益 / 浮盈 / 手续费 / 名义价值）固定 2 位是对的，价格不行 —— 实测 OKX 当日 483 个 USDT 永续里，BTC 是 75815、SATS 是 `9.949e-9`，相差 12 个数量级。固定 2 位会让**价格 < 0.005 的 30 个标的**在持仓页与总览页的「开仓价 / 标记价 / 强平价 / 止损触发价」全部显示成 `0.00`；前一版局部实现的「≥0.01 给 5 位、否则给 8 位」又把 SATS 写成 `0.00000001`（只剩 1 位有效数字，同一页面里入场价与标记价看起来是同一个数）。这份测试锁四件事：**非零价格不得显示成 `0.00`**（含极端小值的兜底）、**不得出现科学计数法**（直接打印原始 number 就会有）、**有效数字 ≥ 4**、以及结构上 **`fmtPrice` 的定义只允许有一处**（此前 DashboardView / MarketView / KlineChart / KlineWindow 各写一份逐字相同的副本）+ **ui/ 下每个价格字段的渲染都必须走它**（扫描所有 `{{ }}` 插值）。金额字段仍走 `fmtNum`，两种口径不要互相复用。

`tests/knowledge.test.ts` 覆盖**专家知识库**（`src/experts.ts` 的 `knowledgeDir` / `knowledgeFilePath` / `evolveExpert` / `loadKnowledge` / `listKnowledgeBuckets`）。它把 experts 根指到临时目录（`QTA_EXPERTS_DIR`）后再真写文件，锁四件事：**路径边界**（id 与文件名都过白名单、解析后必须落在根之内）、**归属兜底**（未知 id 落进共享桶且真能被专家读到、也不在根外留目录）、**体积上限**（裁剪必须让文件变小且**在文件里留痕**、新教训不能被裁掉、注入超限按文件跳过并点名而不是半句截断）、**清单不变量**（非 `.md` 文件被标 `ignored`、没有 `expert.json` 的目录被标 `orphan`、空目录不入列）。每条都配了反向对照 —— 「全都抛错」的实现在负向断言下也能全绿，所以正向用例是这份测试的一半。

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

## 界面：经验库

「系统 → 经验库」页把 `experts/<id>/knowledge/` 整个暴露出来：左侧每个专家一个条目（另有共享桶与遗留目录），右侧列出该目录下的 `.md`，选中即可编辑、保存、删除、新建。

三处刻意显式化（原先都要么没有、要么静默）：

- **`lessons.md` 的体积条**：每到上限会**裁掉最旧一半**。页面上直接显示「当前 12.3 KB / 60 KB（20.5%）」，超过 75% 变黄 —— 想保住重要教训，趁早把它挪进自己新建的 `.md`。
- **不会被读到的文件**：目录里不是 `.md` 的文件（或文件名非法）**不会被注入**。这一页把它们列出来并标红，否则「拷进去就不管了」是个纯静默的失效。
- **没有对应专家的遗留目录**：例如旧提示词让模型兜底写入的 `main/` —— 目录在、`expert.json` 不在，写进去的教训没有任何专家会读。这类条目带红色「无专家」标签。

界面只按 `(bucket id, 文件名)` 访问，不收路径：主进程把两者交给 `src/experts.ts` 里的白名单校验与目录围栏，越界一律拒绝。

写操作与文件读写走 IPC：`knowledge:list` / `knowledge:read` / `knowledge:write` / `knowledge:delete`。知识库在**组装 system prompt 时**读取，所以改动**下一轮**或**下一次对话**才生效。

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

## 止损存在性判据（L1-4 第一句的回查）

章程 L1-4 第一句是「开仓成交后须在**同一轮内**完成止损挂单并回查 `swap_get_algo_orders(status=pending)` 确认」。这条回查回答的是三处地方**同一个问题**：`okx.confirmAlgo()`（开仓链回查）、`scalper.ts` 的巡检（方向一致时到底能不能 `skipped`）、`main.ts` 的裸仓告警。判据只有一份，在 `src/stopprotect.ts`。

这条判据此前的答案是错的，而且错在**比要回答的问题窄**：

- **只数条数，不看有没有止损触发价。** 一条只有止盈的委托（OCO 掉了一条腿、条件单、或任何 `slTriggerPx` 为空的形态）就让答案变成「有止损」—— 回查通过、巡检把理由写成「止损在挂」、裸仓告警一声不响，而**交易所侧根本没有止损**。这正是 `stopprotect.ts` 开头描述的那个静默（「本地台账照记 sl/tp、界面照显示持仓中，没有任何一处会说出这笔没有止损」）换了一层皮。
- **快照里的 `slTrigger` 是零读取方。** `buildSnapshot()` 把 `slTriggerPx` 重命名成 `slTrigger` 放进 `AlgoOrder`，但没有任何一处判据读它（只被 `JSON.stringify` 带进提示词）。只认一种拼写的话，另一种形态喂进来会**恒判「没有止损」** —— 认错一个键，要么凭空多出一个裸仓去平仓，要么把真裸仓看漏。
- **`main.ts` 里还藏着一份手写的。** 先把算法单 `.map()` 成标的名、再 `Set.has()` 问「该标的有挂单吗」 —— 与 `pendingStopsFor` 是同一件事的第二个主场，而且**绕过了当时的结构锁**：那条锁的反面扫描只认 `a.instId ===` 这种写法，`.map(a => a.inst)` + `Set.has` 换了个形状就从锁下面走过去了。

现在：

- **只认带止损触发价的委托。** `pendingStopsFor()` 的语义是「该标的有几条**带止损触发价**的 pending 委托」—— `""` / `null` / `"0"` / 负数 / 非数字一律不算；`slOrdPx=-1`（市价执行）也不是触发价，那是「怎么执行」不是「有没有止损」。
- **两种拼写都认**：`instId` / `slTriggerPx`（交易所原始返回）与 `inst` / `slTrigger`（快照重命名后）。
- **裸仓巡检逐持仓做**（`findNakedPositions()`）：章程说的是「**每笔持仓**必须存在止损」，所以不能只看「账户里有没有算法单」这个全局面 —— A 标的挂了止盈、B 标的连单都没有，按全局面看是「有单」，按持仓面看是两笔裸仓。张数为 0 的持仓不算裸仓（那是「没有持仓」，不是「有持仓没止损」）。
- **理由把现场说清。**「该标的没有任何 pending 算法单」与「该标的挂着 1 条 pending 算法单，但没有一条带止损触发价（例如只挂了止盈）」是两种不同的现场，要人做的事也不一样。
- **判据只有一份**，且由 `tests/stopprotect.test.ts` 盯着：反面扫描抓两种对手形状，另有自证保证「合成的对手形状必须被抓到、合法的投影（`positions.map(p => p.inst)`）不许误伤」。

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

## 实盘账户只读（L1-3）的代码级闸门

章程 §1 的十条 L1 里，**只有 L1-3 直接管着用户账户里的真钱**：

> 严禁调用任何实盘下单/平仓/改单接口。`scripts/mcp_call.py --profile live` 为代码级拒写（返回 `REFUSED`、exit 2、**不产生网络请求**），不得以任何方式绕过

这句话此前**一条断言都没有**（`tests/` 里对 `mcp_call` / `REFUSED` 的引用数 = 0）。实查暴露三处对不上：

| 对不上的地方 | 后果 |
|---|---|
| `READ_TOOLS` 定义之后**从来没有被引用过**，注释却写着「用于 `--read-only` 之外的二次校验」 | 声称存在的第二道闸门其实不存在，只剩服务端 `--read-only` 一层 |
| `WRITE_TOOLS` 里写的是 `swap_cancel_algo_order`（单数），而真实调用点（`src/okx.ts` 的 `cancelAlgoOrders()`）用的是 `swap_cancel_algo_orders`（复数） | 手抄的黑名单漂了，那个**撤单**工具在只读模式下**一路放行** |
| 写工具的拒绝判在 `open_session()` **之后** | 被拒的请求仍会先起一个 MCP 服务端并完成 initialize 握手 —— 章程里「不产生网络请求」那半句是假的 |

现在的形态（`tests/mcplive.test.ts` 逐条钉住）：

- **准入是正向白名单**：未加 `--allow-write` 时工具名必须命中 `READ_TOOLS`，**不在名单里一律拒绝**。默认值反过来之后新工具默认安全；`WRITE_TOOLS` 退居二线，只负责把理由说得更准（「这是写操作，需要 `--allow-write`」比「不在白名单里」有用）。
- **全部拒绝前置到 `precheck()`**，位置在 `open_session()` 之前 —— 「不产生网络请求」因此是结构性成立的，不靠服务端配合。
- **两张表必须非空且互斥**，`assert_tool_tables()` 不满足直接抛；而且 `main()` 里真的调它（定义得再好，不接线等于没有 —— 这一条也有断言）。
- **源码调用过的每个工具名都必须在两张表之一**（现算对账）：扫 `src/**/*.ts` 的 `mcpCall(...)` 与 `scripts/**/*.py` 的 `--tool`，少一个就红。单数/复数那处漂移正是它会红的场景。
- 测试用**假 `okx-trade-mcp` 垫片**证明「服务端到底被起过没有」，全程不碰真 server、不发任何请求；另配一条反向对照（白名单内的只读工具**必须**真的起进程），否则「没被起进程」这条断言在任何实现下都会绿。

**加新工具时的正确动作**：把它登记进 `scripts/mcp_call.py` 的 `READ_TOOLS` 或 `WRITE_TOOLS`。不登记的话它会被默认拒绝 —— 功能会哑掉，但不会出安全问题。

## 关键约定

- 时间格式必须 `YYYY-MM-DD HH:MM:SS`（`archive_round.py` 严格解析，`toLocaleString` 会报 ValueError）。
- 章程 §L1 的数值（杠杆 5x / 单笔风险 2.5%）**只在 `src/guard.ts` 定义一次**；要改上限必须先改 `AGENT_TRADING_RULES.md`，`tests/scalperguard.test.ts` 会比对两者。
- `state/month_state.json` 是 **L1-6 的分母**（`month_peak_equity` 只增不减，**抬高一次不可逆**）：**代码路径上只有 `scripts/archive_round.py` 会写它**（全仓唯一调用 `month_risk.update_month_state()` 的地方）。看板 / 邮件走 `month_risk.month_metrics()` 的**只读**口径 —— 展示路径一律不得改动基准与峰值，否则一份手填的账户快照就能把真实回撤算成熔断。`tests/monthguard.test.ts` 用真跑 + 哈希比对钉住这一点。
  - 上面这句原先写成「**只有** `archive_round.py` 会写它」，而它只被源码断言扛着 —— 源码断言看不见**模型手里的通用写工具**：`write_file` 曾能把 `state/month_state.json` 覆盖成任意内容（抬高峰值 = 误熔断，清零 = 该熔断不熔断，两条都不可逆），唯一的拦阻是「危险工具要用户点一次确认」，而对话框里给出的正是这条路径与内容预览。**所以边界补在了工具层**：判据与账本的载体目录 **读得了、写不了**（`src/tools/paths.ts` 的 `DENY_WRITE_DIRS`，含 Windows 上的 `State/` 大小写变体），`tests/toolsguard.test.ts` 真调 `write_file` 钉住「被拒 + 磁盘逐字节不变」，并配了反向对照（守卫不许把正常写入堵死）。
    - ⚠ 这张表最初是**手抄的两个名字** `["state","ledger"]`，而文档那句「写操作禁止进入风控判据与账本的载体」当时只对了一半：`logs/rounds.jsonl`（章程 L1-7 只追加归档）、`data/scalper_trades.jsonl` 与 `data/scalper_ticks.jsonl`（战绩面板与「执行出错」桶的唯一来源）、`data/store.json`、`news/news.jsonl`（只追加审计流水）同样是账本，**通用写工具当时能直接覆盖它们**（已实测复现）。现在禁区扩到 `state/ ledger/ logs/ data/ news/`，且覆盖面**不再靠这张表自己说了算**：`tests/pathguard.test.ts` 会现算两遍 —— 「磁盘上一级目录里哪些有 json/jsonl/csv」与「源码里以 `<目录>/x.json|jsonl|csv` 引用过哪些目录」—— 要求每一个都被禁区覆盖，或在**声明式例外表**里写明理由（`experts/ skills/ strategies/` 是用户可编辑的定义、`scripts/.smtp_local.json` 是凭证），少一个就红。
  - 残余缺口（刻意保留，不假装堵上）：`bash` 工具无法从命令文本上封死（`echo > state/...`、`python -c ...` 都在它能力范围内）。它同样是危险工具、逐次人工确认，属于用户明确授权后的最后手段。
- `state/` 下的 JSON **不是缓存，是判据的载体**，读写一律走 `scripts/jsonstore.py`：写用 `atomic_write_json()`，读用 `read_json_state()`（`(data, error)` 两值，必须显式处理）或 `read_json_state_strict()`（读不出来直接抛 `StateUnreadable`）。
  - **顶层形状只在 `jsonstore.STATE_SHAPES` 里登记一次**（按文件名，支持 `*`），调用方**不传** `expect=`（传了当场 `ValueError`），未知路径抛 `UnregisteredState` **不猜**。判据是「文件自己的属性」而不是「调用方的属性」——早先靠调用点各传一份，漏传默认 `dict` 会把一份**顶层是列表**的完好账判成「损坏」，再被 `quarantine_broken()` 搬成 `.corrupt-*`：净效果是峰值 / 幂等登记表**静默重置**，而全程没有一个字提到「其实是形状判错了」。`tests/stateshapes.test.ts` 盯住三件事：形状对了不传也读得出来、未知路径不猜、以及**源码里 `state/` 下的每个 `.json` 名字要么在注册表里、要么在例外表里写明理由**（反向也查：表里有源码已不用的条目要收紧）。
  - 两本「读 → 改 → 写」的账走**严格**那条：`state/order_idem_<轮次>.json`（本轮哪几笔单已经发过 → 章程 §6.1 幂等、L1-8 clOrdId 唯一性）与 `state/reviewed_trades.json`（哪几笔交易已经复盘过、哪条归因已提过案）。**账读不出来就拒绝本次写**（退出码 3），原文件保持不动交出题人处置 —— 「读坏了当空的然后再写回去」等于把整本账悄悄清空：登记表清空会重复发单，复盘账本清空会让已复盘的交易重新变成「待复盘」、提案反复生成。
  - `tests/statewriters.test.ts` 把这两条做成**真跑 CLI** 的行为断言（半截文件 → 拒绝 + 原文件逐字节不变；文件不存在 → 照常工作），并用 glob 现算盯住「`scripts/` 里谁还可以有裸 `json.dump`」（棘轮表，只减不增）。
- 工具层边界（`src/tools/paths.ts`）：一切文件操作限制在仓库根内，`.git` / 密钥类文件不可访问，**另外判据与账本的载体目录只读不写**（`DENY_WRITE_DIRS` = `state/ ledger/ logs/ data/ news/`，各有带风控语义的写入口：`state/` 走 `jsonstore` 的原子写、轮次账本与 `logs/rounds.jsonl` 走 `archive_round.py` 的只追加、`news/news.jsonl` 走 `news_db.py`）。越界一律拒绝且**报错里点名该走哪个入口**，否则模型会反复重试同一个被拒的写入。**禁区清单与仓库实际的载体目录是否对得上由 `tests/pathguard.test.ts` 现算核对**，不靠人抄。
- 下单价格格式化（tickSz 网格）**只在 `src/price.ts` 定义一次**，两个下单入口共用一个 `snappedSlTp()`；`tests/price.test.ts` 会检查有没有人又自造一份。
- 写操作一律走 `okx.ts` 受控通道（守 L1-3 live 只读），不直接经 MCP 写。**L1-3 的代码级闸门在 `scripts/mcp_call.py` 的 `precheck()`，准入是正向白名单**（不在 `READ_TOOLS` 里就拒绝），拒绝一律早于起子进程；见「实盘账户只读（L1-3）的代码级闸门」。
- 界面文案一律中文。
- 专家经验库（`experts/<id>/knowledge/`）的**写入去向是校验过的**：`knowledgeDir()` / `knowledgeFilePath()` 只收白名单内的 id 与 `.md` 文件名，且解析后必须仍在 `experts/` 根之内。归属不明的教训进共享桶 `_shared`（所有专家都读），**不许造出没有对应专家的目录** —— 那等于把教训写进没人读的地方。
- `data/store.json` 必须存在（多模块依赖）；`.codebuddy/` 为项目数据目录，勿删。
