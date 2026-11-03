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
    app = await electron.launch({
      executablePath: process.env.BAUDLOOM_EXECUTABLE,
      args: [
        ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
        ...(process.env.BAUDLOOM_EXECUTABLE ? [] : ["."]),
      ],
      env: { ...process.env, BAUDLOOM_DATA_DIR: root, BAUDLOOM_TEST_MODE: "1" },
    });
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
    await controls(page).locator("#log").hover();
    await page.mouse.wheel(0, -200);
    await expect(controls(page).locator("#back-to-latest")).toBeVisible();
    await expect(controls(page).locator("#back-to-latest")).not.toHaveText(
      /新增 0 行/,
    );
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
    assert.deepEqual(errors, []);
    console.log(
      "PASS workflow desktop: serial settings, persisted profiles without sending, hotplug selection, scroll following/unread count, marks/time difference, plain log import, compact composer without scrollbars at 760px.",
    );
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
