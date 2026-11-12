import { open, rename, rm } from "node:fs/promises";
import { dirname, basename, join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExportRequest, ExportResult, LogRow } from "../shared";
import { compileSearch } from "../log-search";
import { scanSession, type SessionPart } from "./journal";
import { rowsAfterClear } from "../clear-boundary";
import { View } from "./view";

export function validateExport(request: ExportRequest) {
  if (
    !request ||
    !["cache", "filtered", "selection", "session"].includes(request.scope) ||
    !["text", "hex"].includes(request.mode) ||
    typeof request.sessionId !== "string" ||
    !Number.isSafeInteger(request.afterRowId) ||
    request.afterRowId < 0 ||
    (request.partial !== undefined &&
      (!request.partial ||
        !Number.isSafeInteger(request.partial.line) ||
        request.partial.line < 1 ||
        !Number.isSafeInteger(request.partial.chars) ||
        request.partial.chars < 1)) ||
    typeof request.query !== "string" ||
    request.query.length > 512 ||
    typeof request.exclude !== "string" ||
    request.exclude.length > 512 ||
    [
      request.timestamps,
      request.direction,
      request.caseSensitive,
      request.onlyMatches,
    ].some((v) => typeof v !== "boolean") ||
    (request.scope === "selection" &&
      (typeof request.selection !== "string" ||
        !request.selection ||
        request.selection.length > 16 * 1048576))
  )
    throw Error("无效导出参数");
}

export async function exportText(
  file: string,
  request: ExportRequest,
  source: { rows?: LogRow[]; parts?: SessionPart[]; live?: boolean },
  signal?: AbortSignal,
): Promise<ExportResult> {
  validateExport(request);
  if (![".txt", ".log"].includes(extname(file).toLowerCase()))
    throw Error("导出文件请使用 .txt 或 .log 扩展名");
  const temporary = join(
    dirname(file),
    `.${basename(file)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  let rows = 0,
    bytes = 0;
  const write = async (text: string) => {
    signal?.throwIfAborted();
    await handle.writeFile(text, "utf8");
    bytes += Buffer.byteLength(text);
  };
  const writeRows = async (items: LogRow[]) => {
    if (!items.length) return;
    await write(
      items
        .map(
          (row) =>
            [
              ...(request.timestamps ? [row.at] : []),
              ...(request.direction ? [row.dir] : []),
              row.text,
            ].join("\t") + "\n",
        )
        .join(""),
    );
    rows += items.length;
  };
  try {
    if (request.scope === "selection") {
      await write(request.selection!);
      rows = request.selection!.split("\n").length;
    } else if (request.scope === "session") {
      if (!source.parts?.length) throw Error("本次会话尚未保存");
      // Flush bounded RX slices so a record containing thousands of newlines cannot evict output.
      const view = new View({ maxRows: 5000, maxChars: 1048576 });
      let last = 0;
      const flush = async () => {
        const snapshot = view.snapshot(request.mode, last + 1);
        const completed = request.mode === "hex" ? view.hexTotal : view.total;
        const items = snapshot.rows.filter((row) => row.id <= completed);
        if (items.length && items[0].id !== last + 1)
          throw Error("导出视图超出单条记录预算");
        await writeRows(items);
        last = completed;
      };
      const result = await scanSession(
        source.parts,
        async (event) => {
          if (event.kind === "rx") {
            const bytes = Buffer.from(event.data ?? "", "base64");
            for (let offset = 0; offset < bytes.length; offset += 2048) {
              view.apply({
                ...event,
                data: bytes.subarray(offset, offset + 2048).toString("base64"),
              });
              await flush();
            }
          } else {
            view.apply(event);
            await flush();
          }
        },
        { allowOpenEnd: source.live, signal },
      );
      if (result.warning)
        throw Error(`未导出：${result.warning}。可打开会话后导出已验证缓存。`);
      view.finish();
      await flush();
    } else {
      const filter = compileSearch(request);
      const cached = source.rows ?? [];
      const items =
        request.scope === "cache"
          ? cached
          : rowsAfterClear(cached, request).filter((row) =>
              filter.visible(row.text),
            );
      // Bound each filesystem write while allowing cancellation of a large cached export.
      for (let i = 0; i < items.length; i += 256)
        await writeRows(items.slice(i, i + 256));
    }
    signal?.throwIfAborted();
    await handle.sync();
    await handle.close();
    signal?.throwIfAborted();
    await rename(temporary, file);
    return {
      file,
      rows,
      bytes,
      warning:
        source.live && request.scope === "session"
          ? "仅导出开始时已写入的会话；后续接收不包含在此文件中。"
          : null,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
