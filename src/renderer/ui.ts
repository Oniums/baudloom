import { BAUD_RATES, parseBaudRate } from "../baud-rate";
import { mergeSnapshot } from "../snapshot";
import { setupViewControls } from "./view-controls";
import { LogViewport } from "./log-viewport";
import type { Api, Snapshot, Port } from "../shared";
import { setupLayout } from "./layout";
import { SendPanel } from "./send-panel";
declare global {
  interface Window {
    baudloom: Api;
  }
}
setupLayout();
const api = window.baudloom;
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const target = el<HTMLSelectElement>("target"),
  baud = el<HTMLInputElement>("baud"),
  command = el<HTMLTextAreaElement>("command");
const search = el<HTMLInputElement>("search"),
  mode = el<HTMLSelectElement>("rx-format");
const presets = el<HTMLSelectElement>("baud-presets");
presets.append(
  ...BAUD_RATES.map((rate) => new Option(String(rate), String(rate))),
);
presets.onchange = () => {
  if (!presets.value) return;
  baud.value = presets.value;
  presets.value = "";
  baud.dispatchEvent(new Event("input"));
};
try {
  baud.value = String(
    parseBaudRate(localStorage.getItem("baudloom.baud.v1") ?? "115200"),
  );
} catch {}
baud.oninput = () => {
  try {
    parseBaudRate(baud.value);
    baud.setCustomValidity("");
  } catch (error) {
    baud.setCustomValidity((error as Error).message);
  }
  baud.setAttribute("aria-invalid", String(!baud.validity.valid));
};
let ports: Port[] = [];
let enumeration = 0;
let latest: Snapshot | null = null;
let paused = false;
let clearAt = 0;
let session = "";
let busy = false;
let polling = false;
let renderedKey = "";
let uiError = "";
const logViewport = new LogViewport(el("log"));
const viewControls = setupViewControls(
  () => logViewport.refresh(),
  async (limits) => {
    await api.setViewLimits(limits);
    renderedKey = "";
    await poll();
  },
  failure,
);
const sendPanel = new SendPanel(
  (request) => {
    uiError = "";
    el("error").hidden = true;
    return api.send(request);
  },
  failure,
  api,
);
let measuredLabel = "";
let measuredWidth = 280;
const measurement = document.createElement("canvas").getContext("2d")!;
function updateDeviceName() {
  const selected = ports.find((p) => p.path === target.value);
  const label = selected?.label ?? "";
  target.title = label;
  if (label !== measuredLabel) {
    measuredLabel = label;
    measurement.font = getComputedStyle(target).font;
    measuredWidth = measurement.measureText(label).width + 44;
    target.style.width = `${Math.min(440, Math.max(280, measuredWidth))}px`;
  }
  const width = measuredWidth;
  const detail = el("device-name");
  detail.textContent = label;
  detail.hidden = width <= target.getBoundingClientRect().width + 1;
  sendPanel.setContext(latest, selected, busy);
  el<HTMLButtonElement>("connect").disabled =
    busy ||
    (!selected && latest?.state !== "connected") ||
    ["connecting", "stopping"].includes(latest?.state ?? "");
}
new ResizeObserver(updateDeviceName).observe(target);
function failure(error: unknown) {
  uiError = error instanceof Error ? error.message : String(error);
  el("error").textContent = uiError;
  el("error").hidden = false;
}
async function action(fn: () => Promise<unknown>) {
  if (busy) return;
  busy = true;
  updateDeviceName();
  uiError = "";
  el("error").hidden = true;
  try {
    await fn();
  } catch (error) {
    failure(error);
  } finally {
    busy = false;
    await poll();
  }
}
function humanBytes(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}
function render(s: Snapshot) {
  latest = s;
  const connected = s.state === "connected",
    active = ["connecting", "connected", "stopping"].includes(s.state);
  if (session !== s.sessionId) {
    session = s.sessionId;
    clearAt = 0;
    paused = false;
    renderedKey = "";
    el("pause").textContent = "暂停滚动";
    el("pause").setAttribute("aria-pressed", "false");
  }
  el("connect").textContent = connected
    ? "断开"
    : s.state === "connecting"
      ? "连接中…"
      : s.state === "stopping"
        ? "停止中…"
        : "连接";
  (el("connect") as HTMLButtonElement).disabled = [
    "connecting",
    "stopping",
  ].includes(s.state);
  target.disabled = active;
  const recording = el<HTMLInputElement>("save-session");
  recording.disabled =
    busy ||
    ["connecting", "stopping"].includes(s.state) ||
    (connected && Boolean(s.sessionFile));
  if (active && s.state !== "connecting")
    recording.checked = Boolean(s.sessionFile);
  baud.disabled = active;
  presets.disabled = active;
  (el("refresh") as HTMLButtonElement).disabled = active;
  (el("directory") as HTMLButtonElement).disabled = active;
  (el("history") as HTMLButtonElement).disabled = active;
  (el("mark") as HTMLButtonElement).disabled = !connected;
  if (
    active &&
    target.value !== s.target &&
    ports.some((p) => p.path === s.target)
  ) {
    target.value = s.target;
  }
  updateDeviceName();
  const names: Record<string, string> = {
    idle: "未连接",
    connecting: "连接中",
    connected: "已连接",
    stopping: "正在收尾",
    stopped: "已停止",
    offline: "离线阅读",
    error: "采集故障",
  };
  el("connection-state").textContent =
    `${names[s.state]}${s.target ? " · " + s.target : ""}${s.source === "synthetic" && s.sessionId ? "（合成）" : ""}`;
  el("session-title").textContent = s.sessionFile
    ? s.sessionFile.split(/[\\/]/).at(-1)!
    : s.sessionId
      ? "本次会话未保存 · 勾选保存可补写缓存"
      : "选择设备后连接，或打开已有记录";
  el("session-title").title = s.sessionFile;
  el("error").textContent = s.error ?? uiError;
  el("error").hidden = !(s.error || uiError);
  el("notice").textContent = s.warning ?? "";
  el("notice").hidden = !s.warning;
  el("counts").textContent =
    `RX ${humanBytes(s.rxBytes)} · TX ${humanBytes(s.txBytes)} · ${s.eventCount} 事件`;
  el("view-state").textContent =
    `${paused ? "滚动已暂停" : "跟随最新"} · 缓存 ${s.rows.length} / ${s.viewLimits.maxRows} 行 · ${s.viewLimits.maxChars / 1048576} Mi 字符上限${s.totalRows > s.rows.length ? " · 更早显示内容已淘汰" : ""}`;
  el("record-state").textContent =
    s.state === "offline"
      ? "只读 · 未修改原始记录"
      : s.sessionFile
        ? `${active ? "正在保存" : "已保存"} · 已写 ${humanBytes(s.writtenBytes)} · 待写 ${humanBytes(s.pendingBytes)} · ${s.syncedAt ? "最近同步 " + new Date(s.syncedAt).toLocaleTimeString() : "尚未同步"}`
        : recording.checked && !s.sessionId
          ? "连接后保存到所选目录"
          : `未保存 · 可补写 ${s.bufferedEvents} 条事件${s.droppedEvents ? ` · 已淘汰 ${s.droppedEvents} 条` : ""}`;
  if (s.backfillActive) el("record-state").textContent += " · 正在补写缓存…";
  if (s.sessionFile && s.state !== "offline" && s.backfilledEvents)
    el("record-state").textContent +=
      ` · 已补写 ${s.backfilledEvents} 条${s.droppedEvents ? `（已淘汰 ${s.droppedEvents} 条无法补写）` : ""}`;
  el("record-state").title =
    s.sessionFile ||
    "未生成会话文件；勾选保存可补写仍保留的原始缓存，已淘汰事件无法恢复。关闭或重连会丢弃未保存缓存。";
  if (paused) return;
  const query = search.value.toLowerCase();
  const key = [
    s.sessionId,
    s.totalRows,
    s.rxBytes,
    clearAt,
    query,
    mode.value,
    s.state,
    s.rows.length,
    s.viewLimits.maxRows,
    s.viewLimits.maxChars,
  ].join("|");
  if (key === renderedKey) return;
  renderedKey = key;
  const rows = s.rows.filter(
    (r) => r.id > clearAt && (!query || r.text.toLowerCase().includes(query)),
  );
  logViewport.set(
    rows,
    !query,
    query
      ? "当前缓存没有匹配内容"
      : s.sessionId
        ? "等待新记录（清屏不删除原始缓存或磁盘记录）"
        : "选择串口后点击连接，或打开已有会话记录。",
  );
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const requestedMode = mode.value as "text" | "hex";
    const previous = latest;
    const next = await api.snapshot(
      requestedMode,
      previous?.viewUpdate?.cursor,
    );
    if (mode.value === requestedMode && latest === previous)
      render(mergeSnapshot(previous, next));
  } catch (error) {
    failure(error);
    latest = null;
    sendPanel.setContext(
      null,
      ports.find((p) => p.path === target.value),
      busy,
    );
    el("connection-state").textContent = "采集进程不可用";
  } finally {
    polling = false;
  }
}
async function refresh() {
  const selected = target.value;
  const ticket = ++enumeration;
  const discovered = await api.ports();
  if (ticket !== enumeration) return;
  ports = discovered;
  target.replaceChildren(
    ...ports.map((p) => {
      const o = document.createElement("option");
      o.value = p.path;
      o.textContent = p.label;
      o.title = p.label;
      return o;
    }),
  );
  target.value = ports.some((p) => p.path === selected)
    ? selected
    : (ports[0]?.path ?? "");
  if (!ports.length) target.add(new Option("未发现串口", ""));
  updateDeviceName();
}
el<HTMLInputElement>("save-session").onchange = () => {
  if (
    latest?.state === "connected" &&
    el<HTMLInputElement>("save-session").checked
  ) {
    const id = latest.sessionId;
    void action(() => api.startRecording(id));
  } else if (latest) render(latest);
};
el("refresh").onclick = () => void action(refresh);
target.onchange = updateDeviceName;
el("connect").onclick = () =>
  void action(async () => {
    if (latest?.state === "connected") {
      await api.stop();
      return;
    }
    const port = ports.find((p) => p.path === target.value);
    if (!port) throw Error("请选择有效设备");
    const baudRate = parseBaudRate(baud.value);
    await api.connect({
      target: port.path,
      source: port.source,
      baudRate,
      saveSession: el<HTMLInputElement>("save-session").checked,
    });
    try {
      localStorage.setItem("baudloom.baud.v1", String(baudRate));
    } catch {}
  });
