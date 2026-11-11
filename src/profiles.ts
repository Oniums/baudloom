import { parseBaudRate } from "./baud-rate";
import { serialSettings, type SerialSettings } from "./serial-settings";
import {
  MAX_COMMAND_SLOTS,
  restoreSendTools,
  isCommandDraft,
  checksumSettings,
  type CommandDraft,
  type CommandSlot,
} from "./send-tools";
export interface DeviceProfile {
  name: string;
  baudRate: number;
  serial: SerialSettings;
  draft: CommandDraft;
  commands: CommandSlot[];
  clearAfterSend: boolean;
  singleInterval: number;
  multiInterval: number;
}
export function validateProfile(input: DeviceProfile): DeviceProfile {
  if (
    !input ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 60 ||
    !isCommandDraft(input.draft) ||
    !Array.isArray(input.commands) ||
    input.commands.length < 1 ||
    input.commands.length > MAX_COMMAND_SLOTS ||
    input.commands.some(
      (c) =>
        !isCommandDraft(c) ||
        c.text.length > 8192 ||
        typeof c.name !== "string" ||
        c.name.length > 60,
    ) ||
    ![input.singleInterval, input.multiInterval].every(
      (n) => Number.isInteger(n) && n >= 100 && n <= 3600000,
    ) ||
    typeof input.clearAfterSend !== "boolean"
  )
    throw Error("配置无效：请检查名称、命令和定时间隔");
  const commands = restoreSendTools(
    JSON.stringify({ version: 1, commands: input.commands }),
  ).commands;
  return {
    name: input.name.trim(),
    baudRate: parseBaudRate(String(input.baudRate)),
    serial: serialSettings(input.serial),
    draft: {
      text: input.draft.text,
      format: input.draft.format,
      ending: input.draft.ending,
      ...checksumSettings(input.draft),
    },
    commands,
    clearAfterSend: input.clearAfterSend,
    singleInterval: input.singleInterval,
    multiInterval: input.multiInterval,
  };
}
export const MAX_PROFILE_STORAGE = 4 * 1024 * 1024;
export function readProfiles(raw: string | null): DeviceProfile[] {
  if (!raw) return [];
  if (raw.length > MAX_PROFILE_STORAGE) throw Error("配置文件过大");
  const input = JSON.parse(raw);
  if (
    input?.version !== 1 ||
    !Array.isArray(input.profiles) ||
    input.profiles.length > 20
  )
    throw Error("配置数据无效");
  return input.profiles.map(validateProfile);
}
