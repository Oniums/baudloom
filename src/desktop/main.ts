import { startCaptureProcess } from "./capture-process";
import {
  app,
  BaseWindow,
  MessageChannelMain,
  WebContentsView,
  dialog,
  ipcMain,
  nativeTheme,
  type WebContents,
} from "electron";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import type {
  Port,
  ClosePrompt,
  ConnectionConfig,
  Snapshot,
  TabState,
} from "../shared";
import { storagePaths, prepareStorage } from "./storage";
import { pathToFileURL } from "node:url";

const paths = storagePaths({
  override: process.env.BAUDLOOM_DATA_DIR,
  portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  packaged: app.isPackaged,
  executable: app.getPath("exe"),
  project: app.getAppPath(),
});
try {
  prepareStorage(paths);
  app.setPath("userData", paths.profile);
  app.setPath("sessionData", paths.cache);
  app.setPath("logs", paths.logs);
  app.setPath("crashDumps", paths.crashes);
  app.commandLine.appendSwitch("disk-cache-dir", join(paths.cache, "disk"));
} catch (error) {
  dialog.showErrorBox(
    "无法创建本地数据目录",
    `请将 Baudloom 放在可写目录后重试。\n${paths.root}\n${String(error)}`,
  );
  app.exit(1);
}

const prefs = join(paths.profile, "preferences.json");
const renderer = join(__dirname, "../renderer/index.html");
const rendererUrl = pathToFileURL(renderer).href;
let defaultDirectory = paths.sessions;
let quitting = false;
type Handler = (...args: any[]) => any;
const routes = new Map<WebContents, Map<string, Handler>>();
const channels = new Set<string>();
const occupied = new Map<number, string>();
const portKey = (path: string) =>
  process.platform === "win32" ? path.toUpperCase() : path;

function register(
  channel: string,
  handlers: Map<string, Handler>,
  fn: Handler,
) {
  handlers.set(channel, fn);
  if (channels.has(channel)) return;
  channels.add(channel);
  ipcMain.handle(channel, (event, ...args) => {
    const handler = routes.get(event.sender)?.get(channel);
    if (
      !handler ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== rendererUrl
    )
      throw Error("不受信任的界面请求");
    return handler(...args);
  });
}

type Tab = {
  id: number;
  view: WebContentsView;
  label: string;
  connected: boolean;
  request: ReturnType<typeof startCaptureProcess>["request"];
  dispose: () => void;
};
let window: BaseWindow;
const tabs = new Map<number, Tab>();
let activeId = 0;
let closingWindow = false;
let operations = Promise.resolve();

