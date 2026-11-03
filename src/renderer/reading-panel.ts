import type { LogRow } from "../shared";
import { rowInterval } from "../log-reading";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
export function setupReading(
  navigate: (id: number) => void,
  selectRows: (ids: number[]) => void,
) {
  let rows: LogRow[] = [],
    first: LogRow | null = null,
    marks: LogRow[] = [],
    session = "";
  let timing = false;
  const choices = el<HTMLSelectElement>("mark-list");
  el("reading-options").onclick = () => {
    el("reading-panel").hidden = !el("reading-panel").hidden;
    el("reading-options").setAttribute(
      "aria-expanded",
      String(!el("reading-panel").hidden),
    );
  };
  el("reading-close").onclick = () => {
    el("reading-panel").hidden = true;
    el("reading-options").setAttribute("aria-expanded", "false");
    timing = false;
    first = null;
    selectRows([]);
    el("measure-time").setAttribute("aria-pressed", "false");
    el("time-difference").textContent = "";
  };
  const jump = (step: number) => {
    if (!marks.length) return;
    const i = marks.findIndex((r) => r.id === Number(choices.value));
    const row = marks[(i + step + marks.length) % marks.length];
    choices.value = String(row.id);
    navigate(row.id);
  };
  el("mark-prev").onclick = () => jump(-1);
  el("mark-next").onclick = () => jump(1);
  choices.onchange = () => {
    if (choices.value) navigate(Number(choices.value));
  };
  el("measure-time").onclick = () => {
    timing = !timing;
    first = null;
    selectRows([]);
    el("measure-time").setAttribute("aria-pressed", String(timing));
    el("time-difference").textContent = timing
      ? "依次点击两条日志；比较主机记录时刻，不代表串口线上字节间隔。"
      : "";
  };
  el("log").addEventListener("click", (e) => {
    if (!timing) return;
    const node = (e.target as Element).closest<HTMLElement>("[data-row-id]");
    const row = rows.find((r) => r.id === Number(node?.dataset.rowId));
    if (!row) return;
    if (!first) {
      first = { ...row };
      selectRows([row.id]);
      el("time-difference").textContent = `起点 #${row.id}，请选择终点`;
    } else {
      selectRows([first.id, row.id]);
      el("time-difference").textContent =
        `#${first.id} → #${row.id} · ${rowInterval(first, row)}`;
      first = null;
    }
  });
  let signature = "";
  return {
    update(next: LogRow[], key: string) {
      rows = next;
      if (key !== session) {
        session = key;
        first = null;
        selectRows([]);
        el("time-difference").textContent = "";
        signature = "";
      }
      marks = rows.filter((r) => r.dir === "MARK");
      const nextSignature = marks.map((r) => r.id).join(",");
      if (signature !== nextSignature) {
        signature = nextSignature;
        const old = choices.value;
        choices.replaceChildren(
          new Option(`缓存内标记（${marks.length}）`, ""),
          ...marks.map(
            (r) => new Option(`#${r.id} ${r.text.slice(0, 65)}`, String(r.id)),
          ),
        );
        if (marks.some((r) => String(r.id) === old)) choices.value = old;
      }
      el<HTMLButtonElement>("mark-prev").disabled = el<HTMLButtonElement>(
        "mark-next",
      ).disabled = !marks.length;
    },
  };
}
