const { controls } = require("./desktop-controls.cjs");
const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, rm, mkdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "baudloom-workflow-ui-"));
  let app;
  try {
    const launch = () =>
      electron.launch({
        executablePath: process.env.BAUDLOOM_EXECUTABLE,
        args: [
          ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
          ...(process.env.BAUDLOOM_EXECUTABLE ? [] : ["."]),
        ],
        env: {
          ...process.env,
          BAUDLOOM_DATA_DIR: root,
          BAUDLOOM_TEST_MODE: "1",
        },
      });
    app = await launch();
    const page = await app.firstWindow(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(controls(page).locator("#target")).toHaveValue("demo");
    await controls(page).locator("#command").fill("profile draft");
    await expect(controls(page).locator("#send-availability")).toHaveText(
      "请先连接",
    );
    await controls(page).locator("#connection-options").click();
    await controls(page).locator("#serial-dataBits").selectOption("7");
    await controls(page).locator("#serial-stopBits").selectOption("2");
    await controls(page).locator("#serial-parity").selectOption("even");
    await controls(page).locator(".profile-settings summary").click();
    await controls(page).locator("#profile-name").fill("Bench A");
    await controls(page).locator("#profile-save").click();
    await expect(controls(page).locator("#profile-status")).toContainText(
      "已保存",
    );
    await controls(page).locator("#connection-close").click();
    await controls(page).locator("#command").fill("changed");
    await controls(page).locator("#connection-options").click();
    await controls(page).locator("#profile-apply").click();
    await expect(controls(page).locator("#profile-status")).toContainText(
      "未连接设备或发送命令",
    );
    await controls(page).locator("#connection-close").click();
    await expect(controls(page).locator("#command")).toHaveValue(
      "profile draft",
    );
    assert.equal(
      (await page.evaluate(() => window.baudloom.snapshot())).state,
      "idle",
    );
    await page.reload();
    await expect(controls(page).locator("#target")).toHaveValue("demo");
    await controls(page).locator("#connection-options").click();
    await controls(page).locator(".profile-settings summary").click();
    await controls(page).locator("#profile-list").selectOption("Bench A");
    await controls(page).locator("#profile-apply").click();
    await controls(page).locator("#connection-close").click();
    await expect(controls(page).locator("#serial-summary")).toContainText(
      "7E2",
    );
    await controls(page).locator("#connect").click();
    await expect(controls(page).locator("#connect")).toHaveText("断开");
    const snap = await page.evaluate(() => window.baudloom.snapshot());
    assert.equal(snap.serial.parity, "even");
    assert.equal(snap.serial.dataBits, 7);
    assert.equal(snap.txBytes, 0);
    await expect(controls(page).locator("#send-availability")).toHaveText("");
    await controls(page).locator("#record-state").click();
    await expect(controls(page).locator("#status-dialog")).toBeVisible();
    await expect(controls(page).locator("#record-details")).toContainText(
      "可补写",
    );
    await expect(controls(page).locator("#directory-path")).toContainText(root);
    await page.keyboard.press("Escape");
    await expect(controls(page).locator("#status-dialog")).toBeHidden();
    await controls(page).locator("#connection-options").click();
    assert.equal(
      await controls(page).locator("#serial-dataBits").isDisabled(),
      true,
    );
    assert.equal(
      await controls(page).locator("#profile-apply").isDisabled(),
      true,
    );
    await controls(page).locator("#connection-close").click();
    await controls(page).locator("#reading-options").click();
    await controls(page).locator("#mark").click();
    await expect(controls(page).locator("#mark-list")).toContainText(
      "手工标记",
    );
    // Exercise an overflowing viewport, not just the "back to latest" button.
    await expect
      .poll(
        () =>
          page.locator("#log").evaluate((n) => n.scrollHeight - n.clientHeight),
        { timeout: 15000 },
      )
      .toBeGreaterThan(100);
    await controls(page).locator("#log").hover();
    await page.mouse.wheel(0, -200);
    await expect(controls(page).locator("#back-to-latest")).toBeVisible();
    await expect(controls(page).locator("#back-to-latest")).not.toHaveText(
      /新增 0 行/,
    );
    await page.mouse.wheel(0, 4000);
    await expect(controls(page).locator("#back-to-latest")).toBeHidden();
    const resumedRows = (await page.evaluate(() => window.baudloom.snapshot()))
      .totalRows;
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.baudloom.snapshot().then((s) => s.totalRows),
        ),
      )
      .toBeGreaterThan(resumedRows);
    await expect
      .poll(() =>
        page
          .locator("#log")
          .evaluate((n) => n.scrollHeight - n.clientHeight - n.scrollTop),
      )
      .toBeLessThanOrEqual(2);
    await page.mouse.wheel(0, -250);
    await expect(controls(page).locator("#back-to-latest")).toBeVisible();
    await controls(page).locator("#back-to-latest").click();
    await expect(controls(page).locator("#back-to-latest")).toBeHidden();
    await controls(page).locator("#mark-next").click();
    await expect(controls(page).locator("#back-to-latest")).toBeVisible();
    await controls(page).locator("#measure-time").click();
    await controls(page).locator(".log-row").first().click();
    await controls(page).locator(".log-row").last().click();
    await expect(controls(page).locator("#time-difference")).toContainText(
      "主机单调时钟",
    );
    await expect(controls(page).locator(".time-selected")).toHaveCount(2);
    await controls(page).locator("#connect").click();
    await expect(controls(page).locator("#connect")).toHaveText("连接");
    // Removing one device must not silently select the next; polling never opens a port.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("ports");
      globalThis.fixturePorts = [
        { path: "COM98", label: "Mock adapter", source: "serial" },
      ];
      ipcMain.handle("ports", () => globalThis.fixturePorts);
    });
    await expect(
      controls(page).locator("#target option:checked"),
    ).toContainText("未检测到", { timeout: 6000 });
    assert.equal(await controls(page).locator("#connect").isDisabled(), true);
    await app.evaluate(() => {
      globalThis.fixturePorts.unshift({
        path: "demo",
        label: "测试端口（合成数据）",
        source: "synthetic",
      });
    });
    await expect(controls(page).locator("#target option:checked")).toHaveText(
      "测试端口（合成数据）",
      { timeout: 6000 },
    );
    assert.equal(
      (await page.evaluate(() => window.baudloom.snapshot())).state,
      "stopped",
    );
    const file = path.join(root, "plain.log");
    await writeFile(file, "<script>not executable</script>\nerror test\nlast");
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, file);
    await controls(page).locator("#history").click();
    await expect(controls(page).locator("#log")).toContainText(
      "<script>not executable</script>",
    );
    assert.equal(await controls(page).locator("#log script").count(), 0);
    assert.equal(await controls(page).locator("#rx-format").isDisabled(), true);
    await controls(page).locator("#measure-time").click(); // reset after previous timing operation
    await controls(page).locator("#measure-time").click();
    await controls(page).locator(".log-row").first().click();
    await controls(page).locator(".log-row").last().click();
    await expect(controls(page).locator("#time-difference")).toContainText(
      "无法计算",
    );
    await controls(page).locator("#reading-options").click();
    await controls(page).locator("#command").fill("long command\n".repeat(80));
    for (const [width, height] of [
      [1280, 820],
      [1101, 720],
      [760, 560],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setContentSize(...size),
        [width, height],
      );
      await expect
        .poll(() =>
          page
            .locator(".composer")
            .evaluate((n) => n.scrollHeight <= n.clientHeight + 1),
        )
        .toBe(true);
      assert.equal(
        await page
          .locator(".composer")
          .evaluate((n) => getComputedStyle(n).overflowY),
        "hidden",
      );
      assert.equal(
        await page
          .locator("#command")
          .evaluate((n) => getComputedStyle(n).scrollbarWidth),
        "none",
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
    }
    await controls(page).locator("#command").fill("Hello device");
    await mkdir(".local/screenshots", { recursive: true });
    await page.screenshot({ path: ".local/screenshots/ui-polish-narrow.png" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 820),
    );
    await mkdir(".local/screenshots", { recursive: true });
    await page.screenshot({ path: ".local/screenshots/v015-clean.png" });
    await expect(controls(page).locator("#more-tools")).toBeVisible();
    await expect(controls(page).locator("#search-options")).toBeVisible();
    await controls(page).locator("#view-options").click();
    await controls(page).locator("#wrap-lines").uncheck();
    await page.reload();
    await controls(page).locator("#view-options").click();
    await expect(controls(page).locator("#wrap-lines")).not.toBeChecked();
    await page.keyboard.press("Escape");
    // Exercise the renderer's COM selection against a virtual list, including a failed open.
    const virtualPorts = [
      { path: "COM240", label: "COM240", source: "serial" },
      { path: "demo", label: "测试端口", source: "synthetic" },
      { path: "COM241", label: "COM241", source: "serial" },
    ];
    await app.evaluate(({ ipcMain }, ports) => {
      globalThis.fixturePorts = ports;
      ipcMain.removeHandler("connect");
      ipcMain.handle("connect", (_event, config) => {
        if (config.target !== "COM241") throw Error("模拟端口忙");
      });
    }, virtualPorts);
    await controls(page).locator("#refresh").click();
    await controls(page).locator("#target").selectOption("COM241");
    await controls(page).locator("#baud").fill("460800");
    await controls(page).locator("#serial-parity").selectOption("odd");
    await controls(page).locator("#serial-flow").selectOption("xonxoff");
    await controls(page).locator("#serial-dtr").uncheck();
    await controls(page).locator("#serial-rts").uncheck();
    await controls(page).locator("#connection-close").click();
    await controls(page).locator("#connect").click();
    await controls(page).locator("#target").selectOption("demo");
    await expect(controls(page).locator("#serial-parity")).toHaveValue("even");
    await controls(page).locator("#target").selectOption("COM240");
    await controls(page).locator("#connection-close").click();
    await controls(page).locator("#connect").click();
    await expect(controls(page).locator("#error")).toContainText("模拟端口忙");
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("dark");
    await page.locator("#appearance").click();
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("light");
    await app.close();
    app = await launch();
    const restarted = await app.firstWindow();
    await app.evaluate(({ ipcMain }, ports) => {
      globalThis.fixturePorts = ports.slice(0, 2);
      ipcMain.removeHandler("ports");
      ipcMain.handle("ports", () => globalThis.fixturePorts);
    }, virtualPorts);
    await expect(restarted.locator("#connection-options")).toBeVisible();
    await expect(restarted.locator("html")).toHaveAttribute(
      "data-theme",
      "light",
    );
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe("light");
    await expect(restarted.locator("#target")).toHaveValue("COM241");
    await expect(restarted.locator("#target option:checked")).toContainText(
      "未检测到",
    );
    await expect(restarted.locator("#connect")).toBeDisabled();
    await app.evaluate(
      (_electron, port) => globalThis.fixturePorts.push(port),
      virtualPorts[2],
    );
    await expect(restarted.locator("#connect")).toBeEnabled();
    await expect(restarted.locator("#connection-state")).toHaveText("未连接");
    await expect(restarted.locator("#baud")).toHaveValue("460800");
    await expect(restarted.locator("#serial-dataBits")).toHaveValue("7");
    await expect(restarted.locator("#serial-stopBits")).toHaveValue("2");
    await expect(restarted.locator("#serial-parity")).toHaveValue("odd");
    await expect(restarted.locator("#serial-flow")).toHaveValue("xonxoff");
    await expect(restarted.locator("#serial-dtr")).not.toBeChecked();
    await expect(restarted.locator("#serial-rts")).not.toBeChecked();
    assert.deepEqual(errors, []);
    console.log(
      "PASS workflow desktop: serial settings, last successful COM and per-port settings across restarts, missing and failed opens, persisted profiles without sending, hotplug selection, scroll following/unread count, marks/time difference, plain log import, compact composer without scrollbars at 760px.",
    );
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
