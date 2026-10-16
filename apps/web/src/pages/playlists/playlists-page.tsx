import type { api } from "@managealltv/protocol";
import { ListVideo, Pencil, Plus, Trash } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useCurrentUser } from "../../app/session";
import { Button, IconButton } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Dialog } from "../../components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/feedback";
import { Field, FormError, Input } from "../../components/ui/form";
import { PageHeader } from "../../components/ui/page";
import { useToast } from "../../components/ui/toast";
import { errorMessage } from "../../lib/api/errors";
import { useCreatePlaylist, useDeletePlaylist, usePlaylists, useRenamePlaylist } from "../../lib/api/playlists";
import { formatDateTime, formatDuration } from "../../lib/format";
import { canEditContent } from "../../lib/permissions";

/** Create (playlist === null) or rename a playlist. Keyed by the caller so it starts fresh. */
export function PlaylistNameDialog({
  open,
  playlist,
  onClose,
  onCreated,
}: {
  open: boolean;
  playlist: Pick<api.Playlist, "id" | "name"> | null;
  onClose: () => void;
  onCreated?: (playlist: api.PlaylistDetail) => void;
}) {
  const formId = useId();
  const create = useCreatePlaylist();
  const rename = useRenamePlaylist();
  const toast = useToast();
  const [name, setName] = useState(playlist?.name ?? "");
  const mutation = playlist === null ? create : rename;
  const trimmed = name.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === "") return;
    if (playlist === null) {
      create.mutate(
        { name: trimmed },
        {
          onSuccess: (created) => {
            toast.success(`"${created.name}" oluşturuldu. Şimdi medya ekleyebilirsiniz.`);
            onClose();
            onCreated?.(created);
          },
        },
      );
    } else {
      rename.mutate(
        { id: playlist.id, name: trimmed },
        {
          onSuccess: () => {
            toast.success("Liste adı değiştirildi.");
            onClose();
          },
        },
      );
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={playlist === null ? "Yeni oynatma listesi" : "Listeyi yeniden adlandır"}
      size="sm"
      dismissible={!mutation.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" form={formId} variant="primary" pending={mutation.isPending} disabled={trimmed === ""}>
            {playlist === null ? "Listeyi oluştur" : "Adı kaydet"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Liste adı" hint="Ör. “Lobi sabah”, “Kampanya Kasım”.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              autoFocus
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-describedby={describedBy}
            />
          )}
        </Field>
        <FormError message={mutation.isError ? errorMessage(mutation.error) : null} />
      </form>
    </Dialog>
  );
}

export function PlaylistsPage() {
  const me = useCurrentUser();
  const playlists = usePlaylists();
  const remove = useDeletePlaylist();
  const navigate = useNavigate();
  const toast = useToast();
  const canEdit = canEditContent(me);
  const [dialog, setDialog] = useState<{ playlist: api.Playlist | null } | null>(null);
  const [deleting, setDeleting] = useState<api.Playlist | null>(null);

  const createButton = canEdit ? (
    <Button variant="primary" icon={Plus} onClick={() => setDialog({ playlist: null })}>
      Yeni liste
    </Button>
  ) : undefined;

  const list = [...(playlists.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "tr"));

  return (
    <>
      <PageHeader
        title="Oynatma listeleri"
        description="Sıralı resim ve videolar. Bir liste TV'nin varsayılan listesi olarak ya da zamanlamayla belirli saatlerde oynatılır."
        actions={createButton}
      />

      {playlists.isPending ? (
        <LoadingState />
      ) : playlists.isError && playlists.data === undefined ? (
        <ErrorState error={playlists.error} onRetry={() => void playlists.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={ListVideo} title="Henüz liste yok" action={createButton}>
          {canEdit
            ? "Bir liste oluşturun, kitaplıktan medya ekleyin, sonra listeyi TV ayarlarından varsayılan yapın ya da zamanlayın."
            : "Henüz oynatma listesi oluşturulmamış."}
        </EmptyState>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Ad</th>
                <th scope="col" className="text-right">
                  Öğe
                </th>
                <th scope="col" className="text-right">
                  Toplam süre
                </th>
                <th scope="col">Son değişiklik</th>
                {canEdit && (
                  <th scope="col">
                    <span className="sr-only">İşlemler</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {list.map((playlist) => (
                <tr key={playlist.id}>
                  <td className="font-medium">
                    <Link to={`/playlists/${playlist.id}`} className="text-ink hover:text-accent hover:underline">
                      {playlist.name}
                    </Link>
                  </td>
                  <td className="text-right tabular-nums">{playlist.itemCount}</td>
                  <td className="text-right whitespace-nowrap tabular-nums">
                    {playlist.itemCount === 0
                      ? "—"
                      : playlist.totalDurationSec === null
                        ? "Hesaplanıyor"
                        : formatDuration(playlist.totalDurationSec)}
                  </td>
                  <td className="whitespace-nowrap text-ink-2">{formatDateTime(playlist.updatedAt)}</td>
                  {canEdit && (
                    <td className="w-0 whitespace-nowrap">
                      <div className="flex justify-end gap-0.5">
                        <IconButton size="sm" icon={Pencil} label="Yeniden adlandır" onClick={() => setDialog({ playlist })} />
                        <IconButton
                          size="sm"
                          icon={Trash}
                          variant="danger-ghost"
                          label="Sil"
                          onClick={() => {
                            remove.reset();
                            setDeleting(playlist);
                          }}
                        />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PlaylistNameDialog
        key={dialog === null ? "closed" : (dialog.playlist?.id ?? "new")}
        open={dialog !== null}
        playlist={dialog?.playlist ?? null}
        onClose={() => setDialog(null)}
        onCreated={(created) => void navigate(`/playlists/${created.id}`)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Liste silinsin mi?"
        confirmLabel="Listeyi sil"
        pending={remove.isPending}
        error={remove.isError ? remove.error : null}
        onConfirm={() => {
          if (deleting === null) return;
          const target = deleting;
          remove.mutate(target.id, {
            onSuccess: () => {
              toast.success(`"${target.name}" silindi.`);
              setDeleting(null);
            },
          });
        }}
      >
        {deleting !== null && (
          <p>
            “{deleting.name}” silinir; içindeki medya kitaplıkta kalır. Liste bir TV'nin varsayılan listesiyse ya da bir
            zamanlamada kullanılıyorsa önce oradan kaldırılmalıdır.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
