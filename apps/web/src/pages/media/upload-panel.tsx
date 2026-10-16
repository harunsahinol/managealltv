import { CircleCheck, CircleX, Upload as UploadIcon, X } from "lucide-react";
import { Button, IconButton } from "../../components/ui/button";
import { ProgressBar } from "../../components/ui/feedback";
import { formatBytes, formatPercent } from "../../lib/format";
import { type UploadEntry, useUploads } from "./upload-store";

function UploadRow({ entry, onCancel, onDismiss }: { entry: UploadEntry; onCancel: () => void; onDismiss: () => void }) {
  const fraction = entry.size > 0 ? entry.bytesUploaded / entry.size : 0;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-base font-medium" title={entry.fileName}>
            {entry.fileName}
          </p>
          <p className="shrink-0 text-sm text-ink-2 tabular-nums">
            {entry.status === "uploading" && `${formatPercent(fraction)}, ${formatBytes(entry.bytesUploaded)} / ${formatBytes(entry.size)}`}
            {entry.status === "done" && (
              <span className="inline-flex items-center gap-1 text-ok">
                <CircleCheck size={14} aria-hidden />
                Yüklendi, işleniyor
              </span>
            )}
            {entry.status === "cancelled" && "İptal edildi"}
            {entry.status === "error" && (
              <span className="inline-flex items-center gap-1 text-bad">
                <CircleX size={14} aria-hidden />
                Yüklenemedi
              </span>
            )}
          </p>
        </div>
        {entry.status === "uploading" && (
          <div className="mt-1.5">
            <ProgressBar value={fraction} label={`${entry.fileName} yükleniyor`} />
          </div>
        )}
        {entry.status === "error" && entry.error !== null && <p className="mt-1 text-sm text-bad">{entry.error}</p>}
      </div>
      {entry.status === "uploading" ? (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          İptal et
        </Button>
      ) : (
        <IconButton size="sm" icon={X} label={`${entry.fileName} satırını kaldır`} onClick={onDismiss} />
      )}
    </li>
  );
}

/** Per-file progress for tus uploads; survives navigation because the store lives above the router. */
export function UploadPanel() {
  const uploads = useUploads();
  if (uploads.entries.length === 0) return null;
  const running = uploads.entries.filter((entry) => entry.status === "uploading").length;
  const finished = uploads.entries.length - running;
  return (
    <section aria-label="Yüklemeler" className="panel px-4 py-2">
      <header className="flex items-center justify-between gap-3 border-b border-line py-1.5">
        <h2 className="inline-flex items-center gap-2 text-base font-semibold">
          <UploadIcon size={15} aria-hidden />
          {running > 0 ? `${running} dosya yükleniyor` : "Yüklemeler"}
        </h2>
        {finished > 0 && (
          <Button size="sm" variant="ghost" onClick={uploads.clearFinished}>
            Bitenleri temizle
          </Button>
        )}
      </header>
      <ul className="divide-y divide-line">
        {uploads.entries.map((entry) => (
          <UploadRow
            key={entry.id}
            entry={entry}
            onCancel={() => uploads.cancel(entry.id)}
            onDismiss={() => uploads.dismiss(entry.id)}
          />
        ))}
      </ul>
      {running > 0 && (
        <p className="border-t border-line py-2 text-xs text-ink-3">
          Yükleme sürerken paneldeki diğer sayfalara geçebilirsiniz; bu sekmeyi kapatmayın.
        </p>
      )}
    </section>
  );
}
