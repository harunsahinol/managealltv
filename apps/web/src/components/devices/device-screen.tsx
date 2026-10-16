import type { api } from "@managealltv/protocol";
import { ImageOff, MonitorOff, WifiOff } from "lucide-react";
import { useState } from "react";
import { mediaThumbnailUrl } from "../../lib/api/media";
import { cx } from "../ui/cx";

/**
 * A miniature of the TV: dark bezel, 16:9 glass, and the thumbnail of what the TV says it is playing.
 * This is the one bold element of the panel; everything around it stays quiet.
 */
export function DeviceScreen({
  device,
  media,
  size = "md",
}: {
  device: Pick<api.Device, "online" | "status" | "name">;
  media: api.Media | undefined;
  size?: "md" | "lg";
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const currentId = device.status?.currentMediaId ?? null;
  const showThumb = media !== undefined && media.status === "ready" && broken !== media.id;

  let overlay: { icon: typeof WifiOff; text: string } | null = null;
  if (!device.online) overlay = { icon: WifiOff, text: "Çevrimdışı" };
  else if (device.status === null) overlay = { icon: MonitorOff, text: "Bilgi bekleniyor" };
  else if (currentId === null) overlay = { icon: MonitorOff, text: "Ekran boş" };
  else if (!showThumb) overlay = { icon: ImageOff, text: "Önizleme yok" };

  return (
    <div className={cx("rounded-[7px] bg-bezel p-[5px] ring-1 ring-bezel-edge", size === "lg" && "p-2")}>
      <div className="relative aspect-video overflow-hidden rounded-screen bg-screen-off">
        {showThumb && (
          <img
            src={mediaThumbnailUrl(media.id)}
            alt=""
            loading="lazy"
            onError={() => setBroken(media.id)}
            className={cx("absolute inset-0 h-full w-full object-cover", !device.online && "opacity-35 grayscale")}
          />
        )}
        {overlay !== null && (
          <div
            className={cx(
              "absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center text-[#9aa6b8]",
              // Keep the label readable over the dimmed last frame.
              showThumb && "bg-black/55 text-[#d5dbe4]",
            )}
          >
            <overlay.icon size={size === "lg" ? 28 : 20} aria-hidden />
            <span className={cx("font-medium", size === "lg" ? "text-base" : "text-sm")}>{overlay.text}</span>
          </div>
        )}
        {device.online && (
          <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-xs font-medium text-white">
            <span className="on-air-dot size-1.5 rounded-full bg-[#4cc38a] text-[#4cc38a]" aria-hidden />
            Yayında
          </span>
        )}
      </div>
    </div>
  );
}
