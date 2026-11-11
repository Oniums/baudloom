import { setupToolbar } from "./toolbar";
import { setupConnectionPanel } from "./connection-panel";
import { setupReading } from "./reading-panel";
import { compileSearch, type LogFilter } from "../log-search";
import { setupExport } from "./export-panel";
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
setupToolbar();
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
let latest: Snapshot | null = null;
let paused = false;
let frozen: Snapshot | null = null;
let matches: number[] = [];
let activeMatch = 0;
let clearAt = 0;
let session = "";
let busy = false;
let polling = false;
let renderedKey = "";
let uiError = "";
const logViewport = new LogViewport(el("log"));
function currentFilter(): LogFilter {
  return {
    query: search.value,
    exclude: el<HTMLInputElement>("search-exclude").value,
    caseSensitive: el<HTMLInputElement>("match-case").checked,
    onlyMatches: el<HTMLInputElement>("filter-matches").checked,
  };
}
setupExport(
  api,
  () => logViewport.selectedText(),
  () => ({
    snapshot: latest,
    mode: mode.value as "text" | "hex",
    afterRowId: clearAt,
    filter: currentFilter(),
  }),
);
function updateMatchCount() {
  el("match-count").textContent = matches.length
    ? `${Math.max(0, matches.indexOf(activeMatch)) + 1} / ${matches.length} 个匹配行`
    : "0 个匹配行";
  el<HTMLButtonElement>("match-previous").disabled = !matches.length;
  el<HTMLButtonElement>("match-next").disabled = !matches.length;
}
function navigateMatch(step: number) {
  if (!matches.length) return;
  const index =
    (matches.indexOf(activeMatch) + step + matches.length) % matches.length;
  activeMatch = matches[index];
  logViewport.navigateTo(activeMatch);
  updateMatchCount();
}
el("match-previous").onclick = () => navigateMatch(-1);
el("match-next").onclick = () => navigateMatch(1);
function openSearch() {
  el("more-tools-panel").hidePopover();
  el("search-panel").hidden = false;
  el("search-options").setAttribute("aria-expanded", "true");
  search.focus();
}
function closeSearch() {
  search.value = "";
  el<HTMLInputElement>("search-exclude").value = "";
  el("search-panel").hidden = true;
  el<HTMLDetailsElement>("search-advanced").open = false;
  el("search-options").setAttribute("aria-expanded", "false");
  activeMatch = 0;
  renderedKey = "";
  if (latest) render(latest);
  el("search-options").focus();
}
el("search-options").onclick = () =>
  el("search-panel").hidden ? openSearch() : closeSearch();
el("search-close").onclick = closeSearch;
search.onkeydown = (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    navigateMatch(event.shiftKey ? -1 : 1);
  }
};
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
const connectionPanel = setupConnectionPanel(sendPanel, () => latest, failure);
const readingPanel = setupReading(
  (id) => {
    freeze();
    search.value = "";
    el<HTMLInputElement>("search-exclude").value = "";
    clearAt = 0;
    renderedKey = "";
    if (latest) render(latest);
    logViewport.navigateTo(id);
  },
  (ids) => logViewport.selectRows(ids),
);
function freeze() {
  if (paused) return;
  paused = true;
  frozen = latest;
  logViewport.setFollowing(false);
  el("pause").textContent = "继续跟随";
  el("pause").setAttribute("aria-pressed", "true");
  if (latest) render(latest);
}
logViewport.onBrowse = freeze;
el("record-state").onclick = () =>
  el<HTMLDialogElement>("status-dialog").showModal();
el("status-close").onclick = () =>
  el<HTMLDialogElement>("status-dialog").close();
el("send-options").onclick = () =>
  el<HTMLDialogElement>("send-options-dialog").showModal();
el("send-options-close").onclick = () =>
  el<HTMLDialogElement>("send-options-dialog").close();
