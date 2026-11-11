/** Keep the receive/send split adjustable without adding permanent tool panes. */
export function setupLayout() {
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  const composer = document.querySelector<HTMLElement>(".composer")!;
  const handle = document.getElementById("bottom-splitter")!;
  const minimum = 56;
  const key = "baudloom.layout.v1";
  let preferred: number | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}").bottom;
    if (Number.isFinite(value) && value >= minimum && value <= 4000)
      preferred = value;
  } catch {}
  const divider = document.getElementById("bank-splitter")!;
  const bank = document.getElementById("command-bank")!;
  const widthKey = "baudloom.bank-width";
  const maxWidth = () => Math.min(720, Math.floor(window.innerWidth * 0.47));
  function setBankWidth(width: number | null) {
    if (width === null) {
      bank.style.removeProperty("--bank-width");
      localStorage.removeItem(widthKey);
    } else {
      const clamped = Math.max(255, Math.min(width, maxWidth()));
      bank.style.setProperty("--bank-width", clamped + "px");
      localStorage.setItem(widthKey, String(clamped));
    }
  }
  const savedWidth = Number(localStorage.getItem(widthKey));
  if (savedWidth >= 255)
    bank.style.setProperty("--bank-width", savedWidth + "px");
  let startX = 0,
    startWidth = 0;
  divider.onpointerdown = (event) => {
    if (event.button !== 0) return;
    startX = event.clientX;
    startWidth = bank.offsetWidth;
    divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  divider.onpointermove = (event) => {
    if (divider.hasPointerCapture(event.pointerId))
      setBankWidth(startWidth + startX - event.clientX);
  };
  divider.ondblclick = () => setBankWidth(null);
  divider.onkeydown = (event) => {
    if (event.key === "Home") setBankWidth(null);
    else if (event.key === "ArrowLeft") setBankWidth(bank.offsetWidth + 16);
    else if (event.key === "ArrowRight") setBankWidth(bank.offsetWidth - 16);
    else return;
    event.preventDefault();
  };
  new ResizeObserver(() => {
    divider.setAttribute("aria-valuemin", "255");
    divider.setAttribute("aria-valuemax", String(maxWidth()));
    divider.setAttribute("aria-valuenow", String(bank.offsetWidth));
  }).observe(bank);
  const maximum = () => Math.max(minimum, workspace.clientHeight - 165);
  function apply() {
    composer.style.maxHeight = `${maximum()}px`;
    composer.style.height =
      preferred === null
        ? ""
        : `${Math.max(minimum, Math.min(maximum(), preferred))}px`;
    handle.setAttribute(
      "aria-valuenow",
      String(Math.round(composer.getBoundingClientRect().height)),
    );
    handle.setAttribute("aria-valuemin", String(minimum));
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
    preferred = Math.max(
      minimum,
      Math.min(maximum(), height + y - event.clientY),
    );
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
        minimum,
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
