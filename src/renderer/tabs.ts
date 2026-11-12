import type { Api, TabState } from "../shared";

export function setupTabs(
  api: Api,
  failure: (error: unknown) => void,
  onForeground: (foreground: boolean) => void,
) {
  const strip = document.getElementById("serial-tabs")!;
  const add = document.getElementById("add-tab")!;
  const before = document.getElementById("tabs-before") as HTMLButtonElement;
  const after = document.getElementById("tabs-after") as HTMLButtonElement;
  const bar = strip.parentElement!;
  function updateArrows() {
    before.disabled = strip.scrollLeft < 1;
    after.disabled =
      strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
  }
  function fitTabs() {
    before.hidden = after.hidden = true;
    const overflow = strip.scrollWidth > strip.clientWidth + 1;
    before.hidden = after.hidden = !overflow;
    updateArrows();
  }
  const move = (direction: number) =>
    strip.scrollBy(direction * strip.clientWidth * 0.8, 0);
  before.onclick = () => move(-1);
  after.onclick = () => move(1);
  strip.addEventListener("scroll", updateArrows);
  new ResizeObserver(() => {
    fitTabs();
    strip
      .querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }).observe(bar);
  let current: TabState | undefined;
  function render(state: TabState) {
    if (current?.foreground !== state.foreground)
      onForeground(state.foreground);
    if (!state.foreground) {
      current = state;
      return;
    }
    const focused = strip.contains(document.activeElement)
      ? document.activeElement
      : null;
    const focusedId = focused?.parentElement?.dataset.tabId;
    const previous = current?.activeId;
    current = state;
    const nodes = state.tabs.map((tab) => {
      const group = document.createElement("div");
      group.className = "serial-tab";
      group.dataset.tabId = String(tab.id);
      const active = tab.id === state.activeId;
      group.classList.toggle("active", active);
      const select = document.createElement("button");
      select.type = "button";
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(active));
      select.tabIndex = active ? 0 : -1;
      select.title = tab.label + (tab.connected ? " · 已连接" : "");
      select.textContent = tab.label;
      select.classList.toggle("connected", tab.connected);
      select.onclick = () => void api.selectTab(tab.id).catch(failure);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "close-tab";
      close.textContent = "×";
      close.title = "关闭 " + tab.label;
      close.setAttribute("aria-label", close.title);
      close.onclick = () => void api.closeTab(tab.id).catch(failure);
      group.append(select, close);
      return group;
    });
    strip.replaceChildren(...nodes);
    fitTabs();
    const active = strip.querySelector<HTMLElement>('[aria-selected="true"]');
    if (previous !== state.activeId)
      active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focused) {
      const group = nodes.find((node) => node.dataset.tabId === focusedId);
      const control = group?.querySelector<HTMLElement>(
        focused.matches(".close-tab") ? ".close-tab" : '[role="tab"]',
      );
      (control ?? active)?.focus({ preventScroll: true });
    }
  }
  api.onTabsChanged(render);
  void api
    .tabState()
    .then((state) => {
      if (!current) render(state);
    })
    .catch(failure);
  add.onclick = () => void api.newTab().catch(failure);
  document.addEventListener("keydown", (event) => {
    if (event.isComposing || !current || document.querySelector("dialog[open]"))
      return;
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    const inStrip = strip.contains(event.target as Node);
    const tabs = current.tabs;
    const index = tabs.findIndex((tab) => tab.id === current!.activeId);
    if (index < 0) return;
    if (mod && (key === "t" || key === "n" || key === "w")) {
      event.preventDefault();
      if (!event.repeat)
        void (
          key === "w" ? api.closeTab(current.activeId) : api.newTab()
        ).catch(failure);
    } else if (
      (mod && key === "tab") ||
      (inStrip && ["arrowleft", "arrowright"].includes(key))
    ) {
      event.preventDefault();
      const step = key === "arrowleft" || event.shiftKey ? -1 : 1;
      void api
        .selectTab(tabs[(index + step + tabs.length) % tabs.length].id)
        .catch(failure);
    }
  });
}