function schedule(action: () => Promise<void>) {
  const next = operations.then(action);
  operations = next.catch(console.error);
  return next;
}
function tabState(tabId: number): TabState {
  return {
    foreground: tabId === activeId,
    activeId,
    tabs: Array.from(tabs.values(), ({ id, label, connected }, index) => ({
      id,
      label: label || `串口 ${index + 1}`,
      connected,
    })),
  };
}
function syncTabs() {
  const state = tabState(activeId);
  for (const tab of tabs.values()) {
    if (!tab.view.webContents.isDestroyed())
      tab.view.webContents.send("tabs-changed", {
        ...state,
        foreground: tab.id === activeId,
      });
  }
  const active = tabs.get(activeId);
  window.setTitle(
    active?.connected ? `Baudloom · ${active.label}` : "Baudloom",
  );
}
function sizeView(tab: Tab) {
  const [width, height] = window.getContentSize();
  tab.view.setBounds({ x: 0, y: 0, width, height });
}
function activate(id: number) {
  const next = tabs.get(id);
  if (!next || activeId === id) return;
  const previous = tabs.get(activeId);
  if (previous) previous.view.setVisible(false);
  activeId = id;
  sizeView(next);
  next.view.setVisible(true);
  next.view.webContents.focus();
  syncTabs();
}
async function confirmStop(selected: Tab[], entireWindow: boolean) {
  if (quitting) return true;
  const states = await Promise.all(
    selected.map((tab) => tab.request("status").catch(() => null)),
  );
  const live = states.filter(
    (state) =>
      state && ["connected", "connecting", "stopping"].includes(state.state),
  );
  if (!live.length || quitting) return true;
  const prompt: ClosePrompt = {
    title: entireWindow ? "断开串口并退出？" : "关闭串口标签页？",
    confirm: entireWindow ? "断开并退出" : "断开并关闭",
    sessions: live.map((state) => ({
      target: state.target,
      detail: state.sessionFile
        ? "关闭前会写完会话文件"
        : "未保存，关闭后日志将丢失",
    })),
  };
  const contents = tabs.get(activeId)?.view.webContents;
  if (!contents || contents.isDestroyed() || contents.isCrashed()) {
    // A crashed workspace cannot present its dialog while the capture process is still live.
    const answer = await dialog.showMessageBox(window, {
      type: "question",
      message: prompt.title,
      detail: prompt.sessions
        .map((s) => `${s.target} · ${s.detail}`)
        .join("\n"),
      buttons: ["取消", prompt.confirm],
      defaultId: 0,
      cancelId: 0,
    });
    return answer.response === 1 || quitting;
  }
  return new Promise<boolean>((resolve) => {
    const { port1, port2 } = new MessageChannelMain();
    const show = () => contents.postMessage("close-prompt", prompt, [port2]);
    const finish = (confirmed: boolean) => {
      contents.off("did-finish-load", show);
      contents.off("did-fail-load", cancel);
      contents.off("did-start-loading", cancel);
      contents.off("render-process-gone", cancel);
      app.off("before-quit", quit);
      port1.removeAllListeners();
      port1.close();
      resolve(confirmed);
    };
    const cancel = () => finish(false);
    const quit = () => finish(true);
    contents.once("did-start-loading", cancel);
    contents.once("did-fail-load", cancel);
    contents.once("render-process-gone", cancel);
    app.once("before-quit", quit);
    port1.once("message", (event) => finish(event.data === true));
    port1.once("close", cancel);
    port1.start();
    if (contents.isLoadingMainFrame()) contents.once("did-finish-load", show);
    else show();
  });
}
async function stopTab(tab: Tab) {
  await tab.request("cancelExport").catch(console.error);
  await tab.request("stop").catch(console.error);
}
async function closeTab(id: number) {
  const tab = tabs.get(id);
  if (!tab || !(await confirmStop([tab], false))) return;
  await stopTab(tab);
  const ids = Array.from(tabs.keys());
  const neighbor = ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1];
  tab.dispose();
  if (!tabs.size) {
    activeId = 0;
    await createTab();
  } else if (id === activeId) activate(neighbor);
  else syncTabs();
}
async function createTab() {
  let directory = defaultDirectory;
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contents = view.webContents;
  const tabId = contents.id;
  view.setBackgroundColor(
    nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
  );
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  const capture = startCaptureProcess(directory, () => occupied.delete(tabId));
  const { request } = capture;
  const handlers = new Map<string, Handler>();
  routes.set(contents, handlers);
  const handle = (channel: string, fn: Handler) =>
    register(channel, handlers, fn);
  function fromActive(action: () => Promise<void>) {
    return schedule(async () => {
      if (!closingWindow && activeId === tabId) await action();
    });
  }
  handle("tab-state", () => tabState(tabId));
  handle("tab-new", () => fromActive(createTab));
  handle("tab-select", (id: number) => fromActive(async () => activate(id)));
  handle("tab-close", (id: number) => fromActive(() => closeTab(id)));
  function occupiedElsewhere(path: string) {
    const key = portKey(path);
    return Array.from(occupied).some(
      ([id, value]) => id !== tabId && value === key,
    );
  }
  handle("ports", async () => {
    const ports: Port[] = await request("ports");
    return ports.map((port) =>
      occupiedElsewhere(port.path) ? { ...port, inUse: true } : port,
    );
  });
  let leaseGeneration = 0;
  handle("connect", async (config: ConnectionConfig) => {
    if (typeof config?.target !== "string") throw Error("无效串口参数");
    if (occupied.has(tabId)) throw Error("请先停止当前连接");
    if (occupiedElsewhere(config.target))
      throw Error("该串口已在其他标签页连接");
    const generation = ++leaseGeneration;
    occupied.set(tabId, portKey(config.target));
    try {
      await request("connect", config);
    } catch (error) {
      if (generation === leaseGeneration) occupied.delete(tabId);
      throw error;
    }
  });
  handle("stop", async () => {
    const generation = leaseGeneration;
    await request("stop");
    if (generation === leaseGeneration) occupied.delete(tabId);
  });
  function updateStatus(
    state: Pick<Snapshot, "state" | "target" | "sessionFile">,
    generation: number,
  ) {
    if (state.state === "error" && generation === leaseGeneration)
      occupied.delete(tabId);
    const label =
      state.state === "offline" ? basename(state.sessionFile) : state.target;
    const connected = state.state === "connected";
    if (
      tabs.has(tabId) &&
      (label !== tab.label || connected !== tab.connected)
    ) {
      tab.label = label;
      tab.connected = connected;
      syncTabs();
    }
  }
  handle("refresh-tab-status", async () => {
    const generation = leaseGeneration;
    updateStatus(await request("status"), generation);
  });
  handle("snapshot", async (...args) => {
    const generation = leaseGeneration;
    const state: Snapshot = await request("snapshot", ...args);
    updateStatus(state, generation);
    return state;
  });
  handle("set-appearance", (theme: unknown) => {
    if (theme !== "dark" && theme !== "light") throw Error("无效的外观设置");
    nativeTheme.themeSource = theme;
    view.setBackgroundColor(theme === "dark" ? "#1e1e1e" : "#ffffff");
    window.setBackgroundColor(theme === "dark" ? "#1e1e1e" : "#ffffff");
  });
  for (const method of [
    "startRecording",
    "setViewLimits",
    "send",
    "startSchedule",
    "stopSchedule",
    "mark",
  ])
    handle(method, (...args) => request(method, ...args));
  handle("directory", async () => {
    return directory;
  });
  handle("choose-directory", async () => {
    const state = await request("snapshot");
    if (["connecting", "connected", "stopping"].includes(state.state))
      throw Error("请先断开设备");
    const result = await dialog.showOpenDialog(window, {
      title: "选择会话记录目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    await request("directory", selected);
    directory = selected;
    writeFileSync(prefs, JSON.stringify({ directory }), { mode: 0o600 });
    defaultDirectory = selected;
    return directory;
  });
  let exporting = false;
  handle("cancel-export", () => request("cancelExport"));
  handle("export-log", async (options) => {
    if (exporting) throw Error("已有导出正在进行");
    exporting = true;
    try {
      const chosen = await dialog.showSaveDialog(window, {
        title: "导出日志",
        defaultPath: join(
          directory,
          `Baudloom-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`,
        ),
        filters: [{ name: "文本日志", extensions: ["txt", "log"] }],
      });
      return chosen.canceled || !chosen.filePath
        ? null
        : await request("export", chosen.filePath, options);
    } finally {
      exporting = false;
    }
  });
  handle("open-session", async () => {
    const state = await request("snapshot");
    if (["connecting", "connected", "stopping"].includes(state.state))
      throw Error("请先断开设备");
    const result = await dialog.showOpenDialog(window, {
      title: "打开会话或文本日志",
      properties: ["openFile"],
      defaultPath: directory,
      filters: [
        { name: "会话与文本日志", extensions: ["jsonl", "txt", "log"] },
      ],
    });
    return result.canceled ? null : request("open", result.filePaths[0]);
  });
  contents.on(
    "did-start-loading",
    () => void request("stopSchedule").catch(console.error),
  );
  contents.on(
    "render-process-gone",
    () => void request("stopSchedule").catch(console.error),
  );

  const tab: Tab = {
    id: tabId,
    view,
    label: "",
    connected: false,
    request,
    dispose() {
      tabs.delete(tabId);
      routes.delete(contents);
      occupied.delete(tabId);
      window.contentView.removeChildView(view);
      contents.close();
      capture.kill();
    },
  };
  tabs.set(tabId, tab);
  window.contentView.addChildView(view);
  view.setVisible(false);
  try {
    await contents.loadFile(renderer);
    activate(tabId);
  } catch (error) {
    tab.dispose();
    syncTabs();
    throw error;
  }
}

async function createWindow() {
  window = new BaseWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: "Baudloom",
    icon: join(__dirname, "baudloom.png"),
    show: false,
    backgroundColor: "#1e1e1e",
  });
  window.setMenu(null);
  window.on("resize", () => {
    const active = tabs.get(activeId);
    if (active) sizeView(active);
  });
  window.on("close", (event) => {
    event.preventDefault();
    if (closingWindow) return;
    closingWindow = true;
    void schedule(async () => {
      try {
        const all = [...tabs.values()];
        if (!(await confirmStop(all, true))) return;
        await Promise.all(all.map(stopTab));
        for (const tab of all) tab.dispose();
        window.destroy();
      } finally {
        closingWindow = false;
      }
    });
  });
  await createTab();
  window.show();
}
app
  .whenReady()
  .then(async () => {
    try {
      const data = JSON.parse(await readFile(prefs, "utf8"));
      if (typeof data.directory === "string") defaultDirectory = data.directory;
    } catch {}
    nativeTheme.themeSource = "dark";
    await createWindow();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
app.on("before-quit", () => {
  quitting = true;
});
app.on("window-all-closed", () => app.quit());
