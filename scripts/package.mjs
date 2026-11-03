import { packager } from "@electron/packager";
import { readFile } from "node:fs/promises";

const platform = process.argv[2];
if (!["linux", "win32"].includes(platform))
  throw Error("Expected linux or win32");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const outputs = await packager({
  dir: ".",
  name: "Baudloom",
  executableName: "Baudloom",
  appVersion: pkg.version,
  icon: "assets/brand/baudloom",
  electronVersion: pkg.devDependencies.electron,
  platform,
  arch: "x64",
  out: "artifacts",
  overwrite: true,
  // Archive JS together; native bindings must remain real files for dlopen.
  asar: { unpack: "**/*.node" },
  electronLanguages: ["zh-CN", "en-US"],
  prune: true,
  ignore: [
    /^\/(?:\.[^/]+|artifacts|prototype|src|tests|scripts|docs|Baudloom-data|assets)(?:\/|$)/,
    /^\/(?:AGENTS|CLAUDE)\.md$/,
    /^\/tsconfig\.json$/,
  ],
  download: { cacheRoot: ".local/electron-cache" },
});
for (const output of outputs) console.log(output);

if (platform === "win32") {
  const { build, Platform } = await import("electron-builder");
  await build({
    targets: Platform.WINDOWS.createTarget("portable"),
    prepackaged: outputs[0],
    publish: "never",
    config: {
      appId: "io.github.oniums.baudloom",
      productName: "Baudloom",
      electronVersion: pkg.devDependencies.electron,
      directories: { output: "artifacts" },
      win: { signAndEditExecutable: false, icon: "assets/brand/baudloom.ico" },
      portable: {
        artifactName: "Baudloom.exe",
        requestExecutionLevel: "user",
        // Direct zlib extraction avoids the intermediate 7z extraction/copy pass.
        useZip: true,
        unpackDirName: false,
      },
      compression: "normal",
    },
  });
}
