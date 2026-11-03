import {
  DEFAULT_SERIAL,
  serialSettings,
  serialSummary,
  type SerialSettings,
} from "../serial-settings";
import { readProfiles, validateProfile } from "../profiles";
import type { Snapshot } from "../shared";
import type { SendPanel } from "./send-panel";
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
export function setupConnectionPanel(
  send: SendPanel,
  context: () => Snapshot | null,
  failure: (e: unknown) => void,
) {
  const dialog = el<HTMLDialogElement>("connection-dialog"),
    baud = el<HTMLInputElement>("baud");
  const fields = [
    "dataBits",
    "stopBits",
    "parity",
    "flow",
    "dtr",
    "rts",
  ] as const;
  let saved = { ...DEFAULT_SERIAL };
  try {
    saved = serialSettings(
      JSON.parse(
        localStorage.getItem("baudloom.serial.v1") ?? JSON.stringify(saved),
      ),
    );
  } catch {}
  let profiles: ReturnType<typeof readProfiles> = [];
  try {
    profiles = readProfiles(localStorage.getItem("baudloom.profiles.v1"));
  } catch (e) {
    failure(e);
  }
  function read(): SerialSettings {
    return serialSettings({
      dataBits: Number(el<HTMLSelectElement>("serial-dataBits").value),
      stopBits: Number(el<HTMLSelectElement>("serial-stopBits").value),
      parity: el<HTMLSelectElement>("serial-parity").value,
      flow: el<HTMLSelectElement>("serial-flow").value,
      dtr: el<HTMLInputElement>("serial-dtr").checked,
      rts: el<HTMLInputElement>("serial-rts").checked,
    });
  }
  function fill(s: SerialSettings) {
    for (const key of fields) {
      const field = el<HTMLInputElement>(`serial-${key}`);
      if (key === "dtr" || key === "rts") field.checked = s[key];
      else field.value = String(s[key]);
    }
    update();
  }
  const active = () =>
    ["connecting", "connected", "stopping"].includes(context()?.state ?? "");
  function update() {
    const live = active();
    const values = live ? (context()?.serial ?? saved) : read();
    el("serial-summary").textContent =
      `${baud.value} · ${serialSummary(values)}`;
    for (const key of fields)
      el<HTMLInputElement>(`serial-${key}`).disabled =
        live || ((key === "dtr" || key === "rts") && values.flow === "rtscts");
    el<HTMLButtonElement>("profile-apply").disabled = live || !profiles.length;
    el("serial-note").textContent = live
      ? "已连接；断开后可修改参数。"
      : values.flow === "rtscts"
        ? "RTS/CTS 由驱动控制，不手动设置握手线。"
        : "DTR/RTS 在打开串口后设置；打开时的瞬间电平由驱动决定。";
  }
  function list(selected = "") {
    el<HTMLSelectElement>("profile-list").replaceChildren(
      new Option("选择已保存的配置", ""),
      ...profiles.map((p) => new Option(p.name, p.name)),
    );
    el<HTMLSelectElement>("profile-list").value = selected;
  }
  function store(next: typeof profiles) {
    localStorage.setItem(
      "baudloom.profiles.v1",
      JSON.stringify({ version: 1, profiles: next }),
    );
    profiles = next;
  }
  el("connection-options").onclick = () => {
    if (active() && context()?.serial) fill(context()!.serial!);
    update();
    dialog.showModal();
  };
  el("connection-close").onclick = () => dialog.close();
  for (const key of fields)
    el(`serial-${key}`).onchange = () => {
      saved = read();
      update();
    };
  el("profile-save").onclick = () => {
    try {
      const profile = validateProfile({
        name: el<HTMLInputElement>("profile-name").value,
        baudRate: Number(baud.value),
        serial: read(),
        ...send.profileValues(),
      });
      const index = profiles.findIndex((p) => p.name === profile.name);
      if (index < 0 && profiles.length >= 20)
        throw Error("最多保存 20 组配置，请先删除不用的配置");
      const next = profiles.slice();
      if (index < 0) next.push(profile);
      else next[index] = profile;
      store(next);
      list(profile.name);
      update();
      el("profile-status").textContent =
        `已保存「${profile.name}」，包含当前发送内容与命令组。`;
    } catch (e) {
      el("profile-status").textContent = String(e);
    }
  };
  el("profile-apply").onclick = () => {
    try {
      if (active()) throw Error("请先断开连接再应用配置");
      const p = profiles.find(
        (p) => p.name === el<HTMLSelectElement>("profile-list").value,
      );
      if (!p) throw Error("请先选择配置");
      send.applyProfile(p);
      baud.value = String(p.baudRate);
      baud.dispatchEvent(new Event("input"));
      saved = { ...p.serial };
      fill(saved);
      el("profile-status").textContent =
        `已应用「${p.name}」，未连接设备或发送命令。`;
    } catch (e) {
      el("profile-status").textContent = String(e);
    }
  };
  el("profile-delete").onclick = () => {
    try {
      const name = el<HTMLSelectElement>("profile-list").value;
      if (!name) return;
      store(profiles.filter((p) => p.name !== name));
      list();
      update();
      el("profile-status").textContent = `已删除「${name}」`;
    } catch (e) {
      el("profile-status").textContent = String(e);
    }
  };
  el("profile-list").onchange = () => {
    el<HTMLInputElement>("profile-name").value =
      el<HTMLSelectElement>("profile-list").value;
  };
  fill(saved);
  list();
  return {
    read,
    update,
    remember: () => {
      try {
        localStorage.setItem("baudloom.serial.v1", JSON.stringify(read()));
      } catch (e) {
        failure(e);
      }
    },
  };
}
