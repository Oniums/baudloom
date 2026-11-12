const { controls } = require("./desktop-controls.cjs");
const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, mkdir, readdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
async function showBank(page, open) {
  if ((await page.locator("#command-bank").isVisible()) !== open)
    await controls(page).locator("#toggle-multi").click();
}
async function sendOption(page, fn) {
  await controls(page).locator("#send-options").click();
  try {
    await fn();
  } finally {
    if (await page.locator("#send-options-dialog").isVisible())
      await page.locator("#send-options-close").click();
  }
}
(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "baudloom-desktop-"));
  let app;
  try {
    app = await electron.launch({
      executablePath: process.env.BAUDLOOM_EXECUTABLE,
      args: [
        ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
        ...(process.env.BAUDLOOM_EXECUTABLE ? [] : ["."]),
      ],
      env: { ...process.env, BAUDLOOM_DATA_DIR: root, BAUDLOOM_TEST_MODE: "1" },
      timeout: 30000,
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("button", { name: "连接", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    assert.equal(await controls(page).locator("#send").isDisabled(), true);
    assert.equal(await controls(page).locator("#command").isEnabled(), true);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("ports");
      ipcMain.handle("ports", () => [
        { path: "demo", label: "测试端口（合成数据）", source: "synthetic" },
        ...["12", "5", "10", "4", "9", "11", "14", "8"].map(
          (number, index) => ({
            path: "COM" + number,
            label: `WCH USB-SERIAL Ch ${String.fromCharCode(65 + index)} (COM${number})`,
            source: "serial",
          }),
        ),
        {
          path: "COM99",
          label: "设备描述符名称完整显示测试 ".repeat(10) + "(COM99)",
          source: "serial",
        },
      ]);
    });
    await controls(page).locator("#refresh").click();
    await controls(page).locator("#target").selectOption("COM12");
    assert.equal(
      await controls(page).locator("#target option:checked").textContent(),
      "WCH USB-SERIAL Ch A (COM12)",
    );
    assert.equal(
      await controls(page).locator("#send-target").textContent(),
      "WCH USB-SERIAL Ch A (COM12)",
    );
    await controls(page).locator("#command").fill("COM12 draft");
    await controls(page).locator("#target").selectOption("COM5");
    assert.equal(await controls(page).locator("#command").inputValue(), "");
    await controls(page).locator("#target").selectOption("COM12");
    assert.equal(
      await controls(page).locator("#command").inputValue(),
      "COM12 draft",
    );
    await mkdir(".local/screenshots", { recursive: true });
    await page.screenshot({
      path: ".local/screenshots/desktop-device-name.png",
    });
    await controls(page).locator("#target").selectOption("COM99");
    assert.equal(
      await controls(page).locator("#target").getAttribute("title"),
      await controls(page).locator("#target option:checked").textContent(),
    );
    // The splitter's ResizeObserver clamps the saved width after native window resize.
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await controls(page).locator("#target").selectOption("demo");
    await controls(page).locator("#command").fill("123");
    await controls(page).locator("#tx-format").selectOption("hex");
    assert.equal(
      await controls(page).locator("#command").inputValue(),
      "31 32 33",
    );
    await controls(page).locator("#tx-format").selectOption("text");
    assert.equal(await controls(page).locator("#command").inputValue(), "123");
    assert.equal(await page.title(), "Baudloom");
    assert.ok(
      !(await controls(page).locator(".titlebar").textContent()).includes(
        "预览",
      ),
    );
    assert.equal(
      await controls(page).locator("#save-session").isChecked(),
      false,
    );
    assert.ok(
      (await controls(page).locator("#baud-presets option").count()) >= 30,
    );
    for (const value of ["", "1e6", "115200.5", "4000001"]) {
      await controls(page).locator("#baud").fill(value);
      await controls(page).locator("#connect").click();
      await expect(controls(page).locator("#error")).toContainText("波特率");
      assert.equal(
        (await page.evaluate(() => window.baudloom.snapshot())).state,
        "idle",
      );
    }
    await controls(page).locator("#baud-presets").selectOption("230400");
    await expect(controls(page).locator("#baud")).toHaveValue("230400");
    await controls(page).locator("#baud").fill("123456");
    await controls(page).locator("#connect").click();
    await page.getByRole("button", { name: "断开", exact: true }).waitFor();
    assert.equal(await controls(page).locator("#baud").isDisabled(), true);
    await expect(controls(page).locator("#log")).toContainText("123456");
    await controls(page).locator("#command").fill("unsaved-data");
    await controls(page).locator("#send").click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).txBytes,
      )
      .toBeGreaterThan(0);
    assert.equal(
      (await page.evaluate(() => window.baudloom.snapshot())).sessionFile,
      "",
    );
    assert.ok(
      (await controls(page).locator("#record-state").textContent()).includes(
        "未保存",
      ),
    );
    assert.equal(
      await controls(page).locator("#save-session").isEnabled(),
      true,
    );
    assert.ok(!(await readdir(root)).includes("sessions"));
    const liveId = (await page.evaluate(() => window.baudloom.snapshot()))
      .sessionId;
    await controls(page).locator("#save-session").check();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot()))
            .backfilledEvents,
      )
      .toBeGreaterThan(0);
    await expect(controls(page).locator("#record-state")).toContainText(
      "已补写",
    );
    const savedLive = await page.evaluate(() => window.baudloom.snapshot());
    assert.equal(savedLive.sessionId, liveId);
    assert.equal(savedLive.state, "connected");
    const backfilled = (await readFile(savedLive.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      backfilled.some(
        (r) =>
          r.event.kind === "tx-request" &&
          Buffer.from(r.event.data, "base64")
            .toString()
            .startsWith("unsaved-data"),
      ),
    );
    const exported = path.join(root, "live-export.txt");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, exported);
    await controls(page).locator("#export-log").click();
    await controls(page).locator("#export-scope").selectOption("session");
    await controls(page).locator("#export-time").uncheck();
    await controls(page).locator("#export-direction").uncheck();
    await controls(page).locator("#export-confirm").click();
    await expect(controls(page).locator("#export-status")).toContainText(
      "已导出",
    );
    assert.ok((await readFile(exported, "utf8")).includes("unsaved-data"));
    await expect(controls(page).locator("#export-status")).toContainText(
      "后续接收不包含",
    );
    await controls(page).locator("#export-close").click();
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true });
    });
    await controls(page).locator("#export-log").click();
    await controls(page).locator("#export-confirm").click();
    await expect(controls(page).locator("#export-status")).toContainText(
      "未导出文件",
    );
    await controls(page).locator("#export-close").click();
    await controls(page).locator("#view-options").click();
    await controls(page).locator("#show-time").uncheck();
    await controls(page).locator("#show-direction").uncheck();
    await expect(controls(page).locator(".log-row .time").first()).toBeHidden();
    await expect(
      controls(page).locator(".log-row .direction").first(),
    ).toBeHidden();
    await controls(page).locator("#log-font-size").fill("18");
    await controls(page).locator("#log-font-size").press("Tab");
    assert.equal(
      await controls(page)
        .locator("#log")
        .evaluate((n) => getComputedStyle(n).fontSize),
      "18px",
    );
    await controls(page).locator("#view-max-rows").fill("20000");
    await controls(page).locator("#view-max-chars").selectOption("8");
    await controls(page).locator("#apply-view-limits").click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).viewLimits
            .maxRows,
      )
      .toBe(20000);
    await expect(controls(page).locator("#view-memory")).toContainText(
      "不是实测值",
    );
    await controls(page).locator("#show-time").check();
    await controls(page).locator("#show-direction").check();
    await controls(page).locator("#log-font-size").fill("14");
    await controls(page).locator("#log-font-size").press("Tab");
    await controls(page).locator("#view-options").click();
    await expect(page.locator("#log .time").first()).toHaveText(
      /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]$/,
    );
    await controls(page).locator("#connect").click();
    await page.getByRole("button", { name: "连接", exact: true }).waitFor();
    await controls(page).locator("#save-session").check();
    await controls(page).locator("#command").fill("draft before connecting");
    const beforeShortcut = (
      await page.evaluate(() => window.baudloom.snapshot())
    ).txBytes;
    await controls(page).locator("#command").press("Control+Enter");
    assert.equal(
      (await page.evaluate(() => window.baudloom.snapshot())).txBytes,
      beforeShortcut,
    );
    await controls(page).locator("#target").selectOption("demo");
    await controls(page).locator("#connect").click();
    await page.getByRole("button", { name: "断开", exact: true }).waitFor();
    assert.equal(
      await controls(page).locator("#command").inputValue(),
      "draft before connecting",
    );
    assert.equal(
      await page.getByRole("button", { name: "查询状态", exact: true }).count(),
      0,
    );
    await page.waitForFunction(() =>
      document.querySelector("#log").textContent.includes("[demo] sample="),
    );
    await controls(page).locator("#command").fill("status");
    await controls(page).locator("#send").click();
    await page.waitForFunction(() =>
      document.querySelector("#log").textContent.includes("主机写入完成"),
    );
    const file = (await page.evaluate(() => window.baudloom.snapshot()))
      .sessionFile;
    assert.ok((await readFile(file, "utf8")).includes("tx-request"));
    assert.equal(
      await controls(page).locator("#command").inputValue(),
      "status",
    );
    await sendOption(page, () =>
      controls(page).locator("#clear-command").click(),
    );
    assert.equal(await controls(page).locator("#command").inputValue(), "");
    const txBeforeHistory = (
      await page.evaluate(() => window.baudloom.snapshot())
    ).txBytes;
    await controls(page).locator("#send-history").selectOption("0");
    assert.equal(
      await controls(page).locator("#command").inputValue(),
      "status",
    );
    assert.equal(
      (await page.evaluate(() => window.baudloom.snapshot())).txBytes,
      txBeforeHistory,
    );
    await sendOption(page, () =>
      controls(page).locator("#clear-after-send").check(),
    );
    await controls(page).locator("#command").fill("中");
    await controls(page).locator("#ending").selectOption("cr");
    await page.waitForFunction(() =>
      document.querySelector("#send-bytes").textContent.includes("4 B"),
    );
    await controls(page).locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector("#command").value === "",
    );
    await showBank(page, true);
    const row = controls(page).locator(".command-row").first();
    await row.locator(".slot-settings").click();
    await row.locator(".slot-name").fill("测试帧");
    await row.locator(".slot-format").selectOption("hex");
    await row.locator(".slot-text").fill("00 FF");
    await row.locator(".slot-send").click();
    await page.waitForFunction(() =>
      document.querySelector("#send-result").textContent.includes("2 B"),
    );
    const sent = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((r) => r.event.kind === "tx-request");
    assert.ok(
      sent.some(
        (r) =>
          Buffer.from(r.event.data, "base64").toString("hex") === "e4b8ad0d",
      ),
    );
    assert.ok(
      sent.some(
        (r) => Buffer.from(r.event.data, "base64").toString("hex") === "00ff",
      ),
    );
    await expect(page.locator("#command-bank")).toBeVisible();
    await page.locator("#collapse-multi").click();
    const originalBottom = await controls(page)
      .locator(".composer")
      .boundingBox();
    const splitter = page.locator("#bottom-splitter");
    await splitter.hover({ position: { x: 50, y: 2 } });
    const bottomHandle = await splitter.boundingBox();
    await page.mouse.down();
    await page.mouse.move(bottomHandle.x + 50, bottomHandle.y - 35, {
      steps: 5,
    });
    await page.mouse.up();
    await expect
      .poll(
        async () =>
          (await controls(page).locator(".composer").boundingBox()).height,
      )
      .toBeGreaterThan(originalBottom.height + 25);
    const savedLayout = await page.evaluate(() =>
      localStorage.getItem("baudloom.layout.v1"),
    );
    await showBank(page, true);
    await row.locator(".slot-selected").check();
    await row.locator(".slot-checksum").selectOption("xor8");
    const second = controls(page).locator(".command-row").nth(1);
    await second.locator(".slot-text").fill("B");
    await second.locator(".slot-format").selectOption("hex");
    assert.equal(await second.locator(".slot-text").inputValue(), "42");
    await second.locator(".slot-selected").check();
    const third = controls(page).locator(".command-row").nth(2);
    await third.locator(".slot-text").fill("NOT SELECTED");
    await controls(page).locator("#multi-interval").fill("100");
    const beforeBatch = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((r) => r.event.kind === "tx-request").length;
    await controls(page).locator("#multi-timer").click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).schedule
            .completed,
      )
      .toBeGreaterThanOrEqual(3);
    assert.equal(await controls(page).locator("#command").isDisabled(), true);
    await controls(page).locator("#multi-timer").click();
    await page.waitForFunction(
      () => !document.querySelector("#command").disabled,
    );
    await expect
      .poll(
        async () =>
          (await readFile(file, "utf8"))
            .trim()
            .split("\n")
            .map(JSON.parse)
            .filter((r) => r.event.kind === "tx-request").length,
      )
      .toBeGreaterThanOrEqual(beforeBatch + 3);
    const batch = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((r) => r.event.kind === "tx-request")
      .slice(beforeBatch)
      .map((r) => Buffer.from(r.event.data, "base64").toString("hex"));
    assert.deepEqual(batch.slice(0, 3), ["00ffff", "42", "00ffff"]);
    assert.ok(batch.every((v, i) => v === (i % 2 ? "42" : "00ffff")));
    await row.locator(".slot-checksum").selectOption("none");
    await row.locator(".slot-settings").click();
    assert.ok((await row.boundingBox()).height < 50);
    await controls(page).locator("#tx-format").selectOption("hex");
    await controls(page).locator("#command").fill("AA 01 03 00 00 00 0A BB");
    await sendOption(page, () =>
      controls(page).locator("#checksum").selectOption("modbus"),
    );
    await sendOption(page, () =>
      controls(page).locator("#checksum-start").fill("2"),
    );
    await sendOption(page, () =>
      controls(page).locator("#checksum-end").fill("7"),
    );
    await sendOption(page, () =>
      controls(page).locator("#checksum-order").selectOption("big"),
    );
    assert.equal(
      await controls(page).locator("#checksum-value").textContent(),
      "校验值 CD C5",
    );
    await controls(page).locator("#send").click();
    await expect
      .poll(async () =>
        (await readFile(file, "utf8")).includes(
          Buffer.from("aa01030000000abbcdc5", "hex").toString("base64"),
        ),
      )
      .toBe(true);
    await sendOption(page, () =>
      controls(page).locator("#checksum-start").fill("1"),
    );
    await sendOption(page, () =>
      controls(page).locator("#checksum-end").fill(""),
    );
    await sendOption(page, () =>
      controls(page).locator("#checksum-order").selectOption("little"),
    );
    await controls(page).locator("#tx-format").selectOption("text");
    await controls(page).locator("#command").fill("123456789");
    await controls(page).locator("#ending").selectOption("none");
    await sendOption(page, () =>
      controls(page).locator("#checksum").selectOption("modbus"),
    );
    await sendOption(page, () =>
      controls(page).locator("#single-interval").fill("250"),
    );
    await sendOption(page, () =>
      controls(page).locator("#single-timer").click(),
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).schedule
            .completed,
      )
      .toBeGreaterThanOrEqual(2);
    await sendOption(page, () =>
      controls(page).locator("#single-timer").click(),
    );
    await page.waitForFunction(
      () => !document.querySelector("#command").disabled,
    );
    assert.equal(
      await controls(page).locator("#command").inputValue(),
      "123456789",
    );
    await expect
      .poll(async () =>
        (await readFile(file, "utf8")).includes(
          Buffer.from("313233343536373839374b", "hex").toString("base64"),
        ),
      )
      .toBe(true);
    await sendOption(page, () =>
      controls(page).locator("#checksum").selectOption("none"),
    );
    await controls(page).locator("#ending").selectOption("crlf");
    await showBank(page, false);
    await controls(page).locator("#pause").click();
    const visible = await controls(page).locator("#log").textContent();
    const count = await page.evaluate(() =>
      window.baudloom.snapshot().then((x) => x.eventCount),
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).eventCount,
      )
      .toBeGreaterThan(count + 3);
    assert.equal(await controls(page).locator("#log").textContent(), visible);
    await controls(page).locator("#clear").click();
    await expect(page.locator("#pause")).toHaveText("暂停滚动");
    await page.waitForFunction(
      () => document.querySelectorAll(".log-row").length > 0,
    );
    assert.ok(
      (await page.evaluate(() => window.baudloom.snapshot())).eventCount >
        count,
    );
    await controls(page).locator("#search").fill("<script>");
    assert.equal(await controls(page).locator(".log-row").count(), 0);
    await controls(page).locator("#search").fill("");
    await controls(page)
      .locator("#command")
      .fill("<img src=x onerror=alert(1)>");
    await controls(page).locator("#send").click();
    await page.waitForFunction(() =>
      document.querySelector("#log").textContent.includes("<img"),
    );
    assert.equal(await controls(page).locator("#log img").count(), 0);
    const beforeReload = (await page.evaluate(() => window.baudloom.snapshot()))
      .eventCount;
    await controls(page).locator("#command").fill("reload-stop");
    await sendOption(page, () =>
      controls(page).locator("#single-timer").click(),
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).schedule
            .active,
      )
      .toBe(true);
    await page.reload();
    await expect(controls(page).locator("#baud")).toHaveValue("123456");
    assert.equal(
      await page.evaluate(() => localStorage.getItem("baudloom.layout.v1")),
      savedLayout,
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).schedule
            .active,
      )
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).eventCount,
      )
      .toBeGreaterThan(beforeReload);
    await page.getByRole("button", { name: "断开", exact: true }).waitFor();
    await showBank(page, true);
    assert.equal(
      (await page.evaluate(() => window.baudloom.snapshot())).viewLimits
        .maxRows,
      20000,
    );
    await controls(page).locator("#bottom-splitter").press("Home");
    assert.equal(
      await controls(page).locator(".slot-text").first().inputValue(),
      "00 FF",
    );
    await showBank(page, false);
    await controls(page).locator("#connect").click();
    await page.getByRole("button", { name: "连接", exact: true }).waitFor();
    const text = await readFile(file, "utf8");
    const records = text.trim().split("\n").map(JSON.parse);
    assert.equal(records.at(-1).event.kind, "stop");
    assert.ok(records.some((r) => r.event.kind === "rx"));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, file);
    await controls(page).locator("#history").click();
    await page.waitForFunction(() =>
      document.querySelector("#connection-state").textContent.includes("离线"),
    );
    assert.ok(await controls(page).locator("#log").textContent());
    assert.equal(await controls(page).locator("#send").isDisabled(), true);
    assert.equal(await controls(page).locator("#command").isEnabled(), true);
    await mkdir(".local/screenshots", { recursive: true });
    await page.screenshot({ path: ".local/screenshots/desktop-offline.png" });
    await controls(page).locator("#target").selectOption("demo");
    await controls(page).locator("#connect").click();
    await page.getByRole("button", { name: "断开", exact: true }).waitFor();
    await page.waitForFunction(() =>
      document.querySelector("#log").textContent.includes("[demo] sample=18"),
    );
    await controls(page).locator("#command").fill("version");
    await controls(page).locator("#send").click();
    await page.waitForFunction(() =>
      document.querySelector("#log").textContent.includes("主机写入完成"),
    );
    await page.screenshot({ path: ".local/screenshots/desktop-connected.png" });
    await showBank(page, true);
    await page.screenshot({
      path: ".local/screenshots/desktop-multi-send.png",
    });
    await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0].setContentSize(760, 560),
    );
    await page.waitForFunction(() => innerWidth === 760);
    // The splitter's ResizeObserver clamps the saved width after native window resize.
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    assert.ok(
      (await controls(page)
        .locator("#log")
        .evaluate((e) => e.clientHeight)) > 50,
    );
    await page.screenshot({
      path: ".local/screenshots/desktop-small-send.png",
    });
    await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0].setContentSize(1280, 820),
    );
    await page.waitForFunction(() => innerWidth === 1280);
    await showBank(page, false);
    // The splitter's ResizeObserver clamps the saved width after native window resize.
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await controls(page).locator("#command").fill("exit-stop");
    await sendOption(page, () =>
      controls(page).locator("#single-timer").click(),
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).schedule
            .active,
      )
      .toBe(true);
    const closingFile = (await page.evaluate(() => window.baudloom.snapshot()))
      .sessionFile;
    const closed = app.waitForEvent("close");
    await app.evaluate(({ BaseWindow }) => {
      BaseWindow.getAllWindows()[0].close();
    });
    await expect(page.locator("#close-dialog")).toContainText("会话文件");
    await page.getByRole("button", { name: "断开并退出" }).click();
    await closed;
    app = undefined;
    const finalRecords = (await readFile(closingFile, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(finalRecords.at(-1).event.kind, "stop");
    assert.deepEqual(errors, []);
    app = await electron.launch({
      executablePath: process.env.BAUDLOOM_EXECUTABLE,
      args: [
        ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
        ...(process.env.BAUDLOOM_EXECUTABLE ? [] : ["."]),
      ],
      env: {
        ...process.env,
        BAUDLOOM_DATA_DIR: "",
        PORTABLE_EXECUTABLE_DIR: path.join(root, "launcher"),
        BAUDLOOM_TEST_MODE: "0",
      },
    });
    const production = await app.firstWindow();
    await controls(production).locator("#connect").waitFor();
    assert.equal(
      await controls(production).locator("#save-session").isChecked(),
      false,
    );
    const dataPath = await app.evaluate(({ app }) => app.getPath("userData"));
    assert.equal(
      dataPath,
      path.join(root, "launcher", "Baudloom-data", "profile"),
    );
    const ports = await production.evaluate(() => window.baudloom.ports());
    assert.ok(ports.every((p) => p.source === "serial"));
    // A blocked enumeration must not block the directory, initial view or editing.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("ports");
      ipcMain.handle(
        "ports",
        () =>
          new Promise((resolve) => {
            globalThis.releasePortEnumeration = () => resolve([]);
          }),
      );
    });
    await production.reload();
    await expect(controls(production).locator("#directory-path")).toContainText(
      "sessions",
    );
    await expect(controls(production).locator("#view-state")).toContainText(
      "0 行",
    );
    assert.equal(
      await controls(production).locator("#command").isEnabled(),
      true,
    );
    await app.evaluate(() => {
      globalThis.releasePortEnumeration();
      delete globalThis.releasePortEnumeration;
    });
    await expect(controls(production).locator("#target")).toHaveText(
      "未发现串口",
    );
    await controls(production).locator("#command").fill("123");
    await controls(production).locator("#tx-format").selectOption("hex");
    await sendOption(production, () =>
      controls(production).locator("#checksum").selectOption("sum8"),
    );
    await showBank(production, true);
    const productionRows = controls(production).locator(".command-row");
    for (let i = 0; i < 4; i++) {
      await productionRows.nth(i).locator(".slot-format").selectOption("hex");
      await productionRows
        .nth(i)
        .locator(".slot-text")
        .fill(
          [
            "01 03 00 00 00 0A",
            "01 06 00 01 00 01",
            "AA 55 01 00",
            "AA 55 02 00",
          ][i],
        );
    }
    assert.ok(
      !/演示|预览/.test(await controls(production).locator("body").innerText()),
    );
    await production.screenshot({
      path: ".local/screenshots/desktop-production.png",
    });
    await controls(production).locator("#view-options").click();
    await production.screenshot({
      path: ".local/screenshots/desktop-view-settings.png",
    });
    await controls(production).locator("#view-options").click();
    const base = await production.evaluate(() => window.baudloom.snapshot());
    await app.evaluate(({ ipcMain }, base) => {
      ipcMain.removeHandler("snapshot");
      const rows = Array.from({ length: 50000 }, (_, index) => ({
        id: index + 1,
        at: "2026-11-02T00:00:00.000Z",
        dir: "RX",
        text:
          `fixture line ${index} ` +
          (index % 50 === 0 ? "中文长行".repeat(150) : "serial data"),
      }));
      ipcMain.handle("snapshot", () => ({
        ...base,
        rows,
        totalRows: rows.length,
        sessionId: "large-view-fixture",
        viewUpdate: undefined,
        rxBytes: 5000000,
        viewLimits: { maxRows: 50000, maxChars: 16 * 1048576 },
      }));
    }, base);
    await expect(controls(production).locator("#log")).toContainText(
      "fixture line 49999",
    );
    assert.ok((await controls(production).locator(".log-row").count()) < 200);
    await controls(production).locator("#view-options").click();
    await controls(production).locator("#wrap-lines").uncheck();
    await controls(production).locator("#view-options").click();
    const horizontalExtent = await production
      .locator("#log")
      .evaluate((n) => n.scrollWidth);
    assert.ok(horizontalExtent > 3000);
    await controls(production)
      .locator("#log")
      .evaluate((n) => {
        n.scrollLeft = n.scrollWidth;
      });
    assert.ok(
      await production.locator("#log").evaluate((node) => node.scrollLeft > 0),
    );
    await controls(production).locator("#pause").click();
    await controls(production)
      .locator("#log")
      .evaluate((n) => {
        n.scrollTop = 0;
      });
    await expect(controls(production).locator("#log")).toContainText(
      "fixture line 0 ",
    );
    assert.ok((await controls(production).locator(".log-row").count()) < 200);
    assert.equal(
      await controls(production)
        .locator("#log")
        .evaluate((n) => n.scrollWidth),
      horizontalExtent,
    );
    await controls(production).locator("#view-options").click();
    await controls(production).locator("#wrap-lines").check();
    await controls(production).locator("#view-options").click();
    await expect
      .poll(() =>
        controls(production)
          .locator("#log")
          .evaluate((n) => n.scrollLeft),
      )
      .toBe(0);
    await controls(production).locator("#pause").click();
    // Exercise the copy handler with an isolated data transfer, leaving the OS clipboard alone.
    const allText = await production.evaluate(async () => {
      const { rows } = await window.baudloom.snapshot();
      const time = new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(rows[0].at));
      return rows.map((r) => "[" + time + ".000]收← " + r.text).join("\n");
    });
    await production.locator("#log").focus();
    await production.keyboard.press("Control+a");
    const copyText = () =>
      production.evaluate(() => {
        const data = new DataTransfer();
        document.activeElement.dispatchEvent(
          new ClipboardEvent("copy", {
            bubbles: true,
            cancelable: true,
            clipboardData: data,
          }),
        );
        return data.getData("text/plain");
      });
    assert.ok(
      (await copyText()) === allText,
      "all 50,000 rows including wrapped lines must copy exactly",
    );
    // Extend a partial selection from a previously unmounted line into the last screen.
    const startText = "fixture line 5 ";
    const endText = "fixture line 49997 serial";
    await production.evaluate(
      ([from, to]) => {
        const walker = document.createTreeWalker(
          document.querySelector("#log"),
          NodeFilter.SHOW_TEXT,
        );
        let first, offset;
        while (walker.nextNode()) {
          const node = walker.currentNode,
            value = node.textContent;
          if (!first && value.includes(from)) {
            first = node;
            offset = value.indexOf(from);
          }
          if (first && value.includes(to)) {
            window
              .getSelection()
              .setBaseAndExtent(
                first,
                offset,
                node,
                value.indexOf(to) + to.length,
              );
            return;
          }
        }
        throw Error("long selection endpoints missing");
      },
      [startText, endText],
    );
    const partial = await copyText();
    assert.ok(
      partial ===
        allText.slice(
          allText.indexOf(startText),
          allText.indexOf(endText) + endText.length,
        ),
      "cross-screen partial selection must copy exactly",
    );
    await controls(production).locator("#command").fill("outside selection");
    await production.locator("#command").press("Control+a");
    assert.equal(await copyText(), "");
    await controls(production).locator("#search").fill("fixture line 43210 ");
    await expect(controls(production).locator("#log")).toContainText(
      "fixture line 43210 ",
    );
    assert.equal(await controls(production).locator(".log-row").count(), 1);
    await production
      .locator("#search")
      .fill("fixture line 43210 |fixture line 43212 ");
    await expect(controls(production).locator("#match-count")).toContainText(
      "2",
    );
    await expect(controls(production).locator(".log-row mark")).toHaveCount(2);
    await controls(production).locator("#match-next").click();
    await expect(controls(production).locator(".search-current")).toContainText(
      "43212",
    );
    await controls(production).locator("#search").press("Shift+Enter");
    await expect(controls(production).locator(".search-current")).toContainText(
      "43210",
    );
    await controls(production).locator("#filter-matches").uncheck();
    await controls(production).locator("#match-next").click();
    await expect(controls(production).locator(".search-current")).toContainText(
      "43212",
    );
    await expect(controls(production).locator("#log")).toContainText(
      "fixture line 43211 ",
    );
    await controls(production).locator("#filter-matches").check();
    await controls(production).locator("#search-exclude").fill("43212");
    await expect(controls(production).locator(".log-row")).toHaveCount(1);
    await controls(production).locator("#match-case").check();
    await controls(production).locator("#search").fill("FIXTURE LINE 43210 ");
    await expect(controls(production).locator(".log-row")).toHaveCount(0);
    await controls(production).locator("#match-case").uncheck();
    await expect(controls(production).locator(".log-row")).toHaveCount(1);
    await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0].setContentSize(760, 560),
    );
    await expect
      .poll(() =>
        production.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      )
      .toBe(true);
    await controls(production).locator("#export-log").click();
    await expect(controls(production).locator("#export-dialog")).toBeVisible();
    await expect
      .poll(() =>
        production
          .locator("#export-dialog")
          .evaluate((n) => n.scrollWidth <= n.clientWidth),
      )
      .toBe(true);
    await controls(production).locator("#export-close").click();
    console.log(
      "PASS Electron: live session text export, cancelled save dialog, keyword highlights/navigation/exclusion/case/context, live recording with raw-cache backfill, inline time/direction preferences, font size, persistent view limits, receive/send splitter, 50000-row virtual viewport and full-cache search; isolated renderer, capture, TX/RX, disk record, pause/clear, untrusted text, reload/offline/exit; disconnected editing, full device names, per-port drafts, history recall without send, exact CR/HEX bytes, saved custom rows, 760px layout, format conversion, checksums, docked command list, selected cyclic send, single timer, reload cancels schedule, opt-in recording, portable storage, checksum range/order, compact rows, draggable and persistent splitters.",
    );
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
