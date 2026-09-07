import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopApi } from "../src/shared/types";
const api: DesktopApi = {
  pickDocuments: () => ipcRenderer.invoke("documents:pick"),
  readDroppedFile: (file) =>
    ipcRenderer.invoke("documents:read", webUtils.getPathForFile(file)),
  analyze: (input) => ipcRenderer.invoke("documents:analyze", input),
  cancelOcr: () => ipcRenderer.invoke("documents:cancel"),
  onProgress: (callback) => {
    const handler = (_event: unknown, data: Parameters<typeof callback>[0]) =>
      callback(data);
    ipcRenderer.on("documents:progress", handler);
    return () => ipcRenderer.removeListener("documents:progress", handler);
  },
  startAutomation: (input) => ipcRenderer.invoke("automation:start", input),
  continueAutomation: () => ipcRenderer.invoke("automation:continue"),
  retryAutomation: () => ipcRenderer.invoke("automation:retry"),
  cancelAutomation: () => ipcRenderer.invoke("automation:cancel"),
  onAutomation: (callback) => {
    const handler = (_event: unknown, data: Parameters<typeof callback>[0]) =>
      callback(data);
    ipcRenderer.on("automation:status", handler);
    return () => ipcRenderer.removeListener("automation:status", handler);
  },
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdate: (callback) => {
    const handler = (_event: unknown, data: Parameters<typeof callback>[0]) =>
      callback(data);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },
};
contextBridge.exposeInMainWorld("cca", api);
