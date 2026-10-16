import type { api } from "@managealltv/protocol";
import { Eye, Film, Image as ImageIcon, Images, Pencil, Search, Trash, Upload } from "lucide-react";
import { type DragEvent, type FormEvent, useId, useMemo, useRef, useState } from "react";
import { useCurrentUser } from "../../app/session";
import { MediaThumb, MediaTypeIcon } from "../../components/media/media-thumb";
import { Button, IconButton } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { cx } from "../../components/ui/cx";
import { Dialog } from "../../components/ui/dialog";
import { Alert, Badge, EmptyState, ErrorState, LoadingState, StaleDataNotice } from "../../components/ui/feedback";
import { Field, FormError, Input } from "../../components/ui/form";
import { PageHeader } from "../../components/ui/page";
import { Segmented } from "../../components/ui/segmented";
import { useToast } from "../../components/ui/toast";
import { errorMessage } from "../../lib/api/errors";
import { mediaFileUrl, useDeleteMedia, useMediaList, useRenameMedia } from "../../lib/api/media";
import { formatBytes, formatClockMs, formatDateTime } from "../../lib/format";
import { canDeleteMedia, canEditContent } from "../../lib/permissions";
import { isAcceptedMediaFile } from "../../lib/upload";
import { UploadPanel } from "./upload-panel";
import { useUploads } from "./upload-store";

type TypeFilter = "all" | "image" | "video";

function StatusBadge({ media }: { media: api.Media }) {
  if (media.status === "processing") return <Badge tone="info">İşleniyor</Badge>;
  if (media.status === "failed") return <Badge tone="bad">Hata</Badge>;
  return null;
}

function mediaFacts(media: api.Media) {
  const usage = media.playlistCount === 0 ? "Hiçbir listede değil" : `${media.playlistCount} listede`;
  return [
    { label: "Tür", value: media.type === "video" ? "Video" : "Resim" },
    { label: "Boyut", value: formatBytes(media.size) },
    {
      label: "Çözünürlük",
      value: media.width !== null && media.height !== null ? `${media.width} × ${media.height}` : "—",
    },
    ...(media.type === "video" ? [{ label: "Süre", value: formatClockMs(media.durationMs) }] : []),
    { label: "Kullanım", value: usage },
    { label: "Yükleyen", value: media.uploadedByName ?? "—" },
    { label: "Yüklenme", value: formatDateTime(media.createdAt) },
  ];
}

