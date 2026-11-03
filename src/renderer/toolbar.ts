/** Keep infrequent receive actions in one dismissible menu at every window size. */
export function setupToolbar() {
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
