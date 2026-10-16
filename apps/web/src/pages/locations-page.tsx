import { api } from "@managealltv/protocol";
import { MapPin, Pencil, Plus, Trash } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Button, IconButton } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Dialog } from "../components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback";
import { Field, FormError, Input, Select } from "../components/ui/form";
import { PageHeader } from "../components/ui/page";
import { useToast } from "../components/ui/toast";
import { errorMessage } from "../lib/api/errors";
import { useCreateLocation, useDeleteLocation, useLocations, useUpdateLocation } from "../lib/api/locations";
import { DEFAULT_TIMEZONE, timezoneLabel, timezoneOptions } from "../lib/timezones";

function LocationDialog({ location, onClose }: { location: api.Location | null; onClose: () => void }) {
  const formId = useId();
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const toast = useToast();
  const mutation = location === null ? create : update;
  const [name, setName] = useState(location?.name ?? "");
  const [address, setAddress] = useState(location?.address ?? "");
  const [timezone, setTimezone] = useState(location?.timezone ?? DEFAULT_TIMEZONE);
  const [submitted, setSubmitted] = useState(false);
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);

  const input: api.LocationInput = {
    name: name.trim(),
    address: address.trim() === "" ? null : address.trim(),
    timezone,
  };
  const parsed = api.LocationInput.safeParse(input);
  const nameError = submitted && input.name === "" ? "Konum adı girin." : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!parsed.success) return;
    const done = () => {
      toast.success(location === null ? `"${input.name}" eklendi.` : "Konum kaydedildi.");
      onClose();
    };
    if (location === null) create.mutate(parsed.data, { onSuccess: done });
    else update.mutate({ id: location.id, input: parsed.data }, { onSuccess: done });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={location === null ? "Yeni konum" : "Konumu düzenle"}
      dismissible={!mutation.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" form={formId} variant="primary" pending={mutation.isPending}>
            {location === null ? "Konumu ekle" : "Değişiklikleri kaydet"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Ad" hint="Ör. “Merkez ofis”, “Ankara şube”." error={nameError}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              autoFocus
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </Field>
        <Field label="Adres" optional>
          {({ id }) => <Input id={id} maxLength={300} value={address} onChange={(event) => setAddress(event.target.value)} />}
        </Field>
        <Field
          label="Saat dilimi"
          hint="Bu konumdaki TV'ler zamanlamaları bu saat dilimine göre uygular."
        >
          {({ id, describedBy }) => (
            <Select id={id} value={timezone} onChange={(event) => setTimezone(event.target.value)} aria-describedby={describedBy}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {timezoneLabel(zone)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <FormError message={mutation.isError ? errorMessage(mutation.error) : null} />
      </form>
    </Dialog>
  );
}

export function LocationsPage() {
  const locations = useLocations();
  const remove = useDeleteLocation();
  const toast = useToast();
  const [editing, setEditing] = useState<{ location: api.Location | null } | null>(null);
  const [deleting, setDeleting] = useState<api.Location | null>(null);

  const addButton = (
    <Button variant="primary" icon={Plus} onClick={() => setEditing({ location: null })}>
      Yeni konum
    </Button>
  );
  const list = [...(locations.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "tr"));

  return (
    <>
      <PageHeader
        title="Konumlar"
        description="TV'lerin bulunduğu yerler. Editör ve izleyiciler yalnız kendilerine atanan konumlardaki TV'leri görür."
        actions={addButton}
      />
      {locations.isPending ? (
        <LoadingState />
      ) : locations.isError && locations.data === undefined ? (
        <ErrorState error={locations.error} onRetry={() => void locations.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={MapPin} title="Henüz konum yok" action={addButton}>
          TV eklemeden önce en az bir konum oluşturun. Zamanlamalar konumun saat dilimine göre çalışır.
        </EmptyState>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Ad</th>
                <th scope="col">Adres</th>
                <th scope="col">Saat dilimi</th>
                <th scope="col" className="text-right">
                  TV
                </th>
                <th scope="col">
                  <span className="sr-only">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((location) => (
                <tr key={location.id}>
                  <td className="font-medium">{location.name}</td>
                  <td className="max-w-80 truncate text-ink-2">{location.address ?? "—"}</td>
                  <td className="whitespace-nowrap text-ink-2">{location.timezone}</td>
                  <td className="text-right tabular-nums">{location.deviceCount}</td>
                  <td className="w-0 whitespace-nowrap">
                    <div className="flex justify-end gap-0.5">
                      <IconButton size="sm" icon={Pencil} label="Düzenle" onClick={() => setEditing({ location })} />
                      <IconButton
                        size="sm"
                        icon={Trash}
                        label="Sil"
                        variant="danger-ghost"
                        onClick={() => {
                          remove.reset();
                          setDeleting(location);
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing !== null && (
        <LocationDialog key={editing.location?.id ?? "new"} location={editing.location} onClose={() => setEditing(null)} />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Konum silinsin mi?"
        confirmLabel="Konumu sil"
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
          <>
            <p>“{deleting.name}” silinir.</p>
            {deleting.deviceCount > 0 && (
              <p className="text-warn">
                Bu konumda {deleting.deviceCount} TV var. Silmeden önce TV'leri başka bir konuma taşıyın ya da kaldırın.
              </p>
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
