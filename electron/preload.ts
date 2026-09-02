import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  // 模型
  modelsList: () => ipcRenderer.invoke("models:list"),
  modelsUpsert: (m: unknown) => ipcRenderer.invoke("models:upsert", m),
  modelsDelete: (id: string) => ipcRenderer.invoke("models:delete", id),
  modelsTest: (m: unknown) => ipcRenderer.invoke("models:test", m),
  // 角色
  rolesList: () => ipcRenderer.invoke("roles:list"),
  rolesUpsert: (r: unknown) => ipcRenderer.invoke("roles:upsert", r),
  rolesDelete: (id: string) => ipcRenderer.invoke("roles:delete", id),
  // MCP
  mcpList: () => ipcRenderer.invoke("mcp:list"),
  mcpUpsert: (c: unknown) => ipcRenderer.invoke("mcp:upsert", c),
  mcpDelete: (id: string) => ipcRenderer.invoke("mcp:delete", id),
  mcpTest: (id: string) => ipcRenderer.invoke("mcp:test", id),
  // Skill
  skillsList: () => ipcRenderer.invoke("skills:list"),
  skillsSetEnabled: (id: string, on: boolean) => ipcRenderer.invoke("skills:setEnabled", id, on),
  // 设置
  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsUpdate: (p: unknown) => ipcRenderer.invoke("settings:update", p),
  storeReset: () => ipcRenderer.invoke("store:reset"),
  // 工具与对话
  toolsList: () => ipcRenderer.invoke("tools:list"),
  chatHistory: () => ipcRenderer.invoke("chat:history"),
  chatSend: (p: { text: string; modelId?: string; enabledTools?: string[] }) =>
    ipcRenderer.invoke("chat:send", p),
  chatAbort: () => ipcRenderer.invoke("chat:abort"),
  chatConfirm: (id: string, ok: boolean) => ipcRenderer.invoke("chat:confirm", id, ok),
  chatClear: () => ipcRenderer.invoke("chat:clear"),
  onChatEvent: (cb: (e: unknown) => void) => {
    const h = (_e: unknown, ev: unknown) => cb(ev);
    ipcRenderer.on("chat:event", h);
    return () => ipcRenderer.removeListener("chat:event", h);
  },
  // agent
  startAgent: () => ipcRenderer.invoke("agent:start"),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),
  runOnce: () => ipcRenderer.invoke("agent:runOnce"),
  getStatus: () => ipcRenderer.invoke("status:get"),
  getLogs: () => ipcRenderer.invoke("logs:get"),
  openFolder: (w: string) => ipcRenderer.invoke("open:folder", w),
  openStore: () => ipcRenderer.invoke("open:store"),
  showError: (m: string) => ipcRenderer.invoke("dialog:error", m),
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
