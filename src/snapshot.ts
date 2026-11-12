import type { Snapshot } from "./shared";

/** A partial trailing line is replaced, not appended a second time. */
export function mergeSnapshot(
  previous: Snapshot | null,
  next: Snapshot,
): Snapshot {
  const update = next.viewUpdate;
  if (!update || update.reset || !previous) return next;
  if (
    previous.sessionId !== next.sessionId ||
    previous.viewUpdate?.cursor.mode !== update.cursor.mode
  )
    throw Error("日志视图已变化，请重新获取缓存");
  if (
    !next.rows.length &&
    previous.viewUpdate.cursor.revision === update.cursor.revision
  )
    return { ...next, rows: previous.rows };
  const replaceFrom = next.rows[0]?.id ?? Infinity;
  // The retained rows in a snapshot are contiguous within each display mode.
  const first = previous.rows[0]?.id ?? update.firstId;
  const rows = previous.rows
    .slice(
      Math.max(0, update.firstId - first),
      Math.max(0, replaceFrom - first),
    )
    .concat(next.rows);
  if (rows.length !== update.count)
    throw Error("日志缓存不同步，请重新获取缓存");
  return { ...next, rows };
}
