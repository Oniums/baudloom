import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storagePaths, prepareStorage } from "../src/desktop/storage";
test("portable data uses original launcher directory, not the extraction directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baudloom-paths-"));
  try {
    const paths = storagePaths({
      portableDir: dir,
      packaged: true,
      executable: join(dir, "temp", "app.exe"),
      project: "unused",
    });
    assert.equal(paths.root, join(dir, "Baudloom-data"));
    prepareStorage(paths);
    assert.deepEqual((await readdir(paths.root)).sort(), [
      "cache",
      "crashes",
      "logs",
      "profile",
    ]);
    assert.equal(
      storagePaths({
        packaged: true,
        executable: join(dir, "app.exe"),
        project: "unused",
      }).root,
      paths.root,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
