/** Keep the receive/send split adjustable without adding permanent tool panes. */
export function setupLayout() {
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  const composer = document.querySelector<HTMLElement>(".composer")!;
  const handle = document.getElementById("bottom-splitter")!;
  const key = "baudloom.layout.v1";
  let preferred: number | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}").bottom;
    if (Number.isFinite(value) && value >= 100 && value <= 4000)
      preferred = value;
  } catch {}
  const maximum = () => Math.max(100, workspace.clientHeight - 165);
  function apply() {
    composer.style.maxHeight = `${maximum()}px`;
    composer.style.height =
      preferred === null
        ? ""
        : `${Math.max(100, Math.min(maximum(), preferred))}px`;
    handle.setAttribute(
      "aria-valuenow",
      String(Math.round(composer.getBoundingClientRect().height)),
    );
    handle.setAttribute("aria-valuemin", "100");
    handle.setAttribute("aria-valuemax", String(maximum()));
  }
  function save() {
    try {
      localStorage.setItem(key, JSON.stringify({ bottom: preferred }));
    } catch {}
  }
  let dragging = false,
    y = 0,
    height = 0;
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    dragging = true;
    y = event.clientY;
    height = composer.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing");
    event.preventDefault();
  };
  handle.onpointermove = (event) => {
    if (!dragging) return;
    preferred = Math.max(100, Math.min(maximum(), height + y - event.clientY));
    apply();
  };
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    save();
  };
  handle.onpointerup =
    handle.onpointercancel =
    handle.onlostpointercapture =
      finish;
  handle.ondblclick = () => {
    preferred = null;
    apply();
    save();
  };
  handle.onkeydown = (event) => {
    if (event.key === "Home") preferred = null;
    else if (["ArrowUp", "ArrowDown"].includes(event.key))
      preferred = Math.max(
        100,
        Math.min(
          maximum(),
          composer.getBoundingClientRect().height +
            (event.key === "ArrowUp" ? 16 : -16),
        ),
      );
    else return;
    event.preventDefault();
    apply();
    save();
  };
  const observer = new ResizeObserver(apply);
  observer.observe(workspace);
  observer.observe(composer);
  apply();
}
