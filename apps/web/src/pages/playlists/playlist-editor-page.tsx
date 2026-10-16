import type { api } from "@managealltv/protocol";
import { ArrowLeft, ChevronDown, ChevronUp, Film, Image as ImageIcon, ListPlus, ListVideo, Pencil, Save, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useParams } from "react-router";
import { useCurrentUser } from "../../app/session";
import { MediaThumb, MediaTypeIcon } from "../../components/media/media-thumb";
import { Button, IconButton } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { cx } from "../../components/ui/cx";
import { Dialog } from "../../components/ui/dialog";
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from "../../components/ui/feedback";
import { FormError, Input } from "../../components/ui/form";
import { PageHeader } from "../../components/ui/page";
import { Segmented } from "../../components/ui/segmented";
import { useToast } from "../../components/ui/toast";
import { errorMessage, isApiError } from "../../lib/api/errors";
import { useMediaList } from "../../lib/api/media";
import { usePlaylist, useSavePlaylistItems } from "../../lib/api/playlists";
import { formatClockMs, formatDuration } from "../../lib/format";
import { canEditContent } from "../../lib/permissions";
import {
  DEFAULT_IMAGE_DURATION_SEC,
  type DraftItem,
  draftTotalSeconds,
  isDraftDirty,
  moveItem,
  parseDurationInput,
  toItemsInput,
} from "../../lib/playlists";
import { PlaylistNameDialog } from "./playlists-page";

const MAX_ITEMS = 500;

/** Editor row: the duration is kept as typed so half-typed values do not jump around. */
interface EditorItem {
  key: string;
  media: api.Media;
  durationText: string;
}

let keySeed = 0;
const newKey = () => `item-${++keySeed}`;

function fromDetail(detail: api.PlaylistDetail): EditorItem[] {
  return detail.items.map((item) => ({
    key: newKey(),
    media: item.media,
    durationText: item.media.type === "image" && item.durationSec !== null ? String(item.durationSec) : "",
  }));
}

function toDraft(items: readonly EditorItem[]): { draft: DraftItem[]; invalid: Set<string> } {
  const invalid = new Set<string>();
  const draft = items.map((item) => {
    const parsed = parseDurationInput(item.durationText);
    if (!parsed.ok) invalid.add(item.key);
    return { key: item.key, media: item.media, durationSec: parsed.ok ? parsed.value : null };
  });
  return { draft, invalid };
}

function BackLink() {
  return (
    <Link to="/playlists" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-accent">
      <ArrowLeft size={14} aria-hidden />
      Oynatma listeleri
    </Link>
  );
}

type PickerFilter = "all" | "image" | "video";

