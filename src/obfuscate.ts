/**
 * obfuscate.ts —— 提示词混淆层
 *
 * 目的：LLM 提供方（网关/云端）通常会把每次请求原文记入日志。
 * 若 system prompt 里明写「OKX / BTC-USDT-SWAP / 章程 / 风控阈值」，
 * 等于把策略整体拱手送人。本层在发送前把敏感标识替换成代号，
 * 返回结果再反向还原，上层（专家/主 Agent/执行层）全程无感知。
 *
 * 诚实边界（重要）：
 *   · LLM 要正确工作就必须理解这些代号，因此提供方理论上也能从「代号约定」
 *     反推部分语义——混淆无法做到「对提供方绝对保密」。
 *   · 它的实际价值是：①对抗关键词自动扫描；②提高人工逆向与跨请求拼接成本；
 *     ③避免单条日志泄露「完整、可直接复用的策略」。
 *   · 只混淆「LLM 决策不需要真实名」的标识（标的代码、项目名、章程、环境）。
 *     不混淆 MCP 工具名（会破坏工具匹配）、不混淆风控阈值（会让约束失效）。
 */

/** 注入在 system 最前面的代号约定 + 保密指令（本身不含任何真实敏感词） */
export const OBF_PREAMBLE = `[CONFIDENTIALITY PROTOCOL · CODENAME CONVENTION]
This prompt uses codenames to protect strategy confidentiality. Always understand and answer using the codenames; never reveal or restate any real name in your output or reasoning.
Codename mapping: §SYM1§ = the first perpetual instrument; §SYM2§ = the second perpetual instrument; §PRJ§ = this project; §BOOK§ = the rulebook; §ENV§ = the runtime environment.
When outputting JSON, always write §SYM1§ or §SYM2§ in instrument fields — never the real codes.`;

/**
 * 混淆规则（有序）：长词/具体在前，避免子串误替换。
 * `real` 是反查（deobfuscate）用的唯一还原值。
 */
const RULES: Array<{ re: RegExp; to: string; real: string }> = [
  { re: /OKX\s+Trader/gi, to: "§PRJ§", real: "OKX Trader" },
  { re: /AGENT_TRADING_RULES/gi, to: "§BOOK§", real: "AGENT_TRADING_RULES" },
  { re: /BTC-USDT-SWAP/gi, to: "§SYM1§", real: "BTC-USDT-SWAP" },
  { re: /ETH-USDT-SWAP/gi, to: "§SYM2§", real: "ETH-USDT-SWAP" },
  { re: /章程/g, to: "§BOOK§", real: "章程" },
  { re: /模拟盘/g, to: "§ENV§", real: "模拟盘" },
];

/** 发送前：敏感标识 → 代号 */
export function obfuscate(text: string): string {
  let out = text;
  for (const r of RULES) out = out.replace(r.re, r.to);
  return out;
}

/** 接收后：代号 → 真实标识（执行层依赖真实标的名） */
export function deobfuscate(text: string): string {
  let out = text;
  for (const r of RULES) out = out.split(r.to).join(r.real);
  return out;
}

/** 判断文本里是否含任何代号（用于按需还原） */
export function hasObfuscated(text: string): boolean {
  return RULES.some((r) => text.includes(r.to));
}
