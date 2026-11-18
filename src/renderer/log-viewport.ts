import type { LogRow } from "../shared";

// Limit spans even for machine-generated rows containing thousands of values.
function appendLogText(parent: HTMLElement, text: string) {
  const tokens =
    /\b(?:error|warn(?:ing)?|fatal)\b|(?<=^|\])(?:E|W)(?=:)|\b0x[\da-f]+\b|(?<=[=:])\s*[-+]?\d+(?:\.\d+)?\b/gi;
  let offset = 0,
    count = 0;
  for (const match of text.matchAll(tokens)) {
    if (count++ >= 24) break;
    const span = document.createElement("span");
    span.className = /^[ewf]/i.test(match[0]) ? "log-warning" : "log-value";
    span.textContent = match[0];
    parent.append(text.slice(offset, match.index), span);
    offset = match.index! + match[0].length;
  }
  parent.append(text.slice(offset));
}

/** Keep wrapped rows readable while mounting only the visible part of a larger cache. */
export class LogViewport {
  private rows: LogRow[] = [];
  private heights = new WeakMap<LogRow, number>();
  private offsets: number[] = [0];
  private widths = new WeakMap<LogRow, number>();
  private measure = document.createElement("canvas").getContext("2d")!;
  private fontKey = "";
  private geometryKey = "";
  private contiguous = false;
  private mounted = new Map<LogRow, HTMLElement>();
  private lineHeight = 20;
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
  private allRange?: Range;
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
    const menu = document.getElementById("log-context")!;
    const copy = document.getElementById(
      "copy-log-selection",
    ) as HTMLButtonElement;
    const all = document.getElementById("select-log-all") as HTMLButtonElement;
    let menuSelection = "";
    element.addEventListener("mousedown", (event) => {
      if (event.button === 2) event.preventDefault();
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      menuSelection = this.selectedText();
      copy.disabled = !menuSelection;
      all.disabled = !this.rows.length;
      menu.showPopover();
      const rect = element.getBoundingClientRect();
      menu.style.left =
        Math.min(event.clientX || rect.left, innerWidth - menu.offsetWidth) +
        "px";
      menu.style.top =
        Math.min(event.clientY || rect.top, innerHeight - menu.offsetHeight) +
        "px";
      (copy.disabled ? all : copy).focus();
    });
    copy.onclick = () => {
      menu.hidePopover();
      element.focus({ preventScroll: true });
      // Use the selection captured before menu focus changed the native range.
      try {
        document.execCommand("copy");
      } finally {
        menuSelection = "";
      }
    };
    all.onclick = () => {
      menu.hidePopover();
      this.selectAll();
    };
    menu.addEventListener("toggle", () => {
      if (!menu.matches(":popover-open")) menuSelection = "";
    });
    document.addEventListener("selectionchange", () => {
      const selection = window.getSelection();
      if (
        selection &&
        !this.isAllSelected(selection) &&
        !selection.isCollapsed &&
        element.contains(selection.anchorNode) &&
        element.contains(selection.focusNode)
      )
        this.prepareSelection();
    });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        if (
          event.altKey ||
          event.shiftKey ||
          event.isComposing ||
          document.querySelector("dialog[open], [popover]:popover-open") ||
          (event.target as Element).closest(
            "input, textarea, select, [contenteditable=true]",
          )
        )
          return;
        event.preventDefault();
        this.selectAll();
      }
    });
    document.addEventListener("copy", (event) => {
      event.preventDefault();
      if (document.activeElement !== element) return;
      const value = menuSelection || this.selectedText();
      if (value) event.clipboardData?.setData("text/plain", value);
    });
    document.addEventListener("cut", (event) => event.preventDefault());
    // Once a new pointer action begins, return to the lightweight scrolling view.
    document.addEventListener("pointerdown", (event) => {
      if (event.button === 2 || menu.contains(event.target as Node)) return;
      if (!(event.target as Element).closest("#export-log"))
        this.allRange = undefined;
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
  private selectAll() {
    if (!this.rows.length) return;
    this.element.focus({ preventScroll: true });
    this.onBrowse();
    const range = document.createRange();
    range.selectNodeContents(this.element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    this.allRange = selection.getRangeAt(0).cloneRange();
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
    return (
      time + (time && !dir ? " " : "") + dir + row.text.replaceAll("\0", "␀")
    );
  }
  private isAllSelected(selection: Selection) {
    if (!this.allRange || selection.isCollapsed || !selection.rangeCount)
      return false;
    const range = selection.getRangeAt(0);
    return (
      range.compareBoundaryPoints(Range.START_TO_START, this.allRange) === 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, this.allRange) === 0
    );
  }
  selectedText() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return "";
    const range = selection.getRangeAt(0);
    if (!this.element.contains(range.commonAncestorContainer)) return "";
    if (this.isAllSelected(selection))
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
    contiguous = false,
  ) {
    this.allRange = undefined;
    this.endSelection();
    const previous = this.contiguous && contiguous ? this.rows : [];
    this.contiguous = contiguous;
    this.rows = rows;
    this.follow = follow;
    this.empty = empty;
    if (this.highlights !== highlights) this.mounted.clear();
    this.highlights = highlights;
    this.activeId = activeId;
    this.reindex(previous);
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
    this.mounted.clear();
    this.reindex();
    this.signature = "";
    this.draw(true);
  }
  private reindex(previous: LogRow[] = []) {
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
    this.lineHeight = line;
    const geometryKey = [
      fontKey,
      available,
      line,
      wrap,
      this.showTime,
      this.showDirection,
    ].join("|");
    const sameGeometry = this.geometryKey === geometryKey;
    if (!sameGeometry) {
      this.heights = new WeakMap();
      this.mounted.clear();
      this.geometryKey = geometryKey;
    }
    this.measure.font = fontKey;
    let widest = 0;

    let index = 0,
      bottom = 0;
    // Delta snapshots retain the same immutable rows except for their provisional tail.
    if (wrap && sameGeometry && previous.length > 1 && this.rows.length) {
      const skipped = this.rows[0].id - previous[0].id;
      const keep = Math.min(previous.length - skipped - 1, this.rows.length);
      if (
        skipped >= 0 &&
        keep > 0 &&
        previous[skipped] === this.rows[0] &&
        previous[skipped + keep - 1] === this.rows[keep - 1]
      ) {
        const origin = this.offsets[skipped];
        if (skipped)
          for (let i = 1; i <= keep; i++)
            this.offsets[i] = this.offsets[i + skipped] - origin;
        index = keep;
        bottom = this.offsets[keep];
      }
    }
    this.offsets.length = this.rows.length + 1;
    while (index < this.rows.length) {
      const row = this.rows[index];
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
    const y = this.element.scrollTop;
    const start = this.follow
      ? Math.max(
          0,
          this.rows.length -
            Math.ceil(this.element.clientHeight / this.lineHeight) -
            12,
        )
      : Math.max(0, this.indexAt(y) - 12);
    const end = this.follow
      ? this.rows.length
      : Math.min(
          this.rows.length,
          this.indexAt(y + this.element.clientHeight) + 13,
        );
    const signature = `${start}:${end}:${this.activeId}`;
    if (!update && signature === this.signature) return;
    this.signature = signature;
    this.firstMounted = start;
    this.afterMounted = end;
    const nextMounted = new Map<LogRow, HTMLElement>();
    const nodes: { row: LogRow; node: HTMLElement }[] = [];
    for (const row of this.rows.slice(start, end)) {
      const existing = this.mounted.get(row);
      const node = existing ?? document.createElement("div");
      if (!existing) {
        node.className = "log-row " + row.dir.toLowerCase();
        node.dataset.rowId = String(row.id);
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
        // Windows plain-text clipboard readers stop at a literal NUL.
        const text = row.text.replaceAll("\0", "␀");
        let offset = 0;
        for (const hit of this.highlights(row.text)) {
          appendLogText(content, text.slice(offset, hit.start));
          const mark = document.createElement("mark");
          mark.textContent = text.slice(hit.start, hit.end);
          content.append(mark);
          offset = hit.end;
        }
        appendLogText(content, text.slice(offset));
        node.append(time, dir, content);
      }
      node.classList.toggle("search-current", row.id === this.activeId);
      node.classList.toggle("time-selected", this.selected.has(row.id));
      nextMounted.set(row, node);
      nodes.push({ row, node });
    }
    if (!this.mounted.size) this.body.replaceChildren();
    for (const [row, node] of this.mounted)
      if (!nextMounted.has(row)) node.remove();
    this.mounted = nextMounted;
    let cursor = this.body.firstChild;
    for (const { node } of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else this.body.insertBefore(node, cursor);
    }
    if (!this.rows.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = this.empty;
      this.body.replaceChildren(p);
    }

    // Only mounted rows gained new measurements. Shift the remaining offsets
    // by their combined correction instead of measuring the whole cache again.
    const oldEnd = this.offsets[end];
    for (let i = 0; i < nodes.length; i++) {
      const { row, node } = nodes[i];
      const height =
        this.heights.get(row) ?? node.getBoundingClientRect().height;
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
    if (this.follow) this.element.scrollTop = this.element.scrollHeight;
    this.lastScroll = this.element.scrollTop;
  }
}
