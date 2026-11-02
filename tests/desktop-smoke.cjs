const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, mkdir, readdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
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
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator("#command").isEnabled(), true);
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
    await page.locator("#refresh").click();
    await page.locator("#target").selectOption("COM12");
    assert.equal(
      await page.locator("#target option:checked").textContent(),
      "WCH USB-SERIAL Ch A (COM12)",
    );
    assert.equal(
      await page.locator("#send-target").textContent(),
      "WCH USB-SERIAL Ch A (COM12)",
    );
    await page.locator("#command").fill("COM12 draft");
    await page.locator("#target").selectOption("COM5");
    assert.equal(await page.locator("#command").inputValue(), "");
    await page.locator("#target").selectOption("COM12");
    assert.equal(await page.locator("#command").inputValue(), "COM12 draft");
    await mkdir(".local/screenshots", { recursive: true });
    await page.screenshot({
      path: ".local/screenshots/desktop-device-name.png",
    });
    await page.locator("#target").selectOption("COM99");
    assert.equal(await page.locator("#device-name").isVisible(), true);
    // The splitter's ResizeObserver clamps the saved width after native window resize.
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.locator("#target").selectOption("demo");
    await page.locator("#command").fill("123");
    await page.locator("#tx-format").selectOption("hex");
    assert.equal(await page.locator("#command").inputValue(), "31 32 33");
    await page.locator("#tx-format").selectOption("text");
    assert.equal(await page.locator("#command").inputValue(), "123");
    assert.equal(await page.title(), "Baudloom");
    assert.ok(
      !(await page.locator(".titlebar").textContent()).includes("预览"),
    );
    assert.equal(await page.locator("#save-session").isChecked(), false);
    await page.locator("#connect").click();
    await page.getByRole("button", { name: "断开", exact: true }).waitFor();
    await page.locator("#command").fill("unsaved-data");
    await page.locator("#send").click();
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
      (await page.locator("#record-state").textContent()).includes("未保存"),
    );
    assert.equal(await page.locator("#save-session").isEnabled(), true);
    assert.ok(!(await readdir(root)).includes("sessions"));
    const liveId = (await page.evaluate(() => window.baudloom.snapshot()))
      .sessionId;
    await page.locator("#save-session").check();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot()))
            .backfilledEvents,
      )
      .toBeGreaterThan(0);
    await expect(page.locator("#record-state")).toContainText("已补写");
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
    await page.locator("#view-options").click();
    await page.locator("#show-time").uncheck();
    await page.locator("#show-direction").uncheck();
    await expect(page.locator(".log-row .time").first()).toBeHidden();
    await expect(page.locator(".log-row .direction").first()).toBeHidden();
    await page.locator("#log-font-size").fill("18");
    await page.locator("#log-font-size").press("Tab");
    assert.equal(
      await page.locator("#log").evaluate((n) => getComputedStyle(n).fontSize),
      "18px",
    );
    await page.locator("#view-max-rows").fill("20000");
    await page.locator("#view-max-chars").selectOption("8");
    await page.locator("#apply-view-limits").click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).viewLimits
            .maxRows,
      )
      .toBe(20000);
    await expect(page.locator("#view-memory")).toContainText("不是实测值");
    await page.locator("#show-time").check();
    await page.locator("#show-direction").check();
    await page.locator("#log-font-size").fill("14");
    await page.locator("#log-font-size").press("Tab");
    await page.locator("#view-options").click();
    const colHandle = await page.locator("#time-resizer").boundingBox();
    const beforeCol = await page.locator(".time-column").boundingBox();
    await page.mouse.move(colHandle.x + 5, colHandle.y + 10);
    await page.mouse.down();
    await page.mouse.move(colHandle.x + 45, colHandle.y + 10);
    await page.mouse.up();
    assert.ok(
      (await page.locator(".time-column").boundingBox()).width >
        beforeCol.width + 30,
    );
    await page.locator("#time-resizer").press("Home");
    await page.locator("#connect").click();
    await page.getByRole("button", { name: "连接", exact: true }).waitFor();
    await page.locator("#save-session").check();
    await page.locator("#command").fill("draft before connecting");
    const beforeShortcut = (
      await page.evaluate(() => window.baudloom.snapshot())
    ).txBytes;
    await page.locator("#command").press("Control+Enter");
    assert.equal(
      (await page.evaluate(() => window.baudloom.snapshot())).txBytes,
      beforeShortcut,
    );
    await page.locator("#target").selectOption("demo");
    await page.locator("#connect").click();
    await page.getByRole("button", { name: "断开", exact: true }).waitFor();
    assert.equal(
      await page.locator("#command").inputValue(),
      "draft before connecting",
    );
    assert.equal(
      await page.getByRole("button", { name: "查询状态", exact: true }).count(),
      0,
    );
    await page.waitForFunction(() =>
      document.querySelector("#log").textContent.includes("[demo] sample="),
    );
    await page.locator("#command").fill("status");
    await page.locator("#send").click();
    await page.waitForFunction(() =>
      document.querySelector("#log").textContent.includes("主机写入完成"),
    );
    const file = (await page.evaluate(() => window.baudloom.snapshot()))
      .sessionFile;
    assert.ok((await readFile(file, "utf8")).includes("tx-request"));
    assert.equal(await page.locator("#command").inputValue(), "status");
    await page.locator("#clear-command").click();
    assert.equal(await page.locator("#command").inputValue(), "");
    const txBeforeHistory = (
      await page.evaluate(() => window.baudloom.snapshot())
    ).txBytes;
    await page.locator("#send-history").selectOption("0");
    assert.equal(await page.locator("#command").inputValue(), "status");
    assert.equal(
      (await page.evaluate(() => window.baudloom.snapshot())).txBytes,
      txBeforeHistory,
    );
    await page.locator("#clear-after-send").check();
    await page.locator("#command").fill("中");
    await page.locator("#ending").selectOption("cr");
    await page.waitForFunction(() =>
      document.querySelector("#send-bytes").textContent.includes("4 B"),
    );
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector("#command").value === "",
    );
    await page.locator("#toggle-multi").click();
    const row = page.locator(".command-row").first();
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
    const bounds = await page.evaluate(() => ({
      log: document.querySelector("main").getBoundingClientRect().right,
      bank: document.querySelector("#command-bank").getBoundingClientRect()
        .left,
    }));
    assert.ok(bounds.bank >= bounds.log);
    const originalSide = await page.locator("#command-bank").boundingBox();
    const sideHandle = await page.locator("#side-splitter").boundingBox();
    await page.mouse.move(sideHandle.x + 2, sideHandle.y + 30);
    await page.mouse.down();
    await page.mouse.move(sideHandle.x - 65, sideHandle.y + 30, { steps: 5 });
    await page.mouse.up();
    assert.ok(
      (await page.locator("#command-bank").boundingBox()).width >
        originalSide.width + 50,
    );
    const originalBottom = await page.locator(".composer").boundingBox();
    const bottomHandle = await page.locator("#bottom-splitter").boundingBox();
    await page.mouse.move(bottomHandle.x + 50, bottomHandle.y + 2);
    await page.mouse.down();
    await page.mouse.move(bottomHandle.x + 50, bottomHandle.y - 35, {
      steps: 5,
    });
    await page.mouse.up();
    assert.ok(
      (await page.locator(".composer").boundingBox()).height >
        originalBottom.height + 25,
    );
    const joint = await page.locator("#cross-splitter").boundingBox();
    const beforeJointWidth = (await page.locator("#command-bank").boundingBox())
      .width;
    const beforeJointHeight = (await page.locator(".composer").boundingBox())
      .height;
    await page.mouse.move(joint.x + 7, joint.y + 7);
    await page.mouse.down();
    await page.mouse.move(joint.x - 23, joint.y - 23, { steps: 5 });
    await page.mouse.up();
    assert.ok(
      (await page.locator("#command-bank").boundingBox()).width >
        beforeJointWidth + 20,
    );
    assert.ok(
      (await page.locator(".composer").boundingBox()).height >
        beforeJointHeight + 20,
    );
    const savedLayout = await page.evaluate(() =>
      localStorage.getItem("baudloom.layout.v1"),
    );
    await row.locator(".slot-selected").check();
    await row.locator(".slot-checksum").selectOption("xor8");
    const second = page.locator(".command-row").nth(1);
    await second.locator(".slot-text").fill("B");
    await second.locator(".slot-format").selectOption("hex");
    assert.equal(await second.locator(".slot-text").inputValue(), "42");
    await second.locator(".slot-selected").check();
    const third = page.locator(".command-row").nth(2);
    await third.locator(".slot-text").fill("NOT SELECTED");
    await page.locator("#multi-interval").fill("100");
    const beforeBatch = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((r) => r.event.kind === "tx-request").length;
    await page.locator("#multi-timer").click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).schedule
            .completed,
      )
      .toBeGreaterThanOrEqual(3);
    assert.equal(await page.locator("#command").isDisabled(), true);
    await page.locator("#multi-timer").click();
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
    await page.locator("#tx-format").selectOption("hex");
    await page.locator("#command").fill("AA 01 03 00 00 00 0A BB");
    await page.locator("#checksum").selectOption("modbus");
    await page.locator("#checksum-start").fill("2");
    await page.locator("#checksum-end").fill("7");
    await page.locator("#checksum-order").selectOption("big");
    assert.equal(
      await page.locator("#checksum-value").textContent(),
      "校验值 CD C5",
    );
    await page.locator("#send").click();
    await expect
      .poll(async () =>
        (await readFile(file, "utf8")).includes(
          Buffer.from("aa01030000000abbcdc5", "hex").toString("base64"),
        ),
      )
      .toBe(true);
    await page.locator("#checksum-start").fill("1");
    await page.locator("#checksum-end").fill("");
    await page.locator("#checksum-order").selectOption("little");
    await page.locator("#tx-format").selectOption("text");
    await page.locator("#command").fill("123456789");
    await page.locator("#ending").selectOption("none");
    await page.locator("#checksum").selectOption("modbus");
    await page.locator("#single-interval").fill("250");
    await page.locator("#single-timer").click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).schedule
            .completed,
      )
      .toBeGreaterThanOrEqual(2);
    await page.locator("#single-timer").click();
    await page.waitForFunction(
      () => !document.querySelector("#command").disabled,
    );
    assert.equal(await page.locator("#command").inputValue(), "123456789");
    await expect
      .poll(async () =>
        (await readFile(file, "utf8")).includes(
          Buffer.from("313233343536373839374b", "hex").toString("base64"),
        ),
      )
      .toBe(true);
    await page.locator("#checksum").selectOption("none");
    await page.locator("#ending").selectOption("crlf");
    await page.locator("#toggle-multi").click();
    await page.locator("#pause").click();
    const visible = await page.locator("#log").textContent();
    const count = await page.evaluate(() =>
      window.baudloom.snapshot().then((x) => x.eventCount),
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).eventCount,
      )
      .toBeGreaterThan(count + 3);
    assert.equal(await page.locator("#log").textContent(), visible);
    await page.locator("#pause").click();
    await page.locator("#clear").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".log-row").length > 0,
    );
    assert.ok(
      (await page.evaluate(() => window.baudloom.snapshot())).eventCount >
        count,
    );
    await page.locator("#search").fill("<script>");
    assert.equal(await page.locator(".log-row").count(), 0);
    await page.locator("#search").fill("");
    await page.locator("#command").fill("<img src=x onerror=alert(1)>");
    await page.locator("#send").click();
    await page.waitForFunction(() =>
      document.querySelector("#log").textContent.includes("<img"),
    );
    assert.equal(await page.locator("#log img").count(), 0);
    const beforeReload = (await page.evaluate(() => window.baudloom.snapshot()))
      .eventCount;
    await page.locator("#command").fill("reload-stop");
    await page.locator("#single-timer").click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.baudloom.snapshot())).schedule
            .active,
      )
      .toBe(true);
    await page.reload();
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
    await page.locator("#toggle-multi").click();
    assert.ok(
      (await page.locator("#command-bank").boundingBox()).width >
        originalSide.width + 50,
    );
    assert.equal(
      (await page.evaluate(() => window.baudloom.snapshot())).viewLimits
        .maxRows,
      20000,
    );
    await page.locator("#side-splitter").press("Home");
    await page.locator("#bottom-splitter").press("Home");
    assert.equal(
      await page.locator(".slot-text").first().inputValue(),
      "00 FF",
    );
    await page.locator("#toggle-multi").click();
    await page.locator("#connect").click();
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
    await page.locator("#history").click();
    await page.waitForFunction(() =>
      document.querySelector("#connection-state").textContent.includes("离线"),
    );
    assert.ok(await page.locator("#log").textContent());
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator("#command").isEnabled(), true);
    await mkdir(".local/screenshots", { recursive: true });
    await page.screenshot({ path: ".local/screenshots/desktop-offline.png" });
    await page.locator("#target").selectOption("demo");
    await page.locator("#connect").click();
    await page.getByRole("button", { name: "断开", exact: true }).waitFor();
    await page.waitForFunction(() =>
      document.querySelector("#log").textContent.includes("[demo] sample=18"),
    );
    await page.locator("#command").fill("version");
    await page.locator("#send").click();
    await page.waitForFunction(() =>
      document.querySelector("#log").textContent.includes("主机写入完成"),
    );
    await page.screenshot({ path: ".local/screenshots/desktop-connected.png" });
    await page.locator("#toggle-multi").click();
    await page.screenshot({
      path: ".local/screenshots/desktop-multi-send.png",
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(760, 560),
    );
    await page.waitForFunction(() => innerWidth === 760);
    // The splitter's ResizeObserver clamps the saved width after native window resize.
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    assert.ok(
      (await page.locator("#log").evaluate((e) => e.clientHeight)) > 50,
    );
    await page.screenshot({
      path: ".local/screenshots/desktop-small-send.png",
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 820),
    );
    await page.waitForFunction(() => innerWidth === 1280);
    await page.locator("#toggle-multi").click();
    // The splitter's ResizeObserver clamps the saved width after native window resize.
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.locator("#command").fill("exit-stop");
    await page.locator("#single-timer").click();
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
    await app.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      BrowserWindow.getAllWindows()[0].close();
    });
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
    await production.locator("#connect").waitFor();
    assert.equal(await production.locator("#save-session").isChecked(), false);
    const dataPath = await app.evaluate(({ app }) => app.getPath("userData"));
    assert.equal(
      dataPath,
      path.join(root, "launcher", "Baudloom-data", "profile"),
    );
    const ports = await production.evaluate(() => window.baudloom.ports());
    assert.ok(ports.every((p) => p.source === "serial"));
    await production.locator("#command").fill("123");
    await production.locator("#tx-format").selectOption("hex");
    await production.locator("#checksum").selectOption("sum8");
    await production.locator("#toggle-multi").click();
    const productionRows = production.locator(".command-row");
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
    assert.ok(!/演示|预览/.test(await production.locator("body").innerText()));
    await production.screenshot({
      path: ".local/screenshots/desktop-production.png",
    });
    await production.locator("#view-options").click();
    await production.screenshot({
      path: ".local/screenshots/desktop-view-settings.png",
    });
    await production.locator("#view-options").click();
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
        rxBytes: 5000000,
        viewLimits: { maxRows: 50000, maxChars: 16 * 1048576 },
      }));
    }, base);
    await expect(production.locator("#log")).toContainText(
      "fixture line 49999",
    );
    assert.ok((await production.locator(".log-row").count()) < 200);
    await production.locator("#pause").click();
    await production.locator("#log").evaluate((n) => {
      n.scrollTop = 0;
    });
    await expect(production.locator("#log")).toContainText("fixture line 0 ");
    assert.ok((await production.locator(".log-row").count()) < 200);
    await production.locator("#pause").click();
    await production.locator("#search").fill("fixture line 43210 ");
    await expect(production.locator("#log")).toContainText(
      "fixture line 43210 ",
    );
    assert.equal(await production.locator(".log-row").count(), 1);
    console.log(
      "PASS Electron: live recording with raw-cache backfill, column visibility/width, font size, persistent view limits, joint splitter, 50000-row virtual viewport and full-cache search; isolated renderer, capture, TX/RX, disk record, pause/clear, untrusted text, reload/offline/exit; disconnected editing, full device names, per-port drafts, history recall without send, exact CR/HEX bytes, saved custom rows, 760px layout, format conversion, checksums, right panel, selected cyclic send, single timer, reload cancels schedule, opt-in recording, portable storage, checksum range/order, compact rows, draggable and persistent splitters.",
    );
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
