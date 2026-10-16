import type { api } from "@managealltv/protocol";
import { CloudDownload } from "lucide-react";
import { deviceSync } from "../../lib/devices";
import { formatRelative } from "../../lib/format";
import { cx } from "../ui/cx";
import { Badge, ProgressBar } from "../ui/feedback";

export function OnlineIndicator({ device, now }: { device: Pick<api.Device, "online" | "lastSeenAt">; now: Date }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span
        aria-hidden
        className={cx("size-2 shrink-0 rounded-full", device.online ? "on-air-dot bg-ok text-ok" : "bg-ink-3/60")}
      />
      <span className={device.online ? "font-medium text-ok" : "text-ink-2"}>
        {device.online ? "Çevrimiçi" : "Çevrimdışı"}
      </span>
      {!device.online && <span className="text-ink-3">{formatRelative(device.lastSeenAt, now)}</span>}
    </span>
  );
}

/** Sync badge and, while downloading, a progress bar with file and byte counts. */
export function SyncStatus({ device, detailed = false }: { device: Pick<api.Device, "status" | "manifestVersion">; detailed?: boolean }) {
  const sync = deviceSync(device);
  switch (sync.kind) {
    case "never":
      return <Badge>{sync.label}</Badge>;
    case "synced":
      return <Badge tone="ok">{sync.label}</Badge>;
    case "outdated":
      return (
        <span className="flex flex-col gap-1">
          <Badge tone="warn" className="self-start">
            {sync.label}
          </Badge>
          {detailed && <span className="text-sm text-ink-2">{sync.detail}</span>}
        </span>
      );
    case "error":
      return (
        <span className="flex flex-col gap-1">
          <Badge tone="bad" className="self-start">
            {sync.label}
          </Badge>
          {detailed && <span className="text-sm break-words text-bad">{sync.detail}</span>}
        </span>
      );
    case "downloading":
      return (
        <span className="flex min-w-32 flex-col gap-1">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-accent">
            <CloudDownload size={14} aria-hidden />
            {sync.label}
          </span>
          <ProgressBar value={sync.fraction} label="İndirme ilerlemesi" />
          {detailed && <span className="text-sm text-ink-2">{sync.detail}</span>}
        </span>
      );
  }
}
