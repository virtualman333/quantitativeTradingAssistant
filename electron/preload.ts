import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染进程里表单多为 Vue reactive（Proxy）。Electron 的 invoke 用 structuredClone
 * 序列化参数，Proxy 会抛 "An object could not be cloned"。所有跨进程参数先 JSON 往返
 * 拍成纯对象，彻底规避该问题（所有数据本就是可 JSON 化的配置）。
 */
function safeInvoke(channel: string, ...args: unknown[]) {
  const cloned = args.map((a) => (a === undefined ? a : JSON.parse(JSON.stringify(a))));
  return ipcRenderer.invoke(channel, ...cloned);
}

contextBridge.exposeInMainWorld("api", {
  // 模型
  modelsList: () => safeInvoke("models:list"),
  modelsUpsert: (m: unknown) => safeInvoke("models:upsert", m),
  modelsDelete: (id: string) => safeInvoke("models:delete", id),
  modelsTest: (m: unknown) => safeInvoke("models:test", m),
  // 角色
  rolesList: () => safeInvoke("roles:list"),
  rolesUpsert: (r: unknown) => safeInvoke("roles:upsert", r),
  rolesDelete: (id: string) => safeInvoke("roles:delete", id),
  // MCP
  mcpList: () => safeInvoke("mcp:list"),
  mcpUpsert: (c: unknown) => safeInvoke("mcp:upsert", c),
  mcpDelete: (id: string) => safeInvoke("mcp:delete", id),
  mcpTest: (id: string) => safeInvoke("mcp:test", id),
  mcpPresets: () => safeInvoke("mcp:presets"),
  mcpInstall: (p: { presetId: string; env?: Record<string, string> }) => safeInvoke("mcp:install", p),
  // Skill
  skillsList: () => safeInvoke("skills:list"),
  skillsSetEnabled: (id: string, on: boolean) => safeInvoke("skills:setEnabled", id, on),
  // 设置
  settingsGet: () => safeInvoke("settings:get"),
  settingsUpdate: (p: unknown) => safeInvoke("settings:update", p),
  // 实时账户/持仓查看
  accountGet: (profile?: string) => safeInvoke("account:get", profile),
  storeReset: () => safeInvoke("store:reset"),
  // 工具与对话
  toolsList: () => safeInvoke("tools:list"),
  chatHistory: () => safeInvoke("chat:history"),
  chatSend: (p: { text: string; modelId?: string; enabledTools?: string[] }) =>
    safeInvoke("chat:send", p),
  chatAbort: () => safeInvoke("chat:abort"),
  chatConfirm: (id: string, ok: boolean) => safeInvoke("chat:confirm", id, ok),
  chatClear: () => safeInvoke("chat:clear"),
  // 持仓汇总（LLM 调 MCP 只读工具）
  portfolioSummarize: (p?: { modelId?: string }) => safeInvoke("portfolio:summarize", p),
  portfolioAbort: () => safeInvoke("portfolio:abort"),
  onPortfolioEvent: (cb: (e: unknown) => void) => {
    const h = (_e: unknown, ev: unknown) => cb(ev);
    ipcRenderer.on("portfolio:event", h);
    return () => ipcRenderer.removeListener("portfolio:event", h);
  },
  onChatEvent: (cb: (e: unknown) => void) => {
    const h = (_e: unknown, ev: unknown) => cb(ev);
    ipcRenderer.on("chat:event", h);
    return () => ipcRenderer.removeListener("chat:event", h);
  },
  // 全局 LLM 调用观测（对话 + 持仓的每一次 LLM 行为）
  onLlmTrace: (cb: (e: unknown) => void) => {
    const h = (_e: unknown, ev: unknown) => cb(ev);
    ipcRenderer.on("llm:trace", h);
    return () => ipcRenderer.removeListener("llm:trace", h);
  },
  // agent
  startAgent: () => safeInvoke("agent:start"),
  stopAgent: () => safeInvoke("agent:stop"),
  runOnce: () => safeInvoke("agent:runOnce"),
  getStatus: () => safeInvoke("status:get"),
  getLogs: () => safeInvoke("logs:get"),
  openFolder: (w: string) => safeInvoke("open:folder", w),
  openStore: () => safeInvoke("open:store"),
  showError: (m: string) => safeInvoke("dialog:error", m),
  // 三个监听器都返回取消函数，组件卸载时能真正解绑（否则 KeepAlive 反复挂载会重复绑定）
  onLog: (cb: (l: string) => void) => {
    const h = (_e: unknown, l: string) => cb(l);
    ipcRenderer.on("agent:log", h);
    return () => ipcRenderer.removeListener("agent:log", h);
  },
  onStatus: (cb: (s: { running: boolean }) => void) => {
    const h = (_e: unknown, s: { running: boolean }) => cb(s);
    ipcRenderer.on("agent:status", h);
    return () => ipcRenderer.removeListener("agent:status", h);
  },
});