function updateDeviceName() {
  const selected = ports.find((p) => p.path === target.value);
  const label =
    selected?.label ??
    (target.value ? (target.selectedOptions[0]?.text ?? target.value) : "");
  target.title = label;
  el("device-name").textContent = label || "未选择";
  sendPanel.setContext(latest, selected, busy);
  el<HTMLButtonElement>("connect").disabled =
    busy ||
    (!selected && latest?.state !== "connected") ||
    ["connecting", "stopping"].includes(latest?.state ?? "");
}

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
    frozen = null;
    activeMatch = 0;
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
  connectionPanel.update();
  mode.disabled = s.fileKind === "text";
  document
    .querySelector("main")!
    .classList.toggle("plain-text", s.fileKind === "text");
  const names: Record<string, string> = {
    idle: "未连接",
    connecting: "连接中",
    connected: "已连接",
    stopping: "正在收尾",
    stopped: "已停止",
    offline: "离线阅读",
    error: "采集故障",
  };
  el("connection-state").dataset.state = s.state;
  el("connection-state").textContent =
    `${names[s.state]}${s.source === "synthetic" && s.sessionId && s.fileKind !== "text" ? "（合成）" : ""}`;
  el("session-title").textContent =
    s.state === "offline"
      ? s.fileKind === "text"
        ? s.sessionFile.split(/[\\/]/).at(-1)!
        : "历史会话"
      : active
        ? "实时接收"
        : s.sessionId
          ? "本次会话"
          : "接收";
  el("session-title").title = s.sessionFile;
  el("error").textContent = s.error ?? uiError;
  el("error").hidden = !(s.error || uiError);
  el("notice").textContent = s.warning ?? "";
  el("notice").hidden = !s.warning;
  el("counts").textContent =
    `RX ${humanBytes(s.rxBytes)} · TX ${humanBytes(s.txBytes)}`;
  el("view-state").textContent =
    `${paused ? "阅读中" : "跟随最新"} · ${s.rows.length} 行${s.totalRows > s.rows.length ? " · 更早内容已淘汰" : ""}`;
  el("view-state").title =
    `缓存 ${s.rows.length} / ${s.viewLimits.maxRows} 行 · ${s.viewLimits.maxChars / 1048576} Mi 字符上限`;
  el("back-to-latest").hidden = !paused;
  el("back-to-latest").textContent =
    `回到最新${paused && frozen ? " · 新增 " + Math.max(0, s.totalRows - frozen.totalRows) + " 行" : ""}`;
  el("record-details").textContent =
    s.state === "offline"
      ? s.fileKind === "text"
        ? "只读文本 · 无接收时间与方向"
        : "只读 · 未修改原始记录"
      : s.sessionFile
        ? `${active ? "正在保存" : "已保存"} · ${s.segmentCount} 段 · 已写 ${humanBytes(s.writtenBytes)} · 待写 ${humanBytes(s.pendingBytes)} · ${s.syncedAt ? "最近同步 " + new Date(s.syncedAt).toLocaleTimeString() : "尚未同步"}`
        : recording.checked && !s.sessionId
          ? "连接后保存到所选目录"
          : `未保存 · 可补写 ${s.bufferedEvents} 条事件${s.droppedEvents ? ` · 已淘汰 ${s.droppedEvents} 条` : ""}`;
  if (s.backfillActive) el("record-details").textContent += " · 正在补写缓存…";
  if (s.sessionFile && s.state !== "offline" && s.backfilledEvents)
    el("record-details").textContent +=
      ` · 已补写 ${s.backfilledEvents} 条${s.droppedEvents ? `（已淘汰 ${s.droppedEvents} 条无法补写）` : ""}`;
  el("record-state").textContent =
    s.state === "offline"
      ? "只读"
      : s.backfillActive
        ? "正在补写…"
        : s.sessionFile
          ? `${active ? "正在保存" : "已保存"}${s.backfilledEvents ? " · 已补写缓存" : ""}`
          : recording.checked && !s.sessionId
            ? "连接后保存"
            : "未保存";
  el("record-details").textContent += ` · ${s.eventCount} 事件`;
  el("record-state").title =
    el("record-details").textContent + "；点击查看文件与目录";
  el("record-file").textContent =
    s.currentSessionFile || s.sessionFile || "尚未生成会话文件";
  const display = paused && frozen ? frozen : s;
  const filter = currentFilter();
  const query = filter.query;
  const compiled = compileSearch(filter);
  const key = [
    display.sessionId,
    display.totalRows,
    display.rxBytes,
    clearAt,
    JSON.stringify(filter),
    mode.value,
    display.state,
    display.rows.length,
    s.viewLimits.maxRows,
    s.viewLimits.maxChars,
  ].join("|");
  if (key === renderedKey) return;
  renderedKey = key;
  readingPanel.update(display.rows, display.sessionId + ":" + mode.value);
  const rows = display.rows.filter(
    (row) => row.id > clearAt && compiled.visible(row.text),
  );
  matches = compiled.active
    ? rows.filter((row) => compiled.matches(row.text)).map((row) => row.id)
    : [];
  if (!matches.includes(activeMatch)) activeMatch = matches[0] ?? 0;
  updateMatchCount();
  logViewport.set(
    rows,
    !paused && !query && !filter.exclude,
    query
      ? "当前缓存没有匹配内容"
      : s.sessionId
        ? "等待新记录（清屏不删除原始缓存或磁盘记录）"
        : "选择串口后点击连接，或打开已有会话记录。",
    compiled.highlights,
    activeMatch,
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
    el("connection-state").dataset.state = "error";
    el("connection-state").textContent = "采集进程不可用";
  } finally {
    polling = false;
  }
}
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const discovered = await api.ports();
    if (
      JSON.stringify(discovered) === JSON.stringify(ports) &&
      target.options[0]?.text !== "正在枚举…"
    )
      return;
    const initial = target.options[0]?.text === "正在枚举…";
    const selected =
      target.value || (initial ? connectionPanel.lastPort() : "");
    const previous = ports.find((p) => p.path === selected);
    ports = discovered;
    target.replaceChildren(
      ...ports.map((p) => {
        const o = new Option(p.label, p.path);
        o.title = p.label;
        return o;
      }),
    );
    if (selected && !ports.some((p) => p.path === selected)) {
      target.add(
        new Option(`${previous?.label ?? selected}（未检测到）`, selected),
      );
      target.value = selected;
    } else target.value = selected || ports[0]?.path || "";
    if (initial) connectionPanel.restore(target.value);
    if (!target.options.length) target.add(new Option("未发现串口", ""));
    updateDeviceName();
  } finally {
    refreshing = false;
  }
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
target.onchange = () => {
  connectionPanel.restore(target.value);
  updateDeviceName();
};
el("connect").onclick = () =>
  void action(async () => {
    if (latest?.state === "connected") {
      await api.stop();
      return;
    }
    const port = ports.find((p) => p.path === target.value);
    if (!port) throw Error("请选择有效设备");
    const baudRate = parseBaudRate(baud.value);
    const serial = connectionPanel.read();
    await api.connect({
      target: port.path,
      source: port.source,
      baudRate,
      serial,
      saveSession: el<HTMLInputElement>("save-session").checked,
    });
    connectionPanel.remember({ path: port.path, baudRate, serial });
  });
