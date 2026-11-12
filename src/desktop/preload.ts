import { contextBridge, ipcRenderer } from "electron";
import type { Api } from "../shared";
const api: Api = {
  refreshTabStatus: () => ipcRenderer.invoke("refresh-tab-status"),
  onClosePrompt: (listener) => {
    ipcRenderer.on("close-prompt", async (event, prompt) => {
      const [reply] = event.ports;
      try {
        reply.postMessage((await listener(prompt)) === true);
      } catch {
        reply.postMessage(false);
      } finally {
        reply.close();
      }
    });
  },
  tabState: () => ipcRenderer.invoke("tab-state"),
  onTabsChanged: (listener) => {
    ipcRenderer.on("tabs-changed", (_event, state) => listener(state));
  },
  newTab: () => ipcRenderer.invoke("tab-new"),
  selectTab: (id) => ipcRenderer.invoke("tab-select", id),
  closeTab: (id) => ipcRenderer.invoke("tab-close", id),
  setAppearance: (theme) => ipcRenderer.invoke("set-appearance", theme),
  exportLog: (request) => ipcRenderer.invoke("export-log", request),
  cancelExport: () => ipcRenderer.invoke("cancel-export"),
  ports: () => ipcRenderer.invoke("ports"),
  connect: (config) => ipcRenderer.invoke("connect", config),
  startRecording: (sessionId) =>
    ipcRenderer.invoke("startRecording", sessionId),
  setViewLimits: (limits) => ipcRenderer.invoke("setViewLimits", limits),
  stop: () => ipcRenderer.invoke("stop"),
  send: (request) => ipcRenderer.invoke("send", request),
  startSchedule: (request) => ipcRenderer.invoke("startSchedule", request),
  stopSchedule: () => ipcRenderer.invoke("stopSchedule"),
  snapshot: (mode, cursor) => ipcRenderer.invoke("snapshot", mode, cursor),
  mark: (message) => ipcRenderer.invoke("mark", message),
  directory: () => ipcRenderer.invoke("directory"),
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  openSession: () => ipcRenderer.invoke("open-session"),
};
contextBridge.exposeInMainWorld("baudloom", api);
