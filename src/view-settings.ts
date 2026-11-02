export interface ViewLimits {
  maxRows: number;
  maxChars: number;
}
export const DEFAULT_VIEW_LIMITS: ViewLimits = {
  maxRows: 10000,
  maxChars: 4 * 1024 * 1024,
};
export function validateViewLimits(value: ViewLimits): ViewLimits {
  if (
    !value ||
    !Number.isInteger(value.maxRows) ||
    value.maxRows < 1000 ||
    value.maxRows > 50000 ||
    !Number.isInteger(value.maxChars) ||
    value.maxChars < 1024 * 1024 ||
    value.maxChars > 16 * 1024 * 1024
  )
    throw Error("缓存需为 1000–50000 行、1–16 Mi 字符");
  return { maxRows: value.maxRows, maxChars: value.maxChars };
}
// Capacity planning only: dual views, raw events, IPC copies, renderer and row metadata.
export function estimateViewMemory(limits: ViewLimits) {
  return {
    low: Math.ceil((limits.maxChars * 6 + limits.maxRows * 256) / 1048576),
    high: Math.ceil((limits.maxChars * 16 + limits.maxRows * 1024) / 1048576),
  };
}
