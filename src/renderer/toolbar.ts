/** Keep infrequent receive actions in one dismissible menu at every window size. */
export function setupToolbar() {
  const focusLog = document.getElementById("focus-log")!;
  focusLog.onclick = () => {
    const focused = document.body.classList.toggle("log-only");
    focusLog.setAttribute("aria-pressed", String(focused));
    focusLog.textContent = focused ? "退出专注" : "专注";
    focusLog.title = focused ? "恢复发送区" : "收起发送区，专注日志";
  };
  const appearance = document.getElementById("appearance")!;
  function applyTheme(light: boolean) {
    const theme = light ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    void window.baudloom.setAppearance(theme).catch(console.error);
    appearance.setAttribute("aria-pressed", String(light));
  }
  applyTheme(localStorage.getItem("baudloom.appearance") === "light");
  window.addEventListener("storage", (event) => {
    if (event.key === "baudloom.appearance")
      applyTheme(event.newValue === "light");
  });
  appearance.onclick = () => {
    const light = document.documentElement.dataset.theme !== "light";
    applyTheme(light);
    localStorage.setItem("baudloom.appearance", light ? "light" : "dark");
  };
  const more = document.getElementById("more-tools")!;
  const menu = document.getElementById("more-tools-panel")!;
  menu.addEventListener("beforetoggle", (event) => {
    if ((event as ToggleEvent).newState !== "open") return;
    const rect = more.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - 204, rect.right - 196))}px`;
  });
  menu.addEventListener("click", (event) => {
    if (!(event.target as Element).closest("button")) return;
    menu.hidePopover();
    // A menu action may have opened a dialog; leave its focus intact.
    if (!document.querySelector("dialog[open]")) more.focus();
  });
  window.addEventListener("resize", () => menu.hidePopover());
}
