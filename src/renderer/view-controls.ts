import {
  DEFAULT_VIEW_LIMITS,
  validateViewLimits,
  estimateViewMemory,
  type ViewLimits,
} from "../view-settings";
interface Preferences {
  wrapLines: boolean;
  showTime: boolean;
  showDirection: boolean;
  fontSize: number;
  limits: ViewLimits;
}
export function setupViewControls(
  onGeometry: () => void,
  onLimits: (limits: ViewLimits) => Promise<void>,
  onError: (error: unknown) => void,
) {
  const key = "baudloom.view.v1";
  const prefs: Preferences = {
    wrapLines: true,
    showTime: true,
    showDirection: true,
    fontSize: 14,
    limits: { ...DEFAULT_VIEW_LIMITS },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    for (const field of ["showTime", "showDirection", "wrapLines"] as const)
      if (typeof saved[field] === "boolean") prefs[field] = saved[field];
    for (const [field, min, max] of [["fontSize", 10, 28]] as const)
      if (
        Number.isFinite(saved[field]) &&
        saved[field] >= min &&
        saved[field] <= max
      )
        prefs[field] = saved[field];
    if (saved.limits) prefs.limits = validateViewLimits(saved.limits);
  } catch {}
  const get = <T extends HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const main = document.querySelector("main")!;
  const toggle = get<HTMLButtonElement>("view-options");
  const time = get<HTMLInputElement>("show-time"),
    dir = get<HTMLInputElement>("show-direction"),
    font = get<HTMLInputElement>("log-font-size");
  const rows = get<HTMLInputElement>("view-max-rows"),
    chars = get<HTMLSelectElement>("view-max-chars");
  function save() {
    try {
      localStorage.setItem(key, JSON.stringify(prefs));
    } catch {}
  }
  function apply() {
    main.classList.toggle("no-wrap", !prefs.wrapLines);
    main.classList.toggle("hide-time", !prefs.showTime);
    main.classList.toggle("hide-direction", !prefs.showDirection);
    main.style.setProperty("--log-font-size", `${prefs.fontSize}px`);
    onGeometry();
  }
  function estimate() {
    try {
      const limits = validateViewLimits({
        maxRows: Number(rows.value),
        maxChars: Number(chars.value) * 1048576,
      });
      const { low, high } = estimateViewMemory(limits);
      get("view-memory").textContent =
        `缓存占满时粗估额外占用约 ${low}–${high} MiB（含原始缓存、文本/HEX、快照及界面）。不是实测值或硬上限，不含程序基础内存；行长、编码和补写过程都会影响占用。`;
    } catch (error) {
      get("view-memory").textContent = String(error);
    }
  }
  const wrap = get<HTMLInputElement>("wrap-lines");
  wrap.checked = prefs.wrapLines;
  wrap.onchange = () => {
    prefs.wrapLines = wrap.checked;
    apply();
    save();
  };
  time.checked = prefs.showTime;
  dir.checked = prefs.showDirection;
  font.value = String(prefs.fontSize);
  rows.value = String(prefs.limits.maxRows);
  chars.value = String(prefs.limits.maxChars / 1048576);
  time.onchange = () => {
    prefs.showTime = time.checked;
    apply();
    save();
  };
  dir.onchange = () => {
    prefs.showDirection = dir.checked;
    apply();
    save();
  };
  font.onchange = () => {
    if (!font.reportValidity()) return;
    prefs.fontSize = Math.max(10, Math.min(28, Math.round(Number(font.value))));
    apply();
    save();
  };
  rows.oninput = chars.onchange = estimate;
  get<HTMLButtonElement>("apply-view-limits").onclick = async () => {
    const button = get<HTMLButtonElement>("apply-view-limits");
    try {
      const limits = validateViewLimits({
        maxRows: Number(rows.value),
        maxChars: Number(chars.value) * 1048576,
      });
      button.disabled = true;
      await onLimits(limits);
      prefs.limits = limits;
      save();
      get("view-applied").textContent =
        "已应用；缩小上限会淘汰最早缓存，增大不会恢复已淘汰内容。";
    } catch (error) {
      onError(error);
    } finally {
      button.disabled = false;
    }
  };
  const dialog = get<HTMLDialogElement>("view-dialog");
  toggle.onclick = () => {
    dialog.showModal();
    toggle.setAttribute("aria-expanded", "true");
  };
  get("view-close").onclick = () => dialog.close();
  dialog.addEventListener("close", () =>
    toggle.setAttribute("aria-expanded", "false"),
  );
  apply();
  estimate();
  return { limits: prefs.limits };
}
