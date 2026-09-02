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
  // agent
  startAgent: () => ipcRenderer.invoke("agent:start"),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),
  runOnce: () => ipcRenderer.invoke("agent:runOnce"),
  getStatus: () => ipcRenderer.invoke("status:get"),
  getLogs: () => ipcRenderer.invoke("logs:get"),
  openFolder: (w: string) => ipcRenderer.invoke("open:folder", w),
  openStore: () => ipcRenderer.invoke("open:store"),
  showError: (m: string) => ipcRenderer.invoke("dialog:error", m),
  onLog: (cb: (l: string) => void) => ipcRenderer.on("agent:log", (_e, l: string) => cb(l)),
  onStatus: (cb: (s: { running: boolean }) => void) => ipcRenderer.on("agent:status", (_e, s) => cb(s)),
});