el("pause").onclick = () => {
  paused = !paused;
  frozen = paused ? latest : null;
  logViewport.setFollowing(!paused && !search.value);
  el("pause").textContent = paused ? "继续跟随" : "暂停滚动";
  el("pause").setAttribute("aria-pressed", String(paused));
  renderedKey = "";
  if (latest) render(latest);
};
function resumeFollowing() {
  paused = false;
  frozen = null;
  renderedKey = "";
  logViewport.setFollowing(true);
  el("pause").textContent = "暂停滚动";
  el("pause").setAttribute("aria-pressed", "false");
  if (latest) render(latest);
}
logViewport.onReachTail = () => {
  if (paused && !search.value && !el<HTMLInputElement>("search-exclude").value)
    resumeFollowing();
};
el("back-to-latest").onclick = () => {
  search.value = "";
  el<HTMLInputElement>("search-exclude").value = "";
  resumeFollowing();
};
el("clear").onclick = () => {
  clearAt = latest?.totalRows ?? 0;
  logViewport.set([], false, "已清屏，等待新记录");
  renderedKey = "";
  if (latest) render(latest);
};
search.oninput = () => {
  renderedKey = "";
  if (latest) render(latest);
};
for (const id of ["search-exclude", "match-case", "filter-matches"]) {
  el(id).addEventListener("input", () => {
    renderedKey = "";
    if (latest) render(latest);
  });
}
mode.onchange = () => {
  clearAt = 0;
  paused = false;
  frozen = null;
  el("pause").textContent = "暂停滚动";
  el("pause").setAttribute("aria-pressed", "false");
  renderedKey = "";
  void poll();
};
el("mark").onclick = () => void action(() => api.mark("手工标记"));
el("history").onclick = () =>
  void action(async () => {
    el("history-label").textContent = "读取中…";
    try {
      const s = await api.openSession();
      if (s) {
        mode.value = "text";
        render(s);
      }
    } finally {
      el("history-label").textContent = "打开日志";
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
    e.key === "Escape" &&
    !el("search-panel").hidden &&
    !document.querySelector("dialog[open]") &&
    !(e.target as Element).closest("[popover]")
  ) {
    e.preventDefault();
    closeSearch();
    return;
  }
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
    if (!document.querySelector("dialog[open]")) openSearch();
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
  const watchPorts = async () => {
    try {
      await refresh();
      el("ports-note").hidden = true;
    } catch {
      el("ports-note").hidden = false;
      el("ports-note").textContent = "设备列表更新失败，可点击刷新重试";
    }
    setTimeout(watchPorts, 2000);
  };
  setTimeout(watchPorts, 2000);
})();
