/**
 * electron/preload.ts —— 安全桥接
 * 渲染进程不直接碰 node/子进程，全部经这里白名单暴露。
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (c: unknown) => ipcRenderer.invoke("config:set", c),
  startAgent: () => ipcRenderer.invoke("agent:start"),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),
  runOnce: () => ipcRenderer.invoke("agent:runOnce"),
  getStatus: () => ipcRenderer.invoke("status:get"),
  getLogs: () => ipcRenderer.invoke("logs:get"),
  openFolder: (w: string) => ipcRenderer.invoke("open:folder", w),
  showError: (m: string) => ipcRenderer.invoke("dialog:error", m),
  onLog: (cb: (line: string) => void) => {
    ipcRenderer.on("agent:log", (_e, line: string) => cb(line));
  },
  onStatus: (cb: (s: { running: boolean }) => void) => {
    ipcRenderer.on("agent:status", (_e, s) => cb(s));
  },
});
