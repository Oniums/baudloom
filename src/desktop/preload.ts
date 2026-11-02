import { contextBridge, ipcRenderer } from "electron";
import type { Api } from "../shared";
const api: Api = {
  ports: () => ipcRenderer.invoke("ports"),
  connect: (config) => ipcRenderer.invoke("connect", config),
  startRecording: (sessionId) =>
    ipcRenderer.invoke("startRecording", sessionId),
  setViewLimits: (limits) => ipcRenderer.invoke("setViewLimits", limits),
  stop: () => ipcRenderer.invoke("stop"),
  send: (request) => ipcRenderer.invoke("send", request),
  startSchedule: (request) => ipcRenderer.invoke("startSchedule", request),
  stopSchedule: () => ipcRenderer.invoke("stopSchedule"),
  snapshot: (mode) => ipcRenderer.invoke("snapshot", mode),
  mark: (message) => ipcRenderer.invoke("mark", message),
  directory: () => ipcRenderer.invoke("directory"),
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  openSession: () => ipcRenderer.invoke("open-session"),
};
contextBridge.exposeInMainWorld("baudloom", api);