el("pause").onclick = () => {
  paused = !paused;
  logViewport.setFollowing(!paused && !search.value);
  el("pause").textContent = paused ? "继续跟随" : "暂停滚动";
  el("pause").setAttribute("aria-pressed", String(paused));
  renderedKey = "";
  if (latest) render(latest);
};
el("clear").onclick = () => {
  clearAt = latest?.totalRows ?? 0;
  logViewport.set([], false, "已清屏，等待新记录");
  renderedKey = "";
  if (latest) render(latest);
};
search.oninput = () => {
  renderedKey = "";
  if (latest && !paused) render(latest);
};
mode.onchange = () => {
  clearAt = 0;
  paused = false;
  el("pause").textContent = "暂停滚动";
  el("pause").setAttribute("aria-pressed", "false");
  renderedKey = "";
  void poll();
};
el("mark").onclick = () => void action(() => api.mark("手工标记"));
el("history").onclick = () =>
  void action(async () => {
    const s = await api.openSession();
    if (s) {
      mode.value = "text";
      render(s);
    }
  });
el("directory").onclick = () =>
  void action(async () => {
    const path = await api.chooseDirectory();
    if (path) {
      el("directory-path").textContent = path;
      el("directory-path").title = path;
    }
  });
document.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key === "Enter" &&
    document.activeElement === command
  ) {
    e.preventDefault();
    el<HTMLFormElement>("send-form").requestSubmit();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    search.focus();
  }
});
void (async () => {
  try {
    await api.setViewLimits(viewControls.limits);
    await Promise.all([
      refresh().catch(failure),
      api
        .directory()
        .then((path) => {
          el("directory-path").textContent = path;
          el("directory-path").title = path;
        })
        .catch(failure),
      poll(),
    ]);
  } catch (error) {
    failure(error);
  }
  const tick = async () => {
    await poll();
    setTimeout(
      tick,
      document.hidden || latest?.state !== "connected" ? 1000 : 100,
    );
  };
  void tick();
})();
