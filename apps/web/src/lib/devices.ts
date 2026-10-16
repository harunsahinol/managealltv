import type { api, Command, CommandType } from "@managealltv/protocol";
import { formatBytes, formatPercent } from "./format";

/** The architecture asks for a visible warning once a TV has been offline this long. */
export const LONG_OFFLINE_MS = 10 * 60 * 1000;

export type SyncView =
  | { kind: "never"; label: string }
  | { kind: "synced"; label: string }
  | { kind: "downloading"; label: string; fraction: number; detail: string }
  | { kind: "error"; label: string; detail: string }
  | { kind: "outdated"; label: string; detail: string };

/**
 * How far the TV's content is from what the server wants, in one view. "outdated" covers the gap
 * between a change on the server and the device starting to download (or a device that is offline).
 */
export function deviceSync(device: Pick<api.Device, "status" | "manifestVersion">): SyncView {
  const status = device.status;
  if (status === null) return { kind: "never", label: "Henüz bilgi göndermedi" };
  if (status.syncState === "error") {
    return { kind: "error", label: "Senkron hatası", detail: status.lastError ?? "TV bir hata bildirdi." };
  }
  if (status.syncState === "downloading") {
    const fraction =
      status.syncBytesTotal > 0
        ? status.syncBytesDone / status.syncBytesTotal
        : status.syncFilesTotal > 0
          ? status.syncFilesDone / status.syncFilesTotal
          : 0;
    const files = `${status.syncFilesDone}/${status.syncFilesTotal} dosya`;
    const bytes =
      status.syncBytesTotal > 0 ? `, ${formatBytes(status.syncBytesDone)} / ${formatBytes(status.syncBytesTotal)}` : "";
    return { kind: "downloading", label: `İndiriliyor ${formatPercent(fraction)}`, fraction, detail: `${files}${bytes}` };
  }
  if (status.manifestVersion !== device.manifestVersion) {
    const onDevice = status.manifestVersion === null ? "henüz yok" : `sürüm ${status.manifestVersion}`;
    return {
      kind: "outdated",
      label: "Güncel değil",
      detail: `Sunucuda sürüm ${device.manifestVersion}, TV'de ${onDevice}. TV bağlandığında yeni içeriği indirecek.`,
    };
  }
  return { kind: "synced", label: "Güncel" };
}

/** Offline for longer than LONG_OFFLINE_MS (or never seen at all). */
export function isLongOffline(device: Pick<api.Device, "online" | "lastSeenAt" | "createdAt">, now: Date): boolean {
  if (device.online) return false;
  const reference = device.lastSeenAt ?? device.createdAt;
  return now.getTime() - new Date(reference).getTime() > LONG_OFFLINE_MS;
}

export const COMMAND_TYPE_LABELS: Record<CommandType, string> = {
  reload: "Yenile",
  restart_app: "Uygulamayı yeniden başlat",
  identify: "Tanımla",
  set_volume: "Ses",
  reboot: "Yeniden başlat",
};

export function describeCommand(command: Command): string {
  switch (command.type) {
    case "identify":
      return `Tanımla (${command.durationSec} sn)`;
    case "set_volume":
      return `Ses seviyesi ${command.volume}`;
    default:
      return COMMAND_TYPE_LABELS[command.type];
  }
}

/**
 * Confirmation after sending a command, from the status the server returned: "pending" means it
 * was not delivered (no WebSocket) and waits for the TV to connect. A TV can still count as online
 * then, because the HTTP status fallback keeps lastSeenAt fresh while the socket is down.
 */
export function commandSentMessage(view: Pick<api.CommandView, "command" | "status">): string {
  const name = describeCommand(view.command);
  return view.status === "pending"
    ? `${name} komutu sıraya alındı; TV bağlandığında iletilecek.`
    : `${name} komutu gönderildi.`;
}

export const COMMAND_STATUS_LABELS: Record<api.CommandStatus, string> = {
  pending: "Bekliyor",
  sent: "Gönderildi",
  succeeded: "Başarılı",
  failed: "Başarısız",
  expired: "Zaman aşımı",
};

export const COMMAND_STATUS_TONE: Record<api.CommandStatus, "neutral" | "info" | "ok" | "bad" | "warn"> = {
  pending: "neutral",
  sent: "info",
  succeeded: "ok",
  failed: "bad",
  expired: "warn",
};
