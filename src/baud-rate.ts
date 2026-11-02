export const BAUD_RATES = [
  50, 75, 110, 134, 150, 200, 300, 600, 1200, 1800, 2400, 4800, 7200, 9600,
  14400, 19200, 28800, 38400, 56000, 57600, 76800, 115200, 128000, 153600,
  230400, 256000, 460800, 500000, 576000, 921600, 1000000, 1500000, 2000000,
  2500000, 3000000, 4000000,
] as const;

export function validBaudRate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 50 &&
    value <= 4000000
  );
}

export function parseBaudRate(text: string): number {
  const value = text.trim();
  if (!/^\d+$/.test(value) || !validBaudRate(Number(value)))
    throw Error(
      "波特率请输入 50–4000000 之间的整数，实际支持范围由设备和驱动决定",
    );
  return Number(value);
}
