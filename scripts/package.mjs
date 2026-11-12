import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const platform = process.argv[2];
if (!["linux", "win32"].includes(platform))
  throw Error("Expected linux or win32");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const artifacts = resolve("artifacts");
await mkdir(artifacts, { recursive: true });
// Build the Windows archive in an empty directory; never repack an installed copy or its data.
const staging =
  platform === "win32"
    ? await mkdtemp(join(artifacts, ".package-"))
    : undefined;
try {
  const outputs = await packager({
    dir: ".",
    name: "Baudloom",
    executableName: "Baudloom",
    appVersion: pkg.version,
    icon: "assets/brand/baudloom",
    electronVersion: pkg.devDependencies.electron,
    platform,
    arch: "x64",
    out: staging ?? artifacts,
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
  if (staging) {
    const archive = "Baudloom-Windows-x64.zip";
    const folder = basename(outputs[0]);
    if (process.platform === "win32") {
      execFileSync("tar.exe", ["-a", "-cf", archive, folder], { cwd: staging });
    } else {
      execFileSync("zip", ["-qr", archive, folder], { cwd: staging });
    }
    await rename(join(staging, archive), join(artifacts, archive));
    console.log(join(artifacts, archive));
  } else {
    for (const output of outputs) console.log(output);
  }
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
}
