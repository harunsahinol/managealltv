import type { api } from "@managealltv/protocol";
import { Film, Image as ImageIcon, LoaderCircle, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { mediaThumbnailUrl } from "../../lib/api/media";
import { formatClockMs } from "../../lib/format";
import { cx } from "../ui/cx";

/** 16:9 thumbnail with processing / failed states and a length chip for videos. */
export function MediaThumb({ media, className, showLength = true }: { media: api.Media; className?: string; showLength?: boolean }) {
  const [broken, setBroken] = useState(false);
  const TypeIcon = media.type === "video" ? Film : ImageIcon;
  return (
    <div className={cx("relative aspect-video overflow-hidden rounded-[6px] bg-surface-3", className)}>
      {media.status === "ready" && !broken ? (
        <img
          src={mediaThumbnailUrl(media.id)}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-ink-3">
          {media.status === "processing" ? (
            <LoaderCircle size={20} className="animate-spin" aria-hidden />
          ) : media.status === "failed" ? (
            <TriangleAlert size={20} className="text-bad" aria-hidden />
          ) : (
            <TypeIcon size={20} aria-hidden />
          )}
        </div>
      )}
      {showLength && media.type === "video" && media.durationMs !== null && (
        <span className="absolute right-1.5 bottom-1.5 rounded-[4px] bg-black/65 px-1.5 py-px text-xs font-medium text-white tabular-nums">
          {formatClockMs(media.durationMs)}
        </span>
      )}
    </div>
  );
}

export function MediaTypeIcon({ type, size = 14 }: { type: api.Media["type"]; size?: number }) {
  return type === "video" ? (
    <Film size={size} className="shrink-0 text-ink-3" aria-label="Video" />
  ) : (
    <ImageIcon size={size} className="shrink-0 text-ink-3" aria-label="Resim" />
  );
}
