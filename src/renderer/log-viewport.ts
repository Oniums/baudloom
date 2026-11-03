import type { LogRow } from "../shared";

/** Keep wrapped rows readable while mounting only the visible part of a larger cache. */
export class LogViewport {
  private rows: LogRow[] = [];
  private heights = new Map<number, { text: string; height: number }>();
  private offsets: number[] = [0];
  private widths = new Map<number, { text: string; width: number }>();
  private measure = document.createElement("canvas").getContext("2d")!;
  private fontKey = "";
  private follow = true;
  private empty = "";
  private frame = 0;
  private signature = "";
  private activeId = 0;
  private highlights: (text: string) => { start: number; end: number }[] =
    () => [];
  private timeFormat = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  private top = document.createElement("div");
  private body = document.createElement("div");
  private bottom = document.createElement("div");
  private selected = new Set<number>();
  private lastScroll = 0;
  onBrowse: () => void = () => {};
  selectRows(ids: number[]) {
    this.selected = new Set(ids);
    this.draw(true);
  }
  constructor(private element: HTMLElement) {
    this.top.setAttribute("aria-hidden", "true");
    this.bottom.setAttribute("aria-hidden", "true");
    element.replaceChildren(this.top, this.body, this.bottom);
    element.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY < 0 && this.follow) this.onBrowse();
      },
      { passive: true },
    );
    element.addEventListener("keydown", (e) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key) && this.follow)
        this.onBrowse();
    });
    element.addEventListener("scroll", () => {
      if (this.follow && element.scrollTop < this.lastScroll - 2)
        this.onBrowse();
      this.lastScroll = element.scrollTop;
      (element.previousElementSibling as HTMLElement).scrollLeft =
        element.scrollLeft;
      if (!this.frame)
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.draw();
        });
    });
    new ResizeObserver(() => this.refresh()).observe(element);
  }
  set(
    rows: LogRow[],
    follow: boolean,
    empty: string,
    highlights = this.highlights,
    activeId = 0,
  ) {
    this.rows = rows;
    this.follow = follow;
    this.empty = empty;
    this.highlights = highlights;
    this.activeId = activeId;
    const retained = new Set(rows.map((row) => row.id));
    for (const id of this.heights.keys())
      if (!retained.has(id)) this.heights.delete(id);
    for (const id of this.widths.keys())
      if (!retained.has(id)) this.widths.delete(id);
    this.reindex();
    this.signature = "";
    this.draw(true);
  }
  setFollowing(follow: boolean) {
    this.follow = follow;
  }
  navigateTo(id: number) {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    this.follow = false;
    this.activeId = id;
    this.element.scrollTop = this.offsets[index];
    this.draw(true);
    this.element.scrollTop = this.offsets[index];
    this.lastScroll = this.element.scrollTop;
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
    const line = parseFloat(style.lineHeight) || font * 1.43;
    const main = this.element.closest("main")!;
    const head = main.querySelector<HTMLElement>(".column-head")!;
    const columnStyle = getComputedStyle(main);
    const headStyle = getComputedStyle(head);
    const time =
      main.classList.contains("hide-time") ||
      main.classList.contains("plain-text")
        ? 0
        : Math.min(
            this.element.clientWidth * 0.4,
            parseFloat(columnStyle.getPropertyValue("--time-width")) || 110,
          );
    const dir =
      main.classList.contains("hide-direction") ||
      main.classList.contains("plain-text")
        ? 0
        : Math.min(
            this.element.clientWidth * 0.22,
            parseFloat(columnStyle.getPropertyValue("--direction-width")) || 36,
          );
    const gap = parseFloat(headStyle.columnGap) || 8;
    const padding =
      parseFloat(headStyle.paddingLeft) + parseFloat(headStyle.paddingRight);
    const prefix =
      time + dir + gap * (Number(time > 0) + Number(dir > 0)) + padding;
    const wrap = !main.classList.contains("no-wrap");
    const chars = Math.max(
      8,
      (this.element.clientWidth - prefix) / (font * 0.65),
    );
    const fontKey = `${style.fontSize} ${style.fontFamily}`;
    if (fontKey !== this.fontKey) {
      this.fontKey = fontKey;
      this.widths.clear();
    }
    this.measure.font = fontKey;
    let widest = 0;
    this.offsets = [0];
    for (const row of this.rows) {
      if (!wrap) {
        let width = this.widths.get(row.id);
        if (!width || width.text !== row.text) {
          // Measuring only new/changed rows keeps horizontal extent stable across virtualization.
          width = {
            text: row.text,
            width: Math.max(
              ...row.text
                .split("\n")
                .map(
                  (s) =>
                    this.measure.measureText(s.replace(/\t/g, "    ")).width,
                ),
            ),
          };
          this.widths.set(row.id, width);
        }
        widest = Math.max(widest, width.width);
      }
      const cached = this.heights.get(row.id);
      const height =
        cached?.text === row.text
          ? cached.height
          : Math.max(
              22,
              (wrap
                ? Math.ceil(Math.max(1, row.text.length) / chars)
                : row.text.split("\n").length) *
                line +
                2,
            );
      this.offsets.push(this.offsets.at(-1)! + height);
    }
    const width = wrap
      ? this.element.clientWidth
      : Math.max(this.element.clientWidth, Math.ceil(prefix + widest + 2));
    const columns = [
      ...(time ? [`${time}px`] : []),
      ...(dir ? [`${dir}px`] : []),
      "minmax(0, 1fr)",
    ].join(" ");
    main.style.setProperty("--nowrap-columns", columns);
    for (const node of [this.top, this.body, this.bottom, head])
      node.style.width = `${width}px`;
    // The header must exclude the scrollbar gutter too, including at the rightmost edge.
    head.parentElement!.style.width = `${this.element.clientWidth}px`;
    if (wrap) this.element.scrollLeft = 0;
    (head.parentElement as HTMLElement).scrollLeft = this.element.scrollLeft;
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
    const signature = `${start}:${end}:${this.activeId}`;
    if (!update && signature === this.signature) return;
    this.signature = signature;
    const fragment = document.createDocumentFragment();
    const nodes: { row: LogRow; node: HTMLElement }[] = [];
    for (const row of this.rows.slice(start, end)) {
      const node = document.createElement("div");
      node.className = "log-row " + row.dir.toLowerCase();
      node.classList.toggle("search-current", row.id === this.activeId);
      node.dataset.rowId = String(row.id);
      node.classList.toggle("time-selected", this.selected.has(row.id));
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = row.at
        ? this.timeFormat.format(new Date(row.at)) + "." + row.at.slice(20, 23)
        : "";
      time.title = row.at;
      const dir = document.createElement("span");
      dir.className = "direction";
      dir.textContent = row.dir;
      dir.title = row.dir;
      const content = document.createElement("span");
      content.className = "content";
      let offset = 0;
      for (const hit of this.highlights(row.text)) {
        content.append(
          document.createTextNode(row.text.slice(offset, hit.start)),
        );
        const mark = document.createElement("mark");
        mark.textContent = row.text.slice(hit.start, hit.end);
        content.append(mark);
        offset = hit.end;
      }
      content.append(document.createTextNode(row.text.slice(offset)));
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
    this.lastScroll = this.element.scrollTop;
  }
}
