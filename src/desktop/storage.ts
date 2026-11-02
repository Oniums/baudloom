import { dirname, join } from "node:path";
import { mkdirSync, accessSync, constants } from "node:fs";
export function storagePaths(options: {
  override?: string;
  portableDir?: string;
  packaged: boolean;
  executable: string;
  project: string;
}) {
  const base =
    options.portableDir ||
    (options.packaged ? dirname(options.executable) : options.project);
  const root = options.override || join(base, "Baudloom-data");
  return {
    root,
    profile: join(root, "profile"),
    cache: join(root, "cache"),
    logs: join(root, "logs"),
    crashes: join(root, "crashes"),
    sessions: join(root, "sessions"),
  };
}
export function prepareStorage(paths: ReturnType<typeof storagePaths>) {
  // Do not silently fall back to AppData: the portable location is a user-visible contract.
  for (const path of [paths.profile, paths.cache, paths.logs, paths.crashes]) {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
  }
}
