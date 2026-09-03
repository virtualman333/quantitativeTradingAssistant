# OKX 自主交易 Agent

OKX 自主交易专用 Agent：一个 **TypeScript 常驻进程**，每 5 分钟自驱完成一轮「取数 → 调度专家 → 汇总拍板 → 执行 → 归档」，不依赖人工聊天会话。

它是上层交易章程（`AGENT_TRADING_RULES.md`）的工程化实现——L1 硬约束在类型与执行层守住，其余裁量交给多专家 + 主 Agent。

## 与父目录的关系

本仓库是「单仓库双系统」中的 **B 系统**：

- **父目录（Python 体系）**：行情扫描 / 新闻采集 / 复盘 / 归档 / 邮件 等确定性脚本，`scripts/*.py`。
- **`agent/`（本目录，TS 体系）**：自主决策 Agent，通过复用父目录 Python 脚本完成取数与下单副作用。

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
agent/
├── src/                # 核心源码
│   ├── main.ts         # 主入口（副作用：取数/下单/归档）
│   ├── graph.ts        # LangGraph 编排图
│   ├── experts.ts      # 专家注册表 + 知识库 + 自动进化
│   ├── obfuscate.ts    # 提示词混淆层（防 LLM 提供方记录泄密）
│   ├── llm.ts          # 多模型适配（OpenAI 兼容 / Anthropic / mock）
│   ├── mcp.ts          # MCP 客户端（写操作不走 MCP）
│   ├── okx.ts          # 复用父目录 Python 脚本的受控通道
│   ├── store.ts        # JSON 本地持久化（data/store.json）
│   └── ...
├── experts/            # 专家定义（可插拔，见下）
│   └── <id>/
│       ├── expert.json       # 声明式专家定义
│       └── knowledge/        # 专家专属知识库（*.md）
├── electron/           # Electron 主进程 + preload（桌面壳）
├── ui/                 # Vite + Vue3 界面
├── scripts/            # 构建辅助（postbuild 等）
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
```

模型配置在界面「模型」页增删改（`data/store.json`）。`dry-run` 是**模式**不是单轮；只有 `--once` 才跑一轮就退出。

## 关键约定

- 时间格式必须 `YYYY-MM-DD HH:MM:SS`（`archive_round.py` 严格解析，`toLocaleString` 会报 ValueError）。
- 写操作一律走 `okx.ts` 受控通道（守 L1-3 live 只读），不直接经 MCP 写。
- 界面文案一律中文。
- `data/store.json` 必须存在（多模块依赖）；`.codebuddy/` 为项目数据目录，勿删。