function MediaPicker({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (media: api.Media[]) => void }) {
  const mediaList = useMediaList();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PickerFilter>("all");

  const ready = useMemo(() => (mediaList.data ?? []).filter((m) => m.status === "ready"), [mediaList.data]);
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("tr");
    return ready.filter((m) => (filter === "all" || m.type === filter) && (q === "" || m.name.toLocaleLowerCase("tr").includes(q)));
  }, [ready, query, filter]);

  const toggle = (id: string) =>
    setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const close = () => {
    setSelected([]);
    setQuery("");
    onClose();
  };

  const add = () => {
    // Keep the order in which items were picked: that is the order people expect them to play.
    const byId = new Map(ready.map((m) => [m.id, m]));
    onAdd(selected.map((id) => byId.get(id)).filter((m): m is api.Media => m !== undefined));
    close();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Listeye medya ekle"
      description="Yalnız işlenmesi bitmiş medya eklenebilir. Seçtiğiniz sırayla listenin sonuna eklenir."
      size="xl"
      footer={
        <>
          <span className="mr-auto text-sm text-ink-2">{selected.length > 0 ? `${selected.length} öğe seçildi` : "Öğe seçin"}</span>
          <Button onClick={close}>Vazgeç</Button>
          <Button variant="primary" icon={ListPlus} disabled={selected.length === 0} onClick={add}>
            {selected.length > 0 ? `${selected.length} öğeyi ekle` : "Ekle"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
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
              autoFocus
            />
          </div>
          <Segmented<PickerFilter>
            label="Türe göre filtrele"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "Tümü" },
              { value: "image", label: "Resim", icon: ImageIcon },
              { value: "video", label: "Video", icon: Film },
            ]}
          />
        </div>
        {mediaList.isPending ? (
          <LoadingState className="py-10" />
        ) : mediaList.isError && mediaList.data === undefined ? (
          <ErrorState error={mediaList.error} onRetry={() => void mediaList.refetch()} />
        ) : ready.length === 0 ? (
          <p className="py-8 text-center text-base text-ink-2">
            Kitaplıkta hazır medya yok.{" "}
            <Link to="/media" className="font-medium text-accent hover:underline">
              Medya sayfasından yükleyin
            </Link>
            .
          </p>
        ) : visible.length === 0 ? (
          <p className="py-8 text-center text-base text-ink-2">Eşleşen medya yok.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {visible.map((media) => {
              const order = selected.indexOf(media.id);
              const isSelected = order >= 0;
              return (
                <li key={media.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => toggle(media.id)}
                    className={cx(
                      "relative flex w-full flex-col gap-1.5 rounded-panel border p-1.5 text-left transition-colors",
                      isSelected ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong",
                    )}
                  >
                    <MediaThumb media={media} />
                    <span className="flex min-w-0 items-center gap-1.5 px-0.5 pb-0.5">
                      <MediaTypeIcon type={media.type} />
                      <span className="truncate text-sm font-medium">{media.name}</span>
                    </span>
                    {isSelected && (
                      <span className="absolute top-3 right-3 grid size-6 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-ink">
                        {order + 1}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function ItemRow({
  item,
  index,
  count,
  editable,
  invalid,
  onDuration,
  onMove,
  onRemove,
}: {
  item: EditorItem;
  index: number;
  count: number;
  editable: boolean;
  invalid: boolean;
  onDuration: (text: string) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const media = item.media;
  const parsed = parseDurationInput(item.durationText);
  const inputId = `duration-${item.key}`;
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5 sm:flex-nowrap">
      <span className="w-7 shrink-0 text-right text-sm text-ink-3 tabular-nums" aria-hidden>
        {index + 1}
      </span>
      <MediaThumb media={media} className="w-24 shrink-0" showLength={false} />
      <div className="min-w-0 flex-1 basis-40">
        <p className="flex min-w-0 items-center gap-1.5">
          <MediaTypeIcon type={media.type} />
          <span className="truncate font-medium" title={media.name}>
            {media.name}
          </span>
        </p>
        {media.status !== "ready" && (
          <Badge tone={media.status === "failed" ? "bad" : "info"} className="mt-1">
            {media.status === "failed" ? "İşlenemedi, TV'de atlanır" : "İşleniyor, hazır olunca oynar"}
          </Badge>
        )}
      </div>
      <div className="w-36 shrink-0">
        {media.type === "video" ? (
          <p className="text-sm text-ink-2">
            Sonuna kadar <span className="tabular-nums">{formatClockMs(media.durationMs)}</span>
          </p>
        ) : editable ? (
          <div>
            <label htmlFor={inputId} className="sr-only">
              {`${media.name} ekranda kalma süresi (saniye)`}
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                id={inputId}
                inputMode="numeric"
                placeholder={String(DEFAULT_IMAGE_DURATION_SEC)}
                value={item.durationText}
                onChange={(event) => onDuration(event.target.value)}
                aria-invalid={invalid}
                aria-describedby={invalid ? `${inputId}-error` : undefined}
                className="h-8 w-20 text-right"
              />
              <span className="text-sm text-ink-2">sn</span>
            </div>
            {!parsed.ok && (
              <p id={`${inputId}-error`} className="mt-1 text-xs text-bad">
                {parsed.message}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-2 tabular-nums">
            {parsed.ok && parsed.value !== null ? parsed.value : DEFAULT_IMAGE_DURATION_SEC} sn
          </p>
        )}
      </div>
      {editable && (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton size="sm" icon={ChevronUp} label="Yukarı taşı" disabled={index === 0} onClick={() => onMove(index - 1)} />
          <IconButton size="sm" icon={ChevronDown} label="Aşağı taşı" disabled={index === count - 1} onClick={() => onMove(index + 1)} />
          <IconButton size="sm" icon={X} label="Listeden çıkar" variant="danger-ghost" onClick={onRemove} />
        </div>
      )}
    </li>
  );
}

function Editor({ detail, editable }: { detail: api.PlaylistDetail; editable: boolean }) {
  const save = useSavePlaylistItems(detail.id);
  const toast = useToast();
  const [items, setItems] = useState<EditorItem[]>(() => fromDetail(detail));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  const { draft, invalid } = useMemo(() => toDraft(items), [items]);
  const dirty = isDraftDirty(detail.items, draft);
  const total = draftTotalSeconds(draft);
  const tooMany = items.length > MAX_ITEMS;

  // Leaving with unsaved changes: in-app navigation asks first, closing the tab gets the browser prompt.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (key: string, patch: Partial<EditorItem>) =>
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const submit = () => {
    if (invalid.size > 0 || tooMany) return;
    save.mutate(toItemsInput(draft), {
      onSuccess: (saved) => {
        setItems(fromDetail(saved));
        toast.success("Liste kaydedildi. TV'ler yeni sırayı bir sonraki senkronda alır.");
      },
    });
  };

  const summary = [
    `${items.length} öğe`,
    total === null ? "toplam süre video uzunlukları hesaplanınca görünür" : `toplam ${formatDuration(total)}`,
  ].join(", ");

  return (
    <>
      <PageHeader
        back={<BackLink />}
        title={
          <span className="inline-flex items-center gap-2">
            {detail.name}
            {editable && <IconButton size="sm" icon={Pencil} label="Listeyi yeniden adlandır" onClick={() => setRenameOpen(true)} />}
          </span>
        }
        description={summary}
        actions={
          editable ? (
            <>
              {dirty && (
                <Button variant="ghost" onClick={() => setItems(fromDetail(detail))} disabled={save.isPending}>
                  Değişiklikleri geri al
                </Button>
              )}
              <Button icon={ListPlus} onClick={() => setPickerOpen(true)}>
                Medya ekle
              </Button>
              <Button
                variant="primary"
                icon={Save}
                onClick={submit}
                pending={save.isPending}
                disabled={!dirty || invalid.size > 0 || tooMany}
              >
                Listeyi kaydet
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-4">
        {dirty && (
          <Alert tone="info">Kaydedilmemiş değişiklikler var. TV'ler listeyi kaydettiğinizde günceller.</Alert>
        )}
        {tooMany && <Alert tone="bad">Bir listede en fazla {MAX_ITEMS} öğe olabilir.</Alert>}
        <FormError message={save.isError ? errorMessage(save.error) : null} />

        {items.length === 0 ? (
          <EmptyState
            icon={ListVideo}
            title="Liste boş"
            action={
              editable ? (
                <Button variant="primary" icon={ListPlus} onClick={() => setPickerOpen(true)}>
                  Medya ekle
                </Button>
              ) : undefined
            }
          >
            {editable
              ? "Kitaplıktan resim ve video ekleyin. Resimler varsayılan olarak 10 saniye ekranda kalır, videolar sonuna kadar oynar."
              : "Bu listede henüz öğe yok."}
          </EmptyState>
        ) : (
          <div className="panel">
            <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
              <span>Oynatma sırası</span>
              {editable && <span className="hidden sm:inline">Resim süresi boş kalırsa {DEFAULT_IMAGE_DURATION_SEC} sn</span>}
            </div>
            <ol ref={listRef} className="divide-y divide-line">
              {items.map((item, index) => (
                <ItemRow
                  key={item.key}
                  item={item}
                  index={index}
                  count={items.length}
                  editable={editable}
                  invalid={invalid.has(item.key)}
                  onDuration={(text) => update(item.key, { durationText: text })}
                  onMove={(to) => setItems((list) => moveItem(list, index, to))}
                  onRemove={() => setItems((list) => list.filter((x) => x.key !== item.key))}
                />
              ))}
            </ol>
          </div>
        )}
      </div>

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAdd={(media) => {
          setItems((list) => [...list, ...media.map((m) => ({ key: newKey(), media: m, durationText: "" }))]);
          // Bring the newly added rows into view.
          window.requestAnimationFrame(() => listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" }));
        }}
      />

      <PlaylistNameDialog
        key={renameOpen ? "rename" : "closed"}
        open={renameOpen}
        playlist={detail}
        onClose={() => setRenameOpen(false)}
      />

      <ConfirmDialog
        open={blocker.state === "blocked"}
        onClose={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
        title="Kaydedilmemiş değişiklikler var"
        confirmLabel="Değişiklikleri at"
      >
        <p>Bu listede yaptığınız değişiklikler kaydedilmedi. Sayfadan çıkarsanız kaybolur.</p>
      </ConfirmDialog>
    </>
  );
}

export function PlaylistEditorPage() {
  const { id = "" } = useParams();
  const me = useCurrentUser();
  const playlist = usePlaylist(id);

  if (playlist.isPending) return <LoadingState />;
  // A failed background refetch must not throw away the draft; only a missing playlist does.
  if (playlist.isError && (playlist.data === undefined || isApiError(playlist.error, "not_found"))) {
    return (
      <>
        <PageHeader title="Oynatma listesi" back={<BackLink />} />
        {isApiError(playlist.error, "not_found") ? (
          <EmptyState icon={ListVideo} title="Liste bulunamadı">
            Silinmiş olabilir. Oynatma listelerine dönüp güncel listelere bakın.
          </EmptyState>
        ) : (
          <ErrorState error={playlist.error} onRetry={() => void playlist.refetch()} />
        )}
      </>
    );
  }
  // Keyed by id so moving between playlists starts a fresh draft. Background refetches do not reset it.
  if (playlist.data === undefined) return <LoadingState />;
  return <Editor key={playlist.data.id} detail={playlist.data} editable={canEditContent(me)} />;
}
