import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { storagePaths, prepareStorage } from "./storage";
import { pathToFileURL } from "node:url";

let window: BrowserWindow;
let core: UtilityProcess;
let quitReady = false;
let closing = false;
let coreError = "";
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
let directory = "";
let sequence = 0;
const pending = new Map<
  number,
  {
    resolve: (r: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }
>();
function request(method: string, ...args: unknown[]): Promise<any> {
  if (coreError) return Promise.reject(Error(coreError));
  if (pending.size >= 32) return Promise.reject(Error("操作过多，请稍后重试"));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("采集进程未及时响应，请检查状态后停止采集"));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    try {
      core.postMessage({ id, method, args });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}
app
  .whenReady()
  .then(async () => {
    const prefs = join(app.getPath("userData"), "preferences.json");
    directory = paths.sessions;
    try {
      const data = JSON.parse(await readFile(prefs, "utf8"));
      if (typeof data.directory === "string") directory = data.directory;
    } catch {}
    core = utilityProcess.fork(
      join(__dirname, "../core/worker.cjs"),
      [directory],
      { serviceName: "Baudloom Capture", stdio: "pipe" },
    );
    core.on("message", (message: any) => {
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      message.error
        ? item.reject(Error(message.error))
        : item.resolve(message.result);
    });
    core.on("exit", (code) => {
      coreError = `采集进程已退出（${code}），连接已中断。若已启用保存，请重启应用后核对会话文件。`;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(Error(coreError));
      }
      pending.clear();
    });
    core.stderr?.on("data", (data) => console.error("[capture]", String(data)));
    const renderer = join(__dirname, "../renderer/index.html");
    window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 760,
      minHeight: 560,
      title: "Baudloom",
      icon: join(__dirname, "baudloom.png"),
      show: false,
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    const handle = (channel: string, fn: (...args: any[]) => any) =>
      ipcMain.handle(channel, (event, ...args) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== pathToFileURL(renderer).href
        )
          throw Error("不受信任的界面请求");
        return fn(...args);
      });
    for (const method of [
      "ports",
      "connect",
      "stop",
      "startRecording",
      "setViewLimits",
      "send",
      "snapshot",
      "startSchedule",
      "stopSchedule",
      "mark",
    ])
      handle(method, (...args) => request(method, ...args));
    handle("directory", () => directory);
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
      await mkdir(app.getPath("userData"), { recursive: true });
      await writeFile(prefs, JSON.stringify({ directory }), { mode: 0o600 });
      return directory;
    });
    handle("open-session", async () => {
      const state = await request("snapshot");
      if (["connecting", "connected", "stopping"].includes(state.state))
        throw Error("请先断开设备");
      const result = await dialog.showOpenDialog(window, {
        title: "打开 Baudloom 会话",
        properties: ["openFile"],
        defaultPath: directory,
        filters: [{ name: "Baudloom 记录", extensions: ["jsonl"] }],
      });
      return result.canceled ? null : request("open", result.filePaths[0]);
    });
    window.webContents.on(
      "did-start-loading",
      () => void request("stopSchedule").catch(console.error),
    );
    window.webContents.on(
      "render-process-gone",
      () => void request("stopSchedule").catch(console.error),
    );
    window.once("ready-to-show", () => window.show());
    window.on("close", (event) => {
      if (quitReady) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      void request("stopSchedule").catch(console.error);
      void (async () => {
        try {
          const state = await request("snapshot");
          if (["connected", "connecting", "stopping"].includes(state.state)) {
            const answer = await dialog.showMessageBox(window, {
              type: "question",
              message: "停止采集并退出？",
              detail: state.sessionFile
                ? "退出前会关闭串口并同步会话文件。"
                : "本次未保存会话，退出后窗口缓存将丢失。",
              buttons: ["取消", "停止并退出"],
              defaultId: 0,
              cancelId: 0,
            });
            if (answer.response !== 1) {
              closing = false;
              return;
            }
          }
          await request("stop");
        } catch (error) {
          console.error(error);
        }
        quitReady = true;
        core.kill();
        app.quit();
      })();
    });
    await window.loadFile(renderer);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
app.on("before-quit", (event) => {
  if (quitReady) return;
  event.preventDefault();
  void request("stop")
    .catch((error) => console.error(error))
    .finally(() => {
      quitReady = true;
      core.kill();
      app.quit();
    });
});
