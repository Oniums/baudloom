import type { ClearBoundary, LogRow } from "./shared";

export function rowsAfterClear(
  rows: LogRow[],
  boundary: ClearBoundary,
): LogRow[] {
  if (!boundary.afterRowId && !boundary.partial) return rows;
  const visible: LogRow[] = [];
  for (const row of rows) {
    if (row.id <= boundary.afterRowId) continue;
    if (boundary.partial && row.rxLine === boundary.partial.line) {
      const text = row.text.slice(boundary.partial.chars);
      if (text) visible.push({ ...row, text });
    } else visible.push(row);
  }
  return visible;
}
