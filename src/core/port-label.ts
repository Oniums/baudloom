/** Windows bindings expose SPDRP_FRIENDLYNAME beyond the common PortInfo type. */
export function portLabel(port: {
  path: string;
  friendlyName?: unknown;
  manufacturer?: string;
  serialNumber?: string;
}): string {
  const name =
    typeof port.friendlyName === "string" ? port.friendlyName.trim() : "";
  if (name) {
    const escaped = port.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[\\s(（])${escaped}(?:$|[\\s)）])`, "i").test(name)
      ? name
      : `${name} (${port.path})`;
  }
  const description = [port.manufacturer, port.serialNumber]
    .filter(Boolean)
    .join(" · ");
  return description ? `${description} (${port.path})` : port.path;
}
