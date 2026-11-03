import type { DeviceProfile } from "../profiles";
import type { Api, Port, SendRequest, Snapshot } from "../shared";
import {
  blankCommand,
  encodeSend,
  checksumOptions,
  checksumSettings,
  checksumBytes,
  payload,
  convertFormat,
  rememberSend,
  restoreSendTools,
  type CommandDraft,
  type SendTools,
} from "../send-tools";

const get = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const storageKey = "baudloom.send-tools.v1";
export class SendPanel {
  private input = get<HTMLTextAreaElement>("command");
  private format = get<HTMLSelectElement>("tx-format");
  private ending = get<HTMLSelectElement>("ending");
  private checksum = get<HTMLSelectElement>("checksum");
  private checksumStart = get<HTMLInputElement>("checksum-start");
  private checksumEnd = get<HTMLInputElement>("checksum-end");
  private checksumOrder = get<HTMLSelectElement>("checksum-order");
  private previousFormat: CommandDraft["format"] = "text";
  private schedulePending = false;
  private history = get<HTMLSelectElement>("send-history");
  private clearAfter = get<HTMLInputElement>("clear-after-send");
  private state: SendTools;
  private target = "demo";
  private snapshot: Snapshot | null = null;
  private busy = false;
  private sending = false;
  private drafts = new Map<string, CommandDraft>();
  constructor(
    private send: (request: SendRequest) => Promise<void>,
    private failure: (error: unknown) => void,
    private api: Pick<Api, "startSchedule" | "stopSchedule" | "snapshot">,
  ) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {}
    this.state = restoreSendTools(raw);
    this.clearAfter.checked = this.state.clearAfterSend;
    this.input.oninput = () => this.update();
    this.format.onchange = () => {
      try {
        this.input.value = convertFormat(
          this.input.value,
          this.previousFormat,
          this.format.value,
        );
        this.previousFormat = this.format.value as CommandDraft["format"];
      } catch (error) {
        this.format.value = this.previousFormat;
        this.failure(error);
      }
      this.update();
    };
    for (const [value, label] of checksumOptions)
      this.checksum.add(new Option(label, value));
    for (const control of [
      this.checksum,
      this.checksumStart,
      this.checksumEnd,
      this.checksumOrder,
    ])
      control.oninput = () => this.update();
    get("stop-sending").onclick = () => {
      if (this.snapshot?.schedule.active)
        void this.schedule(
          this.snapshot.schedule.kind === "multi" ? "multi" : "single",
        );
    };
    get("single-timer").onclick = () => void this.schedule("single");
    get("multi-timer").onclick = () => void this.schedule("multi");
    this.ending.onchange = () => this.update();
    this.clearAfter.onchange = () => {
      this.state.clearAfterSend = this.clearAfter.checked;
      this.persist();
    };
    get("clear-command").onclick = () => {
      this.input.value = "";
      this.update();
      this.input.focus();
    };
    this.history.onchange = () => {
      if (!this.history.value) return;
      const entry = this.state.history[Number(this.history.value)];
      if (entry && entry.target === this.target) this.fill(entry);
      this.history.value = "";
      this.input.focus();
    };
    get("toggle-multi").onclick = () => this.toggle();
    get("multi-dialog").addEventListener("close", () =>
      get("toggle-multi").setAttribute("aria-expanded", "false"),
    );
    get("collapse-multi").onclick = () => {
      this.toggle(false);
      get("toggle-multi").focus();
    };
    get("add-command").onclick = () => {
      if (this.state.commands.length >= 12) return;
      this.state.commands.push(blankCommand());
      this.renderSlots();
      this.persist();
      get("command-list")
        .lastElementChild?.querySelector<HTMLTextAreaElement>(".slot-text")
        ?.focus();
    };
    get("save-command").onclick = () => {
      const command = this.current();
      if (!command.text) return;
      if (command.text.length > 8192) {
        this.failure(Error("多条发送每条最多保存 8192 个字符"));
        return;
      }
      const empty = this.state.commands.find((c) => !c.text && !c.name);
      if (empty) Object.assign(empty, command);
      else if (this.state.commands.length < 12)
        this.state.commands.push({ ...command, name: "" });
      else {
        this.failure(Error("多条发送最多 12 条，请先删除不用的条目"));
        return;
      }
      this.renderSlots();
      this.persist();
      this.toggle(true);
    };
    get("send-form").onsubmit = (e) => {
      e.preventDefault();
      void this.transmit(this.current(), true);
    };
    this.renderSlots();
    this.renderHistory();
    this.update();
  }
  profileValues() {
    return {
      draft: this.current(),
      commands: this.state.commands.map((c) => ({ ...c })),
      clearAfterSend: this.clearAfter.checked,
      singleInterval: Number(get<HTMLInputElement>("single-interval").value),
      multiInterval: Number(get<HTMLInputElement>("multi-interval").value),
    };
  }
  applyProfile(profile: DeviceProfile) {
    if (
      this.sending ||
      this.busy ||
      this.schedulePending ||
      this.snapshot?.schedule.active
    )
      throw Error("请先停止发送，再应用配置");
    this.state.commands = profile.commands.map((c) => ({ ...c }));
    this.state.clearAfterSend = this.clearAfter.checked =
      profile.clearAfterSend;
    this.fill({ ...profile.draft });
    get<HTMLInputElement>("single-interval").value = String(
      profile.singleInterval,
    );
    get<HTMLInputElement>("multi-interval").value = String(
      profile.multiInterval,
    );
    this.renderSlots();
    this.persist();
  }
  private persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(this.state));
    } catch {
      this.failure(Error("发送工具设置未能保存，请检查本地存储空间"));
    }
  }
  private current(): CommandDraft {
    return {
      text: this.input.value,
      format: this.format.value as CommandDraft["format"],
      ending: this.ending.value as CommandDraft["ending"],
      checksum: this.checksum.value as CommandDraft["checksum"],
      checksumStart: Number(this.checksumStart.value),
      checksumEnd:
        this.checksumEnd.value === "" ? 0 : Number(this.checksumEnd.value),
      checksumOrder: this.checksumOrder.value as CommandDraft["checksumOrder"],
    };
  }
  private fill(command: CommandDraft) {
    this.input.value = command.text;
    this.format.value = command.format;
    this.ending.value = command.ending;
    this.checksum.value = command.checksum ?? "none";
    this.checksumStart.value = String(command.checksumStart ?? 1);
    this.checksumEnd.value = command.checksumEnd
      ? String(command.checksumEnd)
      : "";
    this.checksumOrder.value = command.checksumOrder ?? "little";
    this.previousFormat = command.format;
    this.update();
  }
  private valid(command: CommandDraft) {
    try {
      encodeSend(command);
      return true;
    } catch {
      return false;
    }
  }
  private toggle(open = !get<HTMLDialogElement>("multi-dialog").open) {
    const dialog = get<HTMLDialogElement>("multi-dialog");
    if (open) {
      get<HTMLDialogElement>("send-options-dialog").close();
      dialog.showModal();
    } else dialog.close();
    get("toggle-multi").setAttribute("aria-expanded", String(open));
  }
  private contextKey = "";
  setContext(snapshot: Snapshot | null, port: Port | undefined, busy: boolean) {
    this.snapshot = snapshot;
    this.busy = busy;
    const key = JSON.stringify([
      port?.path,
      port?.label,
      busy,
      snapshot?.state,
      snapshot?.target,
      snapshot?.sessionId,
      snapshot?.schedule,
    ]);
    if (key === this.contextKey) return;
    this.contextKey = key;
    if (port && this.target !== port.path) {
      this.drafts.set(this.target, this.current());
      this.target = port.path;
      this.fill(this.drafts.get(this.target) ?? blankCommand());
      this.renderHistory();
      get("send-result").textContent = "";
    }
    get("send-target").textContent = port?.label ?? "未选择设备";
    get("send-connection").textContent =
      snapshot?.state === "connected" ? "已连接" : "未连接，可先编辑";
    this.update();
  }
  private update() {
    const command = this.current();
    let bytes = 0;
    let invalid = "";
    if (command.text) {
      try {
        bytes = encodeSend(command).length;
      } catch (e) {
        invalid = (e as Error).message;
      }
    }
    this.input.setAttribute("aria-invalid", String(Boolean(invalid)));
    const preview = get("send-bytes");
    preview.textContent =
      invalid ||
      `待发 ${bytes} B${bytes && command.format === "text" && command.ending !== "none" ? " · 含 " + command.ending.toUpperCase() : ""}`;
    preview.classList.toggle("invalid", Boolean(invalid));
    this.ending.disabled = command.format === "hex";
    const running = this.snapshot?.schedule.active === true;
    const locked = running || this.schedulePending;
    const ready =
      this.snapshot?.state === "connected" &&
      this.snapshot.target === this.target &&
      !this.busy &&
      !this.sending &&
      !locked;
    get<HTMLButtonElement>("send").disabled =
      !ready || !command.text || Boolean(invalid);
    const reason = invalid
      ? "请修正发送内容"
      : this.snapshot?.state !== "connected"
        ? "请先连接"
        : locked
          ? "请先停止定时发送"
          : this.sending
            ? "正在发送…"
            : this.busy
              ? "正在处理操作…"
              : this.snapshot.target !== this.target
                ? "设备已变化，请重新选择"
                : !command.text
                  ? "请输入发送内容"
                  : "";
    get("send-availability").textContent = reason;
    get("send").title = invalid || reason || "发送 · Ctrl+Enter";

    get<HTMLButtonElement>("clear-command").disabled = !command.text || locked;
    get<HTMLButtonElement>("save-command").disabled = !command.text || locked;
    get<HTMLButtonElement>("add-command").disabled =
      this.state.commands.length >= 12 || locked;
    for (const control of [
      this.input,
      this.format,
      this.checksum,
      this.history,
      this.clearAfter,
    ])
      control.disabled = locked;
    this.ending.disabled ||= locked;
    for (const control of [
      this.checksumStart,
      this.checksumEnd,
      this.checksumOrder,
    ])
      control.disabled = locked || command.checksum === "none";
    document
      .querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >(
        "#command-list input, #command-list textarea, #command-list select, .timing-toolbar input, .bank-timing input",
      )
      .forEach((control) => {
        control.disabled =
          locked ||
          (control.classList.contains("slot-ending") &&
            this.state.commands[Number(control.dataset.index)]?.format ===
              "hex");
      });
    document
      .querySelectorAll<HTMLButtonElement>(".slot-remove")
      .forEach((button) => {
        button.disabled = locked;
      });
    for (const kind of ["single", "multi"] as const) {
      const button = get<HTMLButtonElement>(`${kind}-timer`);
      const own = running && this.snapshot?.schedule.kind === kind;
      button.textContent = own
        ? "停止定时发送"
        : kind === "single"
          ? "定时发送"
          : "循环发送勾选项";
      button.disabled =
        this.schedulePending ||
        (!own &&
          (!ready ||
            (kind === "single"
              ? !command.text || Boolean(invalid)
              : !this.state.commands.some((c) => c.selected))));
    }
    const status = this.snapshot?.schedule;
    get("schedule-state").textContent = running
      ? `${status?.kind === "multi" ? "多条循环" : "单条定时"} · ${status?.intervalMs} ms · 已发送 ${status?.completed} 条`
      : status?.error
        ? `定时已停止：${status.error}`
        : "定时发送未启动";
    get("stop-sending").hidden = !running;
    get("send-options").title =
      `发送选项${command.checksum !== "none" ? " · 校验" : ""}${running ? " · 定时中" : ""}`;
    let wire = "";
    get("checksum-value").textContent = "";
    if (command.text && !invalid) {
      const data = encodeSend(command);
      if (command.checksum !== "none")
        get("checksum-value").textContent =
          "校验值 " +
          Array.from(
            checksumBytes(payload(command.text, command.format), command),
            (b) => b.toString(16).padStart(2, "0").toUpperCase(),
          ).join(" ");
      wire =
        "待发字节 " +
        Array.from(data.slice(0, 32), (b) =>
          b.toString(16).padStart(2, "0").toUpperCase(),
        ).join(" ") +
        (data.length > 32 ? " …" : "");
    }
    get("wire-preview").textContent = wire;
    document
      .querySelectorAll<HTMLButtonElement>(".slot-send")
      .forEach((button, i) => {
        button.disabled = !ready || !this.valid(this.state.commands[i]);
      });
  }
  private renderHistory() {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    const entries = this.state.history
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.target === this.target);
    placeholder.textContent = entries.length
      ? `发送历史（${entries.length}）`
      : "发送历史（空）";
    this.history.replaceChildren(
      placeholder,
      ...entries.map(({ item, index }) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `${item.format.toUpperCase()} · ${item.text.replace(/[\r\n]/g, " ").slice(0, 70)}`;
        return option;
      }),
    );
  }
  private renderSlots() {
    get("command-list").replaceChildren(
      ...this.state.commands.map((slot, index) => {
        const row = document.createElement("div");
        row.className = "command-row";
        const selected = document.createElement("input");
        selected.type = "checkbox";
        selected.className = "slot-selected";
        selected.checked = slot.selected === true;
        selected.setAttribute("aria-label", `选择第 ${index + 1} 条循环发送`);
        selected.onchange = () => {
          slot.selected = selected.checked;
          this.persist();
          this.update();
        };
        const name = document.createElement("input");
        name.className = "slot-name";
        name.value = slot.name;
        name.placeholder = "备注（可选）";
        name.maxLength = 60;
        name.setAttribute("aria-label", `第 ${index + 1} 条备注`);
        const text = document.createElement("textarea");
        text.className = "slot-text";
        text.rows = 1;
        text.wrap = "off";
        text.value = slot.text;
        text.placeholder = "输入要发送的内容";
        text.maxLength = 8192;
        text.spellcheck = false;
        text.setAttribute("aria-label", `第 ${index + 1} 条内容`);
        const format = document.createElement("select");
        format.className = "slot-format";
        format.setAttribute("aria-label", `第 ${index + 1} 条格式`);
        for (const [value, label] of [
          ["text", "文本"],
          ["hex", "HEX"],
        ])
          format.add(new Option(label, value));
        format.value = slot.format;
        const ending = document.createElement("select");
        ending.className = "slot-ending";
        ending.dataset.index = String(index);
        ending.setAttribute("aria-label", `第 ${index + 1} 条换行`);
        for (const value of ["crlf", "cr", "lf", "none"])
          ending.add(
            new Option(
              value === "none" ? "无换行" : value.toUpperCase(),
              value,
            ),
          );
        ending.value = slot.ending;
        ending.disabled = slot.format === "hex";
        const checksum = document.createElement("select");
        checksum.className = "slot-checksum";
        checksum.setAttribute("aria-label", `第 ${index + 1} 条校验`);
        for (const [value, label] of checksumOptions)
          checksum.add(new Option(label, value));
        checksum.value = slot.checksum ?? "none";
        const start = document.createElement("input");
        start.type = "number";
        start.min = "1";
        start.max = "65536";
        start.className = "slot-start";
        start.value = String(slot.checksumStart ?? 1);
        start.setAttribute("aria-label", `第 ${index + 1} 条校验起始字节`);
        const end = document.createElement("input");
        end.type = "number";
        end.min = "1";
        end.max = "65536";
        end.className = "slot-end";
        end.placeholder = "末尾";
        end.value = slot.checksumEnd ? String(slot.checksumEnd) : "";
        end.setAttribute("aria-label", `第 ${index + 1} 条校验结束字节`);
        const order = document.createElement("select");
        order.className = "slot-order";
        order.add(new Option("低位在前", "little"));
        order.add(new Option("高位在前", "big"));
        order.value = slot.checksumOrder ?? "little";
        order.setAttribute("aria-label", `第 ${index + 1} 条校验字节顺序`);
        const preview = document.createElement("output");
        preview.className = "slot-preview";
        const refreshPreview = () => {
          text.title = slot.name ? `${slot.name}：${slot.text}` : slot.text;
          try {
            preview.textContent = slot.text
              ? "待发 " +
                Array.from(encodeSend(slot).slice(0, 32), (b) =>
                  b.toString(16).padStart(2, "0").toUpperCase(),
                ).join(" ")
              : "请输入内容";
            text.setAttribute("aria-invalid", "false");
          } catch (error) {
            preview.textContent = (error as Error).message;
            text.setAttribute("aria-invalid", "true");
          }
        };
        const save = () => {
          slot.name = name.value;
          slot.text = text.value;
          slot.format = format.value as CommandDraft["format"];
          slot.ending = ending.value as CommandDraft["ending"];
          slot.checksum = checksum.value as CommandDraft["checksum"];
          slot.checksumStart = Number(start.value);
          slot.checksumEnd = end.value === "" ? 0 : Number(end.value);
          slot.checksumOrder = order.value as CommandDraft["checksumOrder"];
          refreshPreview();
          ending.disabled = slot.format === "hex";
          this.persist();
          this.update();
        };
        name.oninput = save;
        text.oninput = save;
        format.onchange = () => {
          try {
            const converted = convertFormat(
              text.value,
              slot.format,
              format.value,
            );
            if (converted.length > 8192)
              throw Error("转换后超过多条发送的 8192 字符限制，已保留原内容");
            text.value = converted;
          } catch (error) {
            format.value = slot.format;
            this.failure(error);
          }
          save();
        };
        checksum.onchange = save;
        start.oninput = save;
        end.oninput = save;
        order.onchange = save;
        ending.onchange = save;
        const send = document.createElement("button");
        send.className = "slot-send";
        send.textContent = "发送";
        send.setAttribute("aria-label", `发送第 ${index + 1} 条`);
        send.onclick = () => void this.transmit({ ...slot }, false);
        const remove = document.createElement("button");
        remove.className = "slot-remove";
        remove.textContent = "删除";
        remove.setAttribute("aria-label", `删除第 ${index + 1} 条`);
        remove.onclick = () => {
          this.state.commands.splice(index, 1);
          if (!this.state.commands.length)
            this.state.commands.push(blankCommand());
          this.renderSlots();
          this.persist();
        };
        const options = document.createElement("div");
        options.className = "slot-options";
        options.hidden = true;
        const field = (label: string, control: HTMLElement) => {
          const node = document.createElement("label");
          node.append(document.createTextNode(label), control);
          return node;
        };
        options.append(
          field("备注", name),
          field("末尾", ending),
          field("校验", checksum),
          field("第几字节", start),
          field("至", end),
          order,
          preview,
        );
        const settings = document.createElement("button");
        settings.className = "slot-settings";
        settings.textContent = "设置";
        settings.setAttribute("aria-expanded", "false");
        settings.setAttribute("aria-label", `第 ${index + 1} 条设置`);
        settings.onclick = () => {
          options.hidden = !options.hidden;
          settings.setAttribute("aria-expanded", String(!options.hidden));
          refreshPreview();
        };
        const line = document.createElement("div");
        line.className = "slot-line";
        line.append(selected, text, format, send, settings, remove);
        row.append(line, options);
        refreshPreview();
        return row;
      }),
    );
    this.update();
  }
  private async schedule(kind: "single" | "multi") {
    if (this.schedulePending) return;
    this.schedulePending = true;
    this.update();
    try {
      if (this.snapshot?.schedule.active) {
        await this.api.stopSchedule();
      } else {
        const context = this.snapshot;
        if (
          context?.state !== "connected" ||
          context.target !== this.target ||
          this.sending ||
          this.busy
        )
          return;
        const commands =
          kind === "single"
            ? [this.current()]
            : this.state.commands.filter((c) => c.selected);
        if (!commands.length) throw Error("请先勾选要循环发送的条目");
        commands.forEach((c) => encodeSend(c));
        await this.api.startSchedule({
          kind,
          intervalMs: Number(get<HTMLInputElement>(`${kind}-interval`).value),
          commands: commands.map((c) => ({
            text: c.text,
            format: c.format,
            ending: c.ending,
            ...checksumSettings(c),
            target: context.target,
            sessionId: context.sessionId,
          })),
        });
      }
      this.snapshot = await this.api.snapshot();
    } catch (error) {
      this.failure(error);
    } finally {
      this.schedulePending = false;
      this.update();
    }
  }
  private async transmit(command: CommandDraft, single: boolean) {
    const context = this.snapshot;
    if (
      this.snapshot?.schedule.active ||
      this.schedulePending ||
      this.sending ||
      this.busy ||
      context?.state !== "connected" ||
      context.target !== this.target
    )
      return;
    const request: SendRequest = {
      text: command.text,
      format: command.format,
      ending: command.ending,
      ...checksumSettings(command),
      target: context.target,
      sessionId: context.sessionId,
    };
    this.sending = true;
    this.update();
    try {
      const count = encodeSend(command).length;
      await this.send(request);
      this.state.history = rememberSend(this.state.history, {
        text: command.text,
        format: command.format,
        ending: command.ending,
        ...checksumSettings(command),
        target: request.target,
      });
      this.persist();
      this.renderHistory();
      // A user may edit while the device write is pending; never erase that newer draft.
      if (
        single &&
        this.clearAfter.checked &&
        this.target === request.target &&
        JSON.stringify(this.current()) ===
          JSON.stringify({
            text: command.text,
            format: command.format,
            ending: command.ending,
            ...checksumSettings(command),
          })
      )
        this.input.value = "";
      get("send-result").textContent = `${count} B 已交给串口，设备响应见日志`;
    } catch (error) {
      this.failure(error);
    } finally {
      this.sending = false;
      this.update();
    }
  }
}
