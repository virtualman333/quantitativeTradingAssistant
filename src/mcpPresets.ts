/**
 * mcpPresets.ts —— 内置交易所 MCP 预设目录（一键安装配置）
 *
 * 每个预设描述一个可一键安装的交易所 MCP server：
 *   - installPackages：npm 全局安装的包名列表（直接以二进制启动的 server 用，如 OKX）；
 *     为空则用 npx 启动，首次连接时由 npx 自动下载（免全局安装）。
 *   - command / args：安装后如何以 stdio 方式启动。
 *   - envVars：需要用户填写的 API 凭证环境变量（写入 store.json，仅本地保存）。
 *
 * 章程约束（L1-3）：本项目对交易所 MCP 只做「只读」桥接，下单/撤单等写操作
 * 一律走 okx.ts 受控通道，绝不通过 MCP 暴露给 LLM。完整 server 里的写工具
 * 会在 src/tools/mcpBridge.ts 被 isReadOnlyMcpTool() 过滤掉。
 */

export interface McpEnvVar {
  /** 环境变量名 */
  key: string;
  /** 表单里的中文标签 */
  label: string;
  /** 是否必填 */
  required: boolean;
  /** 输入框占位提示 */
  placeholder?: string;
}

export interface McpPreset {
  /** server id（与 store.mcpServers[].id 对应） */
  id: string;
  name: string;
  /** 交易所短标识（界面 logo 用首字符） */
  exchange: string;
  description: string;
  /** npm 全局安装的包；为空则 npx 运行时自装 */
  installPackages: string[];
  command: string;
  args: string[];
  /** Windows 下是否用 cmd /c 包装（npm 全局 .cmd / npx 垫片必须） */
  windowsCmdWrap: boolean;
  envVars: McpEnvVar[];
  /** 安装弹窗里的补充说明 */
  note?: string;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "okx-trade-mcp",
    name: "OKX 交易 MCP",
    exchange: "OKX",
    description: "OKX 行情 / 账户 / 持仓 / 下单，社区 okx-trade-mcp（本项目默认）。",
    installPackages: ["okx-trade-mcp"],
    command: "okx-trade-mcp",
    args: ["--modules", "all"],
    windowsCmdWrap: true,
    envVars: [
      { key: "OKX_API_KEY", label: "API Key", required: false, placeholder: "只读行情可留空" },
      { key: "OKX_SECRET_KEY", label: "Secret Key", required: false },
      { key: "OKX_PASSPHRASE", label: "Passphrase", required: false },
    ],
    note: "只读行情无需凭证；需要账户/持仓时填 API 凭证（建议仅开读取权限）。",
  },
  {
    id: "binance-mcp",
    name: "Binance 交易 MCP",
    exchange: "Binance",
    description: "币安现货/合约行情、账户、持仓、下单（社区 binance-mcp-server）。",
    installPackages: [],
    command: "npx",
    args: ["-y", "binance-mcp-server"],
    windowsCmdWrap: true,
    envVars: [
      { key: "BINANCE_API_KEY", label: "API Key", required: true },
      { key: "BINANCE_API_SECRET", label: "Secret Key", required: true },
    ],
    note: "凭证在币安后台创建，建议仅开启读取 / 现货权限。",
  },
  {
    id: "bybit-mcp",
    name: "Bybit 交易 MCP",
    exchange: "Bybit",
    description: "Bybit 行情、账户、持仓、下单（官方 @bybit-exchange/mcp-server）。",
    installPackages: [],
    command: "npx",
    args: ["-y", "@bybit-exchange/mcp-server"],
    windowsCmdWrap: true,
    envVars: [
      { key: "BYBIT_API_KEY", label: "API Key", required: true },
      { key: "BYBIT_API_SECRET", label: "Secret Key", required: true },
      { key: "BYBIT_TESTNET", label: "测试网", required: false, placeholder: "true=测试网，留空=主网" },
    ],
  },
  {
    id: "gate-mcp",
    name: "Gate.io 交易 MCP",
    exchange: "Gate",
    description: "Gate.io 现货/合约/期权 API（官方 gate-mcp 本地 stdio 版）。",
    installPackages: [],
    command: "npx",
    args: ["-y", "gate-mcp"],
    windowsCmdWrap: true,
    envVars: [
      { key: "GATE_API_KEY", label: "API Key", required: true },
      { key: "GATE_API_SECRET", label: "Secret Key", required: true },
    ],
  },
  {
    id: "coinbase-mcp",
    name: "Coinbase 交易 MCP",
    exchange: "Coinbase",
    description: "Coinbase 交易/钱包（官方 @coinbase/coinbase-mcp，AgentKit）。",
    installPackages: [],
    command: "npx",
    args: ["-y", "@coinbase/coinbase-mcp"],
    windowsCmdWrap: true,
    envVars: [
      { key: "CDP_API_KEY_NAME", label: "CDP API Key Name", required: true },
      { key: "CDP_API_KEY_PRIVATE_KEY", label: "CDP API 私钥", required: true },
    ],
    note: "使用 Coinbase Developer Platform (CDP) 密钥。",
  },
];

/** 返回全部内置预设（安装态由主进程注入 installed 字段） */
export function listMcpPresets(): McpPreset[] {
  return MCP_PRESETS;
}

export function getMcpPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id);
}
