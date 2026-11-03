export interface SerialSettings {
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: "none" | "even" | "odd" | "mark" | "space";
  flow: "none" | "rtscts" | "xonxoff";
  dtr: boolean;
  rts: boolean;
}
export const DEFAULT_SERIAL: SerialSettings = {
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flow: "none",
  dtr: true,
  rts: true,
};
export function serialSettings(
  value: unknown = DEFAULT_SERIAL,
): SerialSettings {
  const v = value as SerialSettings;
  if (
    !v ||
    ![5, 6, 7, 8].includes(v.dataBits) ||
    ![1, 1.5, 2].includes(v.stopBits) ||
    !["none", "even", "odd", "mark", "space"].includes(v.parity) ||
    !["none", "rtscts", "xonxoff"].includes(v.flow) ||
    typeof v.dtr !== "boolean" ||
    typeof v.rts !== "boolean"
  )
    throw Error("无效串口参数");
  return {
    dataBits: v.dataBits,
    stopBits: v.stopBits,
    parity: v.parity,
    flow: v.flow,
    dtr: v.dtr,
    rts: v.rts,
  };
}
export function serialSummary(v: SerialSettings) {
  return `${v.dataBits}${{ none: "N", even: "E", odd: "O", mark: "M", space: "S" }[v.parity]}${v.stopBits}${v.flow === "none" ? "" : " · " + (v.flow === "rtscts" ? "RTS/CTS" : "XON/XOFF")}`;
}
export function serialError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (
    /access denied|permission denied|resource busy|cannot lock|access is denied|EBUSY|EACCES/i.test(
      detail,
    )
  )
    return Error(
      `串口可能被其他程序占用，或没有访问权限。请关闭占用程序并检查权限。原始错误：${detail}`,
    );
  if (
    /no such file|not found|disconnected|device not connected|ENOENT/i.test(
      detail,
    )
  )
    return Error(
      `设备可能已拔出或端口已变化，请检查连接后手动重连。原始错误：${detail}`,
    );
  return error instanceof Error ? error : Error(detail);
}
