import type { LogRow } from "../shared";

/** Keep wrapped rows readable while mounting only the visible part of a larger cache. */
export class LogViewport {
  private rows: LogRow[] = [];
  private heights = new WeakMap<LogRow, number>();
  private offsets: number[] = [0];
  private widths = new WeakMap<LogRow, number>();
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
  private firstMounted = 0;
  private afterMounted = 0;
  private selecting = false;
  private showTime = true;
  private showDirection = true;
  onBrowse: () => void = () => {};
  onReachTail: () => void = () => {};
  private atTail() {
    return (
      this.element.scrollHeight -
        this.element.clientHeight -
        this.element.scrollTop <=
      2
    );
  }
  private resumeAtTail() {
    if (!this.follow && this.atTail() && window.getSelection()?.isCollapsed)
      this.onReachTail();
  }
  selectRows(ids: number[]) {
    this.selected = new Set(ids);
    this.draw(true);
  }
  constructor(private element: HTMLElement) {
    element.replaceChildren(this.top, this.body, this.bottom);
    document.addEventListener("selectionchange", () => {
      const selection = window.getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        element.contains(selection.anchorNode) &&
        element.contains(selection.focusNode)
      )
        this.prepareSelection();
    });
    element.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        if (!this.rows.length) return;
        this.prepareSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
    document.addEventListener("copy", (event) => {
      event.preventDefault();
      if (document.activeElement !== element) return;
      const value = this.selectedText();
      if (value) event.clipboardData?.setData("text/plain", value);
    });
    document.addEventListener("cut", (event) => event.preventDefault());
    // Once a new pointer action begins, return to the lightweight scrolling view.
    document.addEventListener("pointerdown", (event) => {
      if (!this.selecting || element.contains(event.target as Node)) return;
      // Export reads the current selection when its button is clicked.
      if ((event.target as Element).closest("#export-log")) return;
      this.endSelection();
      this.draw(true);
    });
    element.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY < 0 && this.follow && this.rows.length) this.onBrowse();
        else if (e.deltaY > 0) this.resumeAtTail();
      },
      { passive: true },
    );
    element.addEventListener("keydown", (e) => {
      if (["End", "PageDown", "ArrowDown"].includes(e.key)) this.resumeAtTail();
      if (
        ["ArrowUp", "PageUp", "Home"].includes(e.key) &&
        this.follow &&
        this.rows.length
      )
        this.onBrowse();
    });
    element.addEventListener("scroll", () => {
      // Enlarging the log can clamp scrollTop even while it is still at the tail.
      if (element.scrollTop > this.lastScroll) this.resumeAtTail();
      if (
        this.follow &&
        !this.atTail() &&
        element.scrollTop < this.lastScroll - 2
      )
        this.onBrowse();
      this.lastScroll = element.scrollTop;
      if (!this.frame)
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.draw();
        });
    });
    new ResizeObserver(() => this.refresh()).observe(element);
  }
  private timeText(row: LogRow) {
    return this.showTime && row.at
      ? `[${this.timeFormat.format(new Date(row.at))}.${row.at.slice(20, 23)}]`
      : "";
  }
  private directionText(row: LogRow) {
    if (!this.showDirection) return "";
    if (row.dir === "RX") return "收← ";
    if (row.dir === "TX") return "发→ ";
    return row.dir + " ";
  }
  private lineText(row: LogRow) {
    const time = this.timeText(row);
    const dir = this.directionText(row);
    return time + (time && !dir ? " " : "") + dir + row.text;
  }
  selectedText() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return "";
    const range = selection.getRangeAt(0);
    if (!this.element.contains(range.commonAncestorContainer)) return "";
    if (
      range.startContainer === this.element &&
      range.startOffset === 0 &&
      range.endContainer === this.element &&
      range.endOffset === this.element.childNodes.length
    )
      return this.rows.map((row) => this.lineText(row)).join("\n");
    return selection.toString();
  }
  private prepareSelection() {
    if (this.selecting || !this.rows.length) return;
    this.onBrowse();
    this.selecting = true;
    const anchorY = this.body.getBoundingClientRect().top;
    // Populate the two virtual spacers as text chunks. Keep the nodes under the
    // pointer intact so Chromium can extend a native selection across screens.
    const fill = (parent: HTMLElement, start: number, end: number) => {
      const fragment = document.createDocumentFragment();
      for (let i = start; i < end; i += 128) {
        const chunk = document.createElement("div");
        chunk.className = "selection-chunk";
        chunk.textContent = this.rows
          .slice(i, Math.min(i + 128, end))
          .map((row) => this.lineText(row))
          .join("\n");
        fragment.append(chunk);
      }
      parent.style.height = "";
      parent.replaceChildren(fragment);
    };
    fill(this.top, 0, this.firstMounted);
    fill(this.bottom, this.afterMounted, this.rows.length);
    this.element.scrollTop += this.body.getBoundingClientRect().top - anchorY;
  }
  private endSelection() {
    if (!this.selecting) return;
    this.selecting = false;
    this.top.replaceChildren();
    this.bottom.replaceChildren();
    this.signature = "";
  }
  set(
    rows: LogRow[],
    follow: boolean,
    empty: string,
    highlights = this.highlights,
    activeId = 0,
  ) {
    this.endSelection();
    this.rows = rows;
    this.follow = follow;
    this.empty = empty;
    this.highlights = highlights;
    this.activeId = activeId;
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
    if (this.selecting) return;
    this.heights = new WeakMap();
    this.reindex();
    this.signature = "";
    this.draw(true);
  }
  private reindex() {
    const style = getComputedStyle(this.element);
    const font = parseFloat(style.fontSize) || 14;
    const line = parseFloat(style.lineHeight) || font * 1.43;
    const main = this.element.closest("main")!;
    this.showTime = !main.matches(".plain-text, .hide-time");
    this.showDirection = !main.matches(".plain-text, .hide-direction");
    const wrap = !main.classList.contains("no-wrap");
    const available = Math.max(
      1,
      this.element.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight),
    );
    const prefix =
      (Number(this.showTime) * 15 + Number(this.showDirection) * 5) *
      font *
      0.65;
    const chars = Math.max(8, available / (font * 0.65));
    const fontKey = `${style.fontSize} ${style.fontFamily}`;
    if (fontKey !== this.fontKey) {
      this.fontKey = fontKey;
      this.widths = new WeakMap();
    }
    this.measure.font = fontKey;
    let widest = 0;
    this.offsets.length = this.rows.length + 1;
    let index = 0,
      bottom = 0;
    for (const row of this.rows) {
      if (!wrap) {
        let width = this.widths.get(row);
        if (width === undefined) {
          // Measuring only new/changed rows keeps horizontal extent stable across virtualization.
          width = Math.max(
            ...row.text
              .split("\n")
              .map(
                (s) => this.measure.measureText(s.replace(/\t/g, "    ")).width,
              ),
          );
          this.widths.set(row, width);
        }
        widest = Math.max(widest, width);
      }
      const height =
        this.heights.get(row) ??
        Math.max(
          line,
          (wrap
            ? Math.ceil(
                Math.max(
                  1,
                  row.text.length +
                    Number(this.showTime) * 15 +
                    Number(this.showDirection) * 5,
                ) / chars,
              )
            : row.text.split("\n").length) * line,
        );
      bottom += height;
      this.offsets[++index] = bottom;
    }
    const width = wrap
      ? available
      : Math.max(available, Math.ceil(prefix + widest + 2));
    for (const node of [this.top, this.body, this.bottom])
      node.style.width = `${width}px`;
    if (wrap) this.element.scrollLeft = 0;
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
    if (this.selecting) return;
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
    this.firstMounted = start;
    this.afterMounted = end;
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
      const stamp = this.timeText(row);
      time.textContent = stamp + (stamp && !this.showDirection ? " " : "");
      time.title = row.at;
      const dir = document.createElement("span");
      dir.className = "direction";
      dir.textContent = this.directionText(row);
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
    // Only mounted rows gained new measurements. Shift the remaining offsets
    // by their combined correction instead of measuring the whole cache again.
    const oldEnd = this.offsets[end];
    for (let i = 0; i < nodes.length; i++) {
      const { row, node } = nodes[i];
      const height = node.getBoundingClientRect().height;
      this.heights.set(row, height);
      this.offsets[start + i + 1] = this.offsets[start + i] + height;
    }
    const shift = this.offsets[end] - oldEnd;
    if (shift) {
      for (let i = end + 1; i < this.offsets.length; i++)
        this.offsets[i] += shift;
    }
    this.top.style.height = `${this.offsets[start]}px`;
    this.bottom.style.height = `${this.offsets.at(-1)! - this.offsets[end]}px`;
    if (update && this.follow)
      this.element.scrollTop = this.element.scrollHeight;
    this.lastScroll = this.element.scrollTop;
  }
}
