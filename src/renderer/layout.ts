/** Persistent split sizes, including a joint handle at the three-pane intersection. */
export function setupLayout() {
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  const composer = document.querySelector<HTMLElement>(".composer")!;
  const bank = document.getElementById("command-bank")!;
  const side = document.getElementById("side-splitter")!;
  const bottom = document.getElementById("bottom-splitter")!;
  const cross = document.getElementById("cross-splitter")!;
  const key = "baudloom.layout.v1";
  const preferred: { side: number | null; bottom: number | null } = {
    side: null,
    bottom: null,
  };
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "{}");
    for (const field of ["side", "bottom"] as const)
      if (
        Number.isFinite(data[field]) &&
        data[field] >= 100 &&
        data[field] <= 4000
      )
        preferred[field] = data[field];
  } catch {}
  const limits = () => ({
    side: Math.max(280, workspace.clientWidth - 365),
    bottom: Math.max(100, workspace.clientHeight - 165),
  });
  function apply() {
    const bounds = limits();
    const width = Math.max(
      280,
      Math.min(
        bounds.side,
        preferred.side ?? (workspace.clientWidth <= 1000 ? 320 : 440),
      ),
    );
    bank.style.width = `${width}px`;
    side.hidden = cross.hidden = bank.hidden;
    composer.style.maxHeight = `${bounds.bottom}px`;
    composer.style.height =
      preferred.bottom === null
        ? ""
        : `${Math.max(100, Math.min(bounds.bottom, preferred.bottom))}px`;
    const rootRect = workspace.getBoundingClientRect();
    const sideRect = side.getBoundingClientRect(),
      bottomRect = bottom.getBoundingClientRect();
    cross.style.left = `${sideRect.x - rootRect.x + sideRect.width / 2 - 7}px`;
    cross.style.top = `${bottomRect.y - rootRect.y + bottomRect.height / 2 - 7}px`;
    for (const [handle, value, min, max] of [
      [side, width, 280, bounds.side],
      [bottom, composer.getBoundingClientRect().height, 100, bounds.bottom],
    ] as const) {
      handle.setAttribute("aria-valuenow", String(Math.round(value)));
      handle.setAttribute("aria-valuemin", String(min));
      handle.setAttribute("aria-valuemax", String(max));
    }
  }
  const persist = () => {
    try {
      localStorage.setItem(key, JSON.stringify(preferred));
    } catch {}
  };
  for (const [handle, fields] of [
    [side, ["side"]],
    [bottom, ["bottom"]],
    [cross, ["side", "bottom"]],
  ] as const) {
    let dragging = false,
      x = 0,
      y = 0,
      width = 0,
      height = 0;
    const change = (field: "side" | "bottom", value: number) => {
      preferred[field] = Math.max(
        field === "side" ? 280 : 100,
        Math.min(limits()[field], value),
      );
    };
    handle.onpointerdown = (event) => {
      if (event.button !== 0) return;
      dragging = true;
      x = event.clientX;
      y = event.clientY;
      width = bank.getBoundingClientRect().width;
      height = composer.getBoundingClientRect().height;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("resizing");
      event.preventDefault();
    };
    handle.onpointermove = (event) => {
      if (!dragging) return;
      for (const field of fields)
        change(
          field,
          field === "side"
            ? width + x - event.clientX
            : height + y - event.clientY,
        );
      apply();
    };
    const finish = () => {
      if (dragging) {
        dragging = false;
        document.body.classList.remove("resizing");
        persist();
      }
    };
    handle.onpointerup =
      handle.onpointercancel =
      handle.onlostpointercapture =
        finish;
    handle.ondblclick = () => {
      for (const field of fields) preferred[field] = null;
      apply();
      persist();
    };
    handle.onkeydown = (event) => {
      const field = ["ArrowLeft", "ArrowRight"].includes(event.key)
        ? "side"
        : ["ArrowUp", "ArrowDown"].includes(event.key)
          ? "bottom"
          : null;
      if (event.key === "Home") {
        for (const item of fields) preferred[item] = null;
      } else if (field && (fields as readonly string[]).includes(field)) {
        const value = (
          field === "side" ? bank : composer
        ).getBoundingClientRect()[field === "side" ? "width" : "height"];
        change(
          field,
          value + (["ArrowLeft", "ArrowUp"].includes(event.key) ? 16 : -16),
        );
      } else return;
      event.preventDefault();
      apply();
      persist();
    };
  }
  const observer = new ResizeObserver(apply);
  observer.observe(workspace);
  observer.observe(composer);
  new MutationObserver(apply).observe(bank, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  apply();
}
