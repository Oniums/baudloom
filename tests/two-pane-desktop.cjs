const { _electron: electron, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, rm, mkdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "baudloom-two-pane-"));
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
    await expect(page.locator("#connect")).toBeEnabled();
    await expect(page.locator("#search-panel")).toBeHidden();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.locator(".workspace > .session-pane")).toHaveCount(1);
    await expect(page.locator(".workspace #command-bank")).toBeVisible();
    await page.locator("#connection-options").click();
    await page.locator("#baud-presets").selectOption("230400");
    await page.locator("#connection-close").click();
    await expect(page.locator("#serial-summary")).toContainText("230400");
    await page.locator("#connect").click();
    await expect(page.locator("#connect")).toHaveText("断开");
    await page.locator("#record-state").click();
    await expect(page.locator("#save-session")).not.toBeChecked();
    await page.locator("#save-session").check();
    await expect(page.locator("#record-details")).toContainText("已补写");
    await page.locator("#status-close").click();
    await page.locator("#command").fill("123");
    await page.locator("#tx-format").selectOption("hex");
    await expect(page.locator("#command")).toHaveValue("31 32 33");
    await page.locator("#send-options").click();
    await page.locator("#single-interval").fill("100");
    await page.locator("#single-timer").click();
    await page.locator("#send-options-close").click();
    await expect(page.locator("#stop-sending")).toBeVisible();
    await page.locator("#stop-sending").click();
    await expect(page.locator("#stop-sending")).toBeHidden();
    await page.locator("#collapse-multi").click();
    const receiveBox = await page.locator("main").boundingBox();
    await page.locator("#toggle-multi").click();
    await expect(page.locator("#command-bank")).toBeVisible();
    await page.locator(".slot-text").first().fill("multi draft");
    await page.locator(".slot-selected").first().check();
    await page.locator("#multi-interval").fill("100");
    await page.locator("#multi-timer").click();
    await expect(page.locator("#log")).toBeVisible();
    assert.ok(
      (await page.locator("main").boundingBox()).width < receiveBox.width,
    );
    await page.locator("#collapse-multi").click();
    await expect(page.locator("#command-bank")).toBeHidden();
    assert.deepEqual(await page.locator("main").boundingBox(), receiveBox);
    await expect(page.locator("#stop-sending")).toBeVisible();
    await page.locator("#stop-sending").click();
    await expect(page.locator("#stop-sending")).toBeHidden();
    await page.locator("#more-tools").click();
    await page.locator("#view-options").click();
    await expect(page.locator("#view-dialog")).toBeVisible();
    await expect(page.locator("#more-tools-panel")).toBeHidden();
    await page.locator("#wrap-lines").uncheck();
    await page.keyboard.press("Escape");
    await expect(page.locator("#view-dialog")).toBeHidden();
    await page.locator("#command").fill("");
    await mkdir(".local/screenshots", { recursive: true });
    await page.screenshot({
      path: ".local/screenshots/two-pane-connected.png",
    });
    await page.locator("#connect").click();
    const file = path.join(root, "matching.log");
    await writeFile(
      file,
      "normal line\nERROR sensor\nerror heartbeat\ntimeout device\nnormal tail",
    );
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, file);
    await page.locator("#history").click();
    await expect(page.locator(".log-row")).toHaveCount(5);
    await page.locator("#search-options").click();
    await expect(page.getByLabel("匹配关键词", { exact: true })).toBeVisible();
    await expect(page.locator("#search-exclude")).toBeHidden();
    await page.getByLabel("匹配关键词", { exact: true }).fill("error");
    await expect(page.locator(".log-row")).toHaveCount(2);
    await expect(page.locator(".log-row mark")).toHaveCount(2);
    await page.locator("#search").fill("error | timeout");
    await expect(page.locator(".log-row")).toHaveCount(3);
    await page.locator("#match-next").click();
    await expect(page.locator(".search-current")).toContainText(
      "error heartbeat",
    );
    await page.locator("#search-advanced summary").click();
    await page.locator("#search-exclude").fill("heartbeat");
    await expect(page.locator(".log-row")).toHaveCount(2);
    await page.locator("#match-case").check();
    await expect(page.locator(".log-row")).toHaveCount(1);
    await page.locator("#match-case").uncheck();
    await page.locator("#filter-matches").uncheck();
    await expect(page.locator(".log-row")).toHaveCount(4);
    await page.locator("#filter-matches").check();
    await page.screenshot({ path: ".local/screenshots/two-pane-search.png" });
    await page.locator("#search-close").click();
    await expect(page.locator(".log-row")).toHaveCount(5);
    await expect(page.locator("#search-exclude")).toHaveValue("");
    await page.keyboard.press("Control+f");
    await expect(page.locator("#search")).toBeFocused();
    await page.locator("#search").fill("no matches");
    await expect(page.locator(".log-row")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("#search-panel")).toBeHidden();
    await expect(page.locator(".log-row")).toHaveCount(5);
    for (const size of [
      [760, 560],
      [1280, 820],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setContentSize(...size),
        size,
      );
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
                document.documentElement.clientWidth &&
              document.documentElement.scrollHeight <=
                document.documentElement.clientHeight,
          ),
        )
        .toBe(true);
      await page.locator("#more-tools").click();
      await page.keyboard.press("Escape");
      await expect(page.locator("#more-tools-panel")).toBeHidden();
      if (size[0] === 760)
        await page.screenshot({
          path: ".local/screenshots/two-pane-narrow.png",
        });
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS two-pane desktop: collapsed tools, connection and live backfill entry points, timer stop without reopening settings, docked multi-send with restored log width, match/exclude/highlights/context, close/Escape restores all rows, Ctrl+F, 760px menu.",
    );
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
