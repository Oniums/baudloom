// Existing behavior suites reach relocated controls through their visible entry points.
// The two-pane suite uses raw locators to verify those entry points themselves.
function controls(page) {
  const wrap = (locator) =>
    new Proxy(locator, {
      get(target, key) {
        if (["locator", "first", "last", "nth", "filter"].includes(key))
          return (...args) => wrap(target[key](...args));
        if (
          [
            "click",
            "fill",
            "check",
            "uncheck",
            "selectOption",
            "press",
            "hover",
          ].includes(key)
        )
          return async (...args) => {
            const info = await target.evaluate((n) => ({
              id: n.id,
              dialog: n.closest("dialog")?.id,
              menu: !!n.closest("#more-tools-panel"),
              search: !!n.closest("#search-panel"),
              advanced: !!n.closest("#search-advanced"),
            }));
            if (
              key === "click" &&
              info.id === "view-options" &&
              (await page.locator("#view-dialog").isVisible())
            )
              return page.locator("#view-close").click();
            for (const dialog of await page.locator("dialog[open]").all()) {
              if ((await dialog.getAttribute("id")) !== info.dialog)
                await page.keyboard.press("Escape");
            }
            if (
              info.dialog &&
              !(await page.locator("#" + info.dialog).isVisible())
            ) {
              const opener = {
                "connection-dialog": "connection-options",
                "send-options-dialog": "send-options",
                "status-dialog": "record-state",
                "view-dialog": "view-options",
              }[info.dialog];
              if (!opener) throw Error("Missing dialog entry: " + info.dialog);
              if (opener === "view-options")
                await page.locator("#more-tools").click();
              await page.locator("#" + opener).click();
            }
            if (
              info.menu &&
              !(await page.locator("#more-tools-panel").isVisible())
            )
              await page.locator("#more-tools").click();
            if (
              info.search &&
              !(await page.locator("#search-panel").isVisible())
            )
              await page.locator("#search-options").click();
            if (
              info.advanced &&
              (await page.locator("#search-advanced").getAttribute("open")) ===
                null
            )
              await page.locator("#search-advanced summary").click();
            return target[key](...args);
          };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return { locator: (...args) => wrap(page.locator(...args)) };
}
module.exports = { controls };
