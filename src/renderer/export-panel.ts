import type { Api, Snapshot } from "../shared";
import type { LogFilter } from "../log-search";

export function setupExport(
  api: Api,
  selectedText: () => string,
  context: () => {
    snapshot: Snapshot | null;
    mode: "text" | "hex";
    afterRowId: number;
    filter: LogFilter;
  },
) {
  const get = <T extends HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>("export-dialog");
  const scope = get<HTMLSelectElement>("export-scope");
  const status = get<HTMLOutputElement>("export-status");
  const submit = get<HTMLButtonElement>("export-confirm");
  const close = get<HTMLButtonElement>("export-close");
  let running = false,
    selection = "";
  let captured: ReturnType<typeof context>;
  const hints = {
    cache: "导出确认时仍保留的全部缓存，包含清屏前内容；已淘汰内容不在此范围。",
    filtered:
      "按当前查找、排除、显示格式与清屏范围导出确认时缓存；不是整个磁盘会话。",
    session:
      "逐段读取完整已保存会话，不受窗口缓存上限影响。连接中导出截至开始时的已保存内容；缺段或损坏会终止导出。",
    selection: "按原样导出接收窗口中选中的文字，仅包含已选中的可见内容。",
  };
  scope.onchange = () => {
    get("export-hint").textContent = hints[scope.value as keyof typeof hints];
    for (const id of ["export-time", "export-direction"])
      get<HTMLInputElement>(id).disabled = scope.value === "selection";
  };
  get("export-log").onclick = () => {
    captured = context();
    selection = selectedText();
    scope.querySelector<HTMLOptionElement>('[value="session"]')!.disabled =
      !captured.snapshot?.sessionFile || captured.snapshot.fileKind === "text";
    scope.querySelector<HTMLOptionElement>('[value="selection"]')!.disabled =
      !selection;
    scope.value = selection
      ? "selection"
      : captured.filter.query || captured.filter.exclude
        ? "filtered"
        : "cache";
    scope.dispatchEvent(new Event("change"));
    status.textContent = "";
    dialog.showModal();
  };
  const cancel = () => {
    if (running)
      void api.cancelExport().catch((error) => {
        status.textContent = String(error);
      });
    else dialog.close();
  };
  close.onclick = cancel;
  dialog.addEventListener("cancel", (event) => {
    if (running) {
      event.preventDefault();
      cancel();
    }
  });
  submit.onclick = async () => {
    if (running) return;
    running = true;
    submit.disabled = true;
    scope.disabled = true;
    close.textContent = "取消导出";
    status.textContent = "请选择目标文件；导出期间可以取消。";
    try {
      const result = await api.exportLog({
        ...captured.filter,
        scope: scope.value as "cache" | "filtered" | "session" | "selection",
        sessionId: captured.snapshot?.sessionId ?? "",
        mode: captured.mode,
        afterRowId: captured.afterRowId,
        selection,
        timestamps: get<HTMLInputElement>("export-time").checked,
        direction: get<HTMLInputElement>("export-direction").checked,
      });
      status.textContent = result
        ? `已导出 ${result.rows} 行 · ${(result.bytes / 1024).toFixed(1)} KiB\n${result.file}${result.warning ? "\n" + result.warning : ""}`
        : "未导出文件。";
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      running = false;
      submit.disabled = false;
      scope.disabled = false;
      close.textContent = "关闭";
    }
  };
}
