import type { LogRow } from "./shared";
export function rowInterval(first: LogRow, second: LogRow): string {
  if (
    first.mono &&
    second.mono &&
    /^\d{1,30}$/.test(first.mono) &&
    /^\d{1,30}$/.test(second.mono)
  ) {
    return `${(Number(BigInt(second.mono) - BigInt(first.mono)) / 1e6).toFixed(3)} ms · 主机单调时钟`;
  }
  if (
    !first.at ||
    !second.at ||
    !Number.isFinite(Date.parse(first.at)) ||
    !Number.isFinite(Date.parse(second.at))
  )
    return "这两条记录没有可用时间，无法计算间隔";
  return `${Date.parse(second.at) - Date.parse(first.at)} ms · 系统时间，可能受校时影响`;
}
