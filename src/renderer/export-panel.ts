import type { Api, Snapshot, ClearBoundary } from "../shared";
import type { LogFilter } from "../log-search";

export function setupExport(
  api: Api,
  selectedText: () => string,
  context: () => ClearBoundary & {
    snapshot: Snapshot | null;
    mode: "text" | "hex";
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
    cache:
      "包含清屏前和筛选隐藏的日志。超出内存上限的旧日志，可从已保存的会话导出。",
    filtered:
      "导出内存中符合当前显示条件的所有行，包括屏幕外的行。清屏前的内容会跳过。",
    session:
      "从会话文件读取所有分段，包括已移出内存的日志。正在记录时，导出截至开始导出时已保存的内容。",
    selection: "保留选区内的文字、时间和方向，与在接收区复制所选内容一致。",
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
        partial: captured.partial,
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
