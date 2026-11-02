import type { LogRow } from "../shared";

/** Keep wrapped rows readable while mounting only the visible part of a larger cache. */
export class LogViewport {
  private rows: LogRow[] = [];
  private heights = new Map<number, { text: string; height: number }>();
  private offsets: number[] = [0];
  private follow = true;
  private empty = "";
  private frame = 0;
  private signature = "";
  private timeFormat = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  private top = document.createElement("div");
  private body = document.createElement("div");
  private bottom = document.createElement("div");
  constructor(private element: HTMLElement) {
    this.top.setAttribute("aria-hidden", "true");
    this.bottom.setAttribute("aria-hidden", "true");
    element.replaceChildren(this.top, this.body, this.bottom);
    element.addEventListener("scroll", () => {
      if (!this.frame)
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.draw();
        });
    });
    new ResizeObserver(() => this.refresh()).observe(element);
  }
  set(rows: LogRow[], follow: boolean, empty: string) {
    this.rows = rows;
    this.follow = follow;
    this.empty = empty;
    const retained = new Set(rows.map((row) => row.id));
    for (const id of this.heights.keys())
      if (!retained.has(id)) this.heights.delete(id);
    this.reindex();
    this.signature = "";
    this.draw(true);
  }
  setFollowing(follow: boolean) {
    this.follow = follow;
  }
  refresh() {
    this.heights.clear();
    this.reindex();
    this.signature = "";
    this.draw(true);
  }
  private reindex() {
    const style = getComputedStyle(this.element);
    const font = parseFloat(style.fontSize) || 14;
    const line = parseFloat(style.lineHeight) || font * 1.65;
    const main = this.element.closest("main")!;
    const columnStyle = getComputedStyle(main);
    const time = main.classList.contains("hide-time")
      ? 0
      : parseFloat(columnStyle.getPropertyValue("--time-width")) || 118;
    const dir = main.classList.contains("hide-direction")
      ? 0
      : parseFloat(columnStyle.getPropertyValue("--direction-width")) || 52;
    const chars = Math.max(
      8,
      (this.element.clientWidth - time - dir - 70) / (font * 0.65),
    );
    this.offsets = [0];
    for (const row of this.rows) {
      const cached = this.heights.get(row.id);
      const height =
        cached?.text === row.text
          ? cached.height
          : Math.max(
              26,
              Math.ceil(Math.max(1, row.text.length) / chars) * line + 2,
            );
      this.offsets.push(this.offsets.at(-1)! + height);
    }
  }
  private indexAt(y: number) {
    let low = 0,
      high = this.rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.offsets[mid + 1] < y) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  private draw(update = false) {
    const total = this.offsets.at(-1)!;
    const y =
      update && this.follow
        ? Math.max(0, total - this.element.clientHeight)
        : this.element.scrollTop;
    const start = Math.max(0, this.indexAt(y) - 12);
    const end = Math.min(
      this.rows.length,
      this.indexAt(y + this.element.clientHeight) + 13,
    );
    const signature = `${start}:${end}`;
    if (!update && signature === this.signature) return;
    this.signature = signature;
    const fragment = document.createDocumentFragment();
    const nodes: { row: LogRow; node: HTMLElement }[] = [];
    for (const row of this.rows.slice(start, end)) {
      const node = document.createElement("div");
      node.className = "log-row " + row.dir.toLowerCase();
      const time = document.createElement("span");
      time.className = "time";
      time.textContent =
        this.timeFormat.format(new Date(row.at)) + "." + row.at.slice(20, 23);
      time.title = row.at;
      const dir = document.createElement("span");
      dir.className = "direction";
      dir.textContent = row.dir;
      dir.title = row.dir;
      const content = document.createElement("span");
      content.className = "content";
      content.textContent = row.text;
      node.append(time, dir, content);
      fragment.append(node);
      nodes.push({ row, node });
    }
    if (!this.rows.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = this.empty;
      fragment.append(p);
    }
    this.body.replaceChildren(fragment);
    for (const { row, node } of nodes)
      this.heights.set(row.id, {
        text: row.text,
        height: node.getBoundingClientRect().height,
      });
    this.reindex();
    this.top.style.height = `${this.offsets[start]}px`;
    this.bottom.style.height = `${this.offsets.at(-1)! - this.offsets[end]}px`;
    if (update && this.follow)
      this.element.scrollTop = this.element.scrollHeight;
  }
}
