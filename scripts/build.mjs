import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist/renderer", { recursive: true });
await build({
  entryPoints: {
    "desktop/main": "src/desktop/main.ts",
    "desktop/preload": "src/desktop/preload.ts",
    "core/worker": "src/core/worker.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  packages: "external",
  target: "node22",
  sourcemap: true,
});
await build({
  entryPoints: ["src/renderer/ui.ts"],
  outfile: "dist/renderer/ui.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome130",
  sourcemap: true,
});
for (const file of ["index.html", "style.css"])
  await copyFile(`src/renderer/${file}`, `dist/renderer/${file}`);

await copyFile("assets/brand/baudloom.png", "dist/desktop/baudloom.png");
