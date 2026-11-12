const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "baudloom-tabs-"));
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
    const initial = await app.firstWindow();
    await expect(initial.getByRole("tab", { selected: true })).toBeVisible();
    const replacement = app.waitForEvent("window");
    await initial.keyboard.down("Control");
    await initial.keyboard.down("w");
    const first = await replacement;
    await first.keyboard.up("w");
    await first.keyboard.up("Control");
    await expect(first.getByRole("tab")).toHaveCount(1);
    await expect(first.getByRole("tab", { selected: true })).toHaveText(
      "串口 1",
    );
    const snapshot = (page) => page.evaluate(() => window.baudloom.snapshot());
    await first.locator("#target").selectOption("demo");
    await first.locator("#record-state").click();
    await first.locator("#save-session").check();
    await first.locator("#status-close").click();
    await first.locator("#connect").click();
    await expect(first.locator("#connect")).toHaveText("断开");
    async function addTab(page) {
      const opening = app.waitForEvent("window");
      await page.locator("#add-tab").click();
      return opening;
    }
    const toolbarGeometry = (page) =>
      page.evaluate(() => ({
        portWidth: document.querySelector("#target").getBoundingClientRect()
          .width,
        settingsX: document
          .querySelector("#connection-options")
          .getBoundingClientRect().x,
      }));
    const connectedGeometry = await toolbarGeometry(first);
    const middle = await addTab(first);
    await expect(middle.getByRole("tab", { selected: true })).toHaveText(
      "串口 2",
    );
    const last = await addTab(middle);
    await expect(last.getByRole("tab", { selected: true })).toHaveText(
      "串口 3",
    );
    await expect(last.locator('#target option[value="demo"]')).toBeDisabled();
    assert.deepEqual(await toolbarGeometry(last), connectedGeometry);
    const fourth = await addTab(last);
    await expect(fourth.getByRole("tab", { selected: true })).toHaveText(
      "串口 4",
    );
    const fifth = await addTab(fourth);
    await expect(fifth.getByRole("tab", { selected: true })).toHaveText(
      "串口 5",
    );
    await fifth.getByRole("button", { name: "向左查看标签" }).click();
    await expect(
      fifth.getByRole("button", { name: "向右查看标签" }),
    ).toBeEnabled();
    await fifth.getByRole("button", { name: "向右查看标签" }).click();
    await expect(fifth.getByRole("tab", { selected: true })).toHaveText(
      "串口 5",
    );
    await fifth.getByRole("button", { name: "关闭 串口 5" }).click();
    await expect(fourth.getByRole("tab", { selected: true })).toHaveText(
      "串口 4",
    );
    await fourth.getByRole("button", { name: "关闭 串口 4" }).click();
    await expect(last.getByRole("tab", { selected: true })).toHaveText(
      "串口 3",
    );
    await last.locator("#command").fill("保留此标签的草稿");
    await last
      .getByRole("button", { name: "关闭 串口 2", exact: true })
      .click();
    await expect(last.getByRole("tab", { selected: true })).toHaveText(
      "串口 2",
    );
    await expect(last.locator("#command")).toHaveValue("保留此标签的草稿");
    await last
      .getByRole("button", { name: "关闭 串口 2", exact: true })
      .click();
    await expect(first.getByRole("tab")).toHaveCount(1);
    const second = await addTab(first);
    await expect(second.getByRole("tab", { selected: true })).toHaveText(
      "串口 2",
    );
    await expect(second.locator("#target")).toHaveValue("demo-2");
    await expect(second.locator('#target option[value="demo"]')).toBeDisabled();
    assert.deepEqual(await toolbarGeometry(second), connectedGeometry);
    await assert.rejects(
      second.evaluate(() =>
        window.baudloom.connect({
          target: "demo",
          source: "synthetic",
          baudRate: 115200,
        }),
      ),
      /其他标签页/,
    );
    await second.locator("#connect").click();
    await expect(second.locator("#connect")).toHaveText("断开");
    await expect(first).toHaveTitle("Baudloom · demo");
    await expect(second).toHaveTitle("Baudloom · demo-2");
    const select = (page, name) =>
      page.getByRole("tab", { name, exact: true }).click();
    await expect(
      second.getByRole("tab", { name: "demo-2", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    assert.equal(
      await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length),
      1,
    );
    await select(second, "demo");
    await first.locator("#command").fill("A 草稿");
    await select(first, "demo-2");
    await second.locator("#command").fill("B 草稿");
    await select(second, "demo");
    await expect(first.locator("#command")).toHaveValue("A 草稿");
    for (const [page, command] of [
      [first, "alpha"],
      [second, "bravo"],
    ]) {
      if (page === second) {
        await select(first, "demo-2");
        await expect(second.locator("#command")).toHaveValue("B 草稿");
      }
      await page.locator("#command").fill(command);
      await page.locator("#send").click();
      await expect(page.locator("#log")).toContainText(command);
    }
    await second.locator("#send-options").click();
    await second.locator("#single-interval").fill("100");
    await second.locator("#single-timer").click();
    await second.locator("#send-options-close").click();
    await select(second, "demo");
    const background = await snapshot(second);
    const displayedTail = () =>
      second.locator("#log .log-row").last().getAttribute("data-row-id");
    const hiddenTail = await displayedTail();
    await expect
      .poll(async () => (await snapshot(second)).txBytes)
      .toBeGreaterThan(background.txBytes);
    await expect
      .poll(async () => (await snapshot(second)).rxBytes)
      .toBeGreaterThan(background.rxBytes);
    assert.equal(await displayedTail(), hiddenTail);
    await select(first, "demo-2");
    await expect
      .poll(async () => Number(await displayedTail()))
      .toBeGreaterThan(Number(hiddenTail));
    await second.locator("#stop-sending").click();
    await select(second, "demo");
    await first.reload();
    await expect(first.locator("#target")).toHaveValue("demo");
    await expect(first.locator("#connect")).toHaveText("断开");
    const a = await snapshot(first),
      b = await snapshot(second);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.ok(!a.rows.some((r) => r.text.includes("bravo")));
    assert.ok(!b.rows.some((r) => r.text.includes("alpha")));
    await first.locator("#pause").click();
    await first.locator("#more-tools").click();
    await first.locator("#clear").click();
    await expect(first.locator("#log")).not.toContainText("alpha");
    await expect(first.locator("#log")).toContainText("[demo] sample=");
    await expect(second.locator("#log")).toContainText("bravo");
    await first.getByRole("button", { name: "关闭 demo", exact: true }).click();
    const prompt = first.locator("#close-dialog");
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("button", { name: "取消" })).toBeFocused();
    await expect(prompt.locator("li")).toHaveCount(1);
    await expect(prompt.locator("li")).toHaveText("demo");
    await first.keyboard.press("Escape");
    await expect(prompt).toBeHidden();
    await expect(first.getByRole("tab")).toHaveCount(2);
    assert.equal((await snapshot(first)).state, "connected");
    await select(first, "demo-2");
    const closed = first.waitForEvent("close");
    await second
      .getByRole("button", { name: "关闭 demo", exact: true })
      .click();
    await expect(second.locator("#close-dialog li")).toHaveText("demo");
    await second.getByRole("button", { name: "断开并关闭" }).click();
    await closed;
    const records = (await readFile(a.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(records.at(-1).event.kind, "stop");
    await expect
      .poll(async () => (await snapshot(second)).rxBytes)
      .toBeGreaterThan(b.rxBytes);
    await second.locator("#command").fill("survivor");
    await second.locator("#send").click();
    await expect(second.locator("#log")).toContainText("survivor");
    await second.locator("#connect").click();
    await expect(second.locator("#connect")).toHaveText("连接");
    await second.locator("#target").selectOption("demo");
    await second.locator("#connect").click();
    await expect(second).toHaveTitle("Baudloom · demo");
    const nextWindow = app.waitForEvent("window");
    await second.keyboard.press("Control+t");
    const third = await nextWindow;
    await expect(third.locator("#target")).toHaveValue("demo-2");
    await third.locator("#connect").click();
    await expect(third).toHaveTitle("Baudloom · demo-2");
    await third.keyboard.press("Control+Tab");
    await expect(
      second.getByRole("tab", { name: "demo", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    assert.equal(
      await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length),
      1,
    );
    const files = [];
    const closeWindow = () =>
      app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].close());
    await second.locator("#appearance").click();
    await second.locator("#connection-options").click();
    await closeWindow();
    const exitDialog = second.locator("#close-dialog");
    await expect(exitDialog).toBeVisible();
    await expect(exitDialog.locator("li")).toHaveCount(2);
    await expect(
      exitDialog.getByRole("heading", { name: /未保存/ }),
    ).toHaveCount(1);
    await expect(exitDialog.locator("section")).toHaveCount(1);
    await exitDialog.getByRole("button", { name: "取消" }).click();
    await expect(exitDialog).toBeHidden();
    await expect(second.locator("#connection-dialog")).toBeVisible();
    await second.locator("#connection-close").click();
    for (const page of [second, third]) {
      const state = await snapshot(page);
      if (!state.sessionFile)
        await page.evaluate(
          (id) => window.baudloom.startRecording(id),
          state.sessionId,
        );
      files.push((await snapshot(page)).sessionFile);
      if (page === second) {
        await closeWindow();
        await expect(
          exitDialog
            .locator("section")
            .filter({ hasText: "会话文件" })
            .locator("li"),
        ).toHaveText("demo");
        await expect(
          exitDialog
            .locator("section")
            .filter({ hasText: "未保存" })
            .locator("li"),
        ).toHaveText("demo-2");
        await exitDialog.getByRole("button", { name: "取消" }).click();
      }
    }
    assert.notEqual(files[0], files[1]);
    const exited = app.waitForEvent("close");
    await closeWindow();
    await exitDialog.getByRole("button", { name: "断开并退出" }).click();
    await exited;
    app = undefined;
    for (const file of files) {
      const last = (await readFile(file, "utf8")).trim().split("\n").at(-1);
      assert.equal(JSON.parse(last).event.kind, "stop");
    }
    console.log(
      "PASS one native window, dual-port tabs, background RX, isolated drafts and TX, clear, tab close, recording flush and port reuse",
    );
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