function PreviewDialog({ media, onClose }: { media: api.Media | null; onClose: () => void }) {
  return (
    <Dialog open={media !== null} onClose={onClose} title={media?.name ?? ""} size="xl">
      {media !== null && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_240px]">
          <div className="overflow-hidden rounded-[6px] bg-bezel">
            {media.type === "video" ? (
              <video
                src={mediaFileUrl(media.id)}
                controls
                autoPlay
                playsInline
                preload="metadata"
                className="aspect-video w-full bg-black"
              >
                Tarayıcınız bu videoyu oynatamıyor.
              </video>
            ) : (
              <img src={mediaFileUrl(media.id)} alt={media.name} className="max-h-[70dvh] w-full object-contain" />
            )}
          </div>
          <dl className="flex flex-col gap-3 text-base">
            {mediaFacts(media).map((fact) => (
              <div key={fact.label}>
                <dt className="text-sm text-ink-3">{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Dialog>
  );
}

function RenameDialog({ media, onClose }: { media: api.Media | null; onClose: () => void }) {
  const formId = useId();
  const rename = useRenameMedia();
  const toast = useToast();
  const [name, setName] = useState(media?.name ?? "");
  const trimmed = name.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (media === null || trimmed === "") return;
    rename.mutate(
      { id: media.id, name: trimmed },
      {
        onSuccess: () => {
          toast.success("Ad değiştirildi.");
          onClose();
        },
      },
    );
  };
  const close = onClose;
  return (
    <Dialog
      open={media !== null}
      onClose={close}
      title="Medyayı yeniden adlandır"
      size="sm"
      dismissible={!rename.isPending}
      footer={
        <>
          <Button onClick={close} disabled={rename.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" form={formId} variant="primary" pending={rename.isPending} disabled={trimmed === ""}>
            Adı kaydet
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Ad" hint="Yalnız panelde görünür; TV'de gösterilmez.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              autoFocus
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-describedby={describedBy}
            />
          )}
        </Field>
        <FormError message={rename.isError ? errorMessage(rename.error) : null} />
      </form>
    </Dialog>
  );
}

function MediaCard({
  media,
  canEdit,
  canDelete,
  onPreview,
  onRename,
  onDelete,
}: {
  media: api.Media;
  canEdit: boolean;
  canDelete: boolean;
  onPreview: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const ready = media.status === "ready";
  return (
    <li className="panel flex flex-col overflow-hidden">
      <button
        type="button"
        onClick={onPreview}
        disabled={!ready}
        aria-label={`${media.name} önizle`}
        className="group relative block p-2 pb-0 text-left disabled:cursor-default"
      >
        <MediaThumb media={media} className={cx(ready && "transition-opacity group-hover:opacity-90")} />
        <span className="absolute top-3.5 left-3.5">
          <StatusBadge media={media} />
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 pt-2 pb-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <MediaTypeIcon type={media.type} />
          <p className="truncate text-base font-medium" title={media.name}>
            {media.name}
          </p>
        </div>
        {media.status === "failed" ? (
          <p className="line-clamp-2 text-sm text-bad" title={media.error ?? undefined}>
            {media.error ?? "Dosya işlenemedi."}
          </p>
        ) : (
          <p className="truncate text-sm text-ink-3">
            {media.status === "processing"
              ? "TV'ler için hazırlanıyor"
              : [
                  formatBytes(media.size),
                  media.width !== null && media.height !== null ? `${media.width}×${media.height}` : null,
                  media.playlistCount > 0 ? `${media.playlistCount} listede` : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
          </p>
        )}
        <div className="mt-auto flex items-center gap-0.5 pt-1">
          <IconButton size="sm" icon={Eye} label="Önizle" onClick={onPreview} disabled={!ready} />
          {canEdit && <IconButton size="sm" icon={Pencil} label="Yeniden adlandır" onClick={onRename} />}
          {canDelete && <IconButton size="sm" icon={Trash} label="Sil" variant="danger-ghost" onClick={onDelete} />}
        </div>
      </div>
    </li>
  );
}

export function MediaPage() {
  const me = useCurrentUser();
  const mediaList = useMediaList();
  const uploads = useUploads();
  const remove = useDeleteMedia();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<api.Media | null>(null);
  const [renaming, setRenaming] = useState<api.Media | null>(null);
  const [deleting, setDeleting] = useState<api.Media | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [rejected, setRejected] = useState<string[]>([]);
  const canUpload = canEditContent(me);

  const all = useMemo(() => mediaList.data ?? [], [mediaList.data]);
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("tr");
    return all.filter((m) => (filter === "all" || m.type === filter) && (q === "" || m.name.toLocaleLowerCase("tr").includes(q)));
  }, [all, filter, query]);

  const addFiles = (files: readonly File[]) => {
    const accepted = files.filter(isAcceptedMediaFile);
    setRejected(files.filter((file) => !isAcceptedMediaFile(file)).map((file) => file.name));
    if (accepted.length > 0) uploads.add(accepted);
  };

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  const dropHandlers = canUpload
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragDepth((depth) => depth + 1);
        },
        onDragOver: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          setDragDepth((depth) => Math.max(0, depth - 1));
        },
        onDrop: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragDepth(0);
          addFiles(Array.from(event.dataTransfer.files));
        },
      }
    : {};

  const confirmDelete = () => {
    if (deleting === null) return;
    const target = deleting;
    remove.mutate(target.id, {
      onSuccess: () => {
        toast.success(`"${target.name}" silindi.`);
        setDeleting(null);
      },
    });
  };

  const counts = {
    image: all.filter((m) => m.type === "image").length,
    video: all.filter((m) => m.type === "video").length,
  };

  return (
    <div {...dropHandlers} className="relative min-h-[60dvh]">
      <PageHeader
        title="Medya"
        description="TV'lerde gösterilecek resim ve videolar. Yüklenen dosyalar TV'ler için otomatik olarak dönüştürülür; videoların sesi eşitlenir."
        actions={
          canUpload ? (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden"
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <Button variant="primary" icon={Upload} onClick={() => fileInput.current?.click()}>
                Dosya yükle
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-4">
        <UploadPanel />
        <StaleDataNotice show={mediaList.isError && mediaList.data !== undefined} error={mediaList.error} />
        {rejected.length > 0 && (
          <Alert
            tone="warn"
            title="Bazı dosyalar eklenmedi"
            action={
              <Button size="sm" variant="ghost" onClick={() => setRejected([])}>
                Kapat
              </Button>
            }
          >
            Yalnız resim ve video yüklenebilir: {rejected.join(", ")}
          </Alert>
        )}

        {mediaList.isPending ? (
          <LoadingState />
        ) : mediaList.isError && mediaList.data === undefined ? (
          <ErrorState error={mediaList.error} onRetry={() => void mediaList.refetch()} />
        ) : all.length === 0 ? (
          <EmptyState
            icon={Images}
            title="Kitaplık boş"
            action={
              canUpload ? (
                <Button variant="primary" icon={Upload} onClick={() => fileInput.current?.click()}>
                  Dosya yükle
                </Button>
              ) : undefined
            }
          >
            {canUpload
              ? "Resim ve videoları bu sayfaya sürükleyip bırakın ya da dosya seçin. Büyük videolar parça parça yüklenir; bağlantı koparsa kaldığı yerden devam eder."
              : "Henüz yüklenmiş içerik yok."}
          </EmptyState>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-64">
                <Search size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" aria-hidden />
                <Input
                  type="search"
                  placeholder="Ada göre ara"
                  aria-label="Medyayı ada göre ara"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="pl-8"
                />
              </div>
              <Segmented<TypeFilter>
                label="Türe göre filtrele"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: `Tümü (${all.length})` },
                  { value: "image", label: `Resim (${counts.image})`, icon: ImageIcon },
                  { value: "video", label: `Video (${counts.video})`, icon: Film },
                ]}
              />
              {canUpload && (
                <p className="ml-auto hidden text-sm text-ink-3 lg:block">Dosyaları bu sayfaya sürükleyip bırakabilirsiniz.</p>
              )}
            </div>
            {visible.length === 0 ? (
              <EmptyState icon={Search} title="Eşleşen medya yok">
                Aramayı ya da tür filtresini değiştirin.
              </EmptyState>
            ) : (
              <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {visible.map((media) => (
                  <MediaCard
                    key={media.id}
                    media={media}
                    canEdit={canUpload}
                    canDelete={canDeleteMedia(me, media)}
                    onPreview={() => setPreview(media)}
                    onRename={() => setRenaming(media)}
                    onDelete={() => {
                      remove.reset();
                      setDeleting(media);
                    }}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {dragDepth > 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-panel border-2 border-dashed border-accent bg-accent-soft/85"
        >
          <p className="flex items-center gap-2 text-lg font-semibold text-accent">
            <Upload size={20} />
            Bırakın, yüklemeye başlasın
          </p>
        </div>
      )}

      <PreviewDialog media={preview} onClose={() => setPreview(null)} />
      {/* Keyed so the form starts from the chosen item's name every time it opens. */}
      <RenameDialog key={renaming?.id ?? "closed"} media={renaming} onClose={() => setRenaming(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Medya silinsin mi?"
        confirmLabel="Sil"
        pending={remove.isPending}
        error={remove.isError ? remove.error : null}
        onConfirm={confirmDelete}
      >
        {deleting !== null && (
          <>
            <p>“{deleting.name}” kalıcı olarak silinir.</p>
            {deleting.playlistCount > 0 && (
              <p className="text-warn">
                Bu medya {deleting.playlistCount} oynatma listesinde kullanılıyor. Silmeden önce listelerden çıkarmanız gerekir.
              </p>
            )}
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

