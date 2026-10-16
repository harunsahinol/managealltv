import type { api } from "@managealltv/protocol";
import { Save } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useUpdateDevice } from "../../lib/api/devices";
import { errorMessage } from "../../lib/api/errors";
import { useLocations } from "../../lib/api/locations";
import { usePlaylists } from "../../lib/api/playlists";
import { Button } from "../ui/button";
import { Field, FormError, Input, Select } from "../ui/form";
import { useToast } from "../ui/toast";

interface Draft {
  name: string;
  locationId: string;
  defaultPlaylistId: string;
  /** "tv" = leave the TV's own volume alone (null on the server). */
  volumeMode: "tv" | "fixed";
  volume: number;
}

function fromDevice(device: api.Device): Draft {
  return {
    name: device.name,
    locationId: device.locationId,
    defaultPlaylistId: device.defaultPlaylistId ?? "",
    volumeMode: device.volume === null ? "tv" : "fixed",
    volume: device.volume ?? 50,
  };
}

/** Only the fields that changed, limited to what the role may send (editors: playlist and volume). */
export function deviceChanges(device: api.Device, draft: Draft, admin: boolean): api.DeviceUpdate {
  const changes: api.DeviceUpdate = {};
  if (admin) {
    const name = draft.name.trim();
    if (name !== device.name) changes.name = name;
    if (draft.locationId !== device.locationId) changes.locationId = draft.locationId;
  }
  const playlist = draft.defaultPlaylistId === "" ? null : draft.defaultPlaylistId;
  if (playlist !== device.defaultPlaylistId) changes.defaultPlaylistId = playlist;
  const volume = draft.volumeMode === "tv" ? null : draft.volume;
  if (volume !== device.volume) changes.volume = volume;
  return changes;
}

/**
 * Device settings. The page polls the device every 10 s; the form keeps its own draft so polling
 * never overwrites what someone is typing.
 */
export function DeviceSettings({ device, admin, canEdit }: { device: api.Device; admin: boolean; canEdit: boolean }) {
  const update = useUpdateDevice(device.id);
  const playlists = usePlaylists();
  const locations = useLocations();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => fromDevice(device));

  const changes = deviceChanges(device, draft, admin);
  const dirty = Object.keys(changes).length > 0;
  const nameMissing = admin && draft.name.trim() === "";
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((old) => ({ ...old, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || nameMissing) return;
    update.mutate(changes, {
      onSuccess: (saved) => {
        setDraft(fromDevice(saved));
        toast.success("Ayarlar kaydedildi. TV yeni ayarları birkaç saniye içinde alır.");
      },
    });
  };

  const readOnly = !canEdit;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Ad" error={nameMissing ? "Ad boş olamaz." : undefined} hint={!admin ? "Yalnız yöneticiler değiştirebilir." : undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              value={draft.name}
              maxLength={100}
              disabled={!admin}
              onChange={(event) => set("name", event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </Field>
        <Field label="Konum" hint={admin ? "Zamanlamalar ve saat dilimi konumdan gelir." : "Yalnız yöneticiler değiştirebilir."}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              value={draft.locationId}
              disabled={!admin}
              onChange={(event) => set("locationId", event.target.value)}
              aria-describedby={describedBy}
            >
              {!(locations.data ?? []).some((l) => l.id === draft.locationId) && (
                <option value={draft.locationId}>{device.locationName}</option>
              )}
              {locations.data?.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Field
        label="Varsayılan liste"
        hint="Hiçbir zamanlama etkin değilken oynatılır. Liste seçilmezse ekran boş kalır."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            value={draft.defaultPlaylistId}
            disabled={readOnly}
            onChange={(event) => set("defaultPlaylistId", event.target.value)}
            aria-describedby={describedBy}
          >
            <option value="">Liste yok (boş ekran)</option>
            {playlists.data?.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <fieldset className="flex flex-col gap-2" disabled={readOnly}>
        <legend className="mb-1.5 text-sm font-medium">Ses</legend>
        <label className="flex items-center gap-2.5 text-base">
          <input
            type="radio"
            name={`volume-${device.id}`}
            checked={draft.volumeMode === "tv"}
            onChange={() => set("volumeMode", "tv")}
            className="size-4 accent-(--accent)"
          />
          TV'nin kendi ayarı
        </label>
        <label className="flex items-center gap-2.5 text-base">
          <input
            type="radio"
            name={`volume-${device.id}`}
            checked={draft.volumeMode === "fixed"}
            onChange={() => set("volumeMode", "fixed")}
            className="size-4 accent-(--accent)"
          />
          Sabit seviye
        </label>
        {draft.volumeMode === "fixed" && (
          <div className="ml-6.5 flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={100}
              value={draft.volume}
              aria-label="Sabit ses seviyesi"
              onChange={(event) => set("volume", Number(event.target.value))}
              className="h-2 max-w-64 flex-1 accent-(--accent)"
            />
            <span className="w-8 text-right text-base tabular-nums">{draft.volume}</span>
          </div>
        )}
        <p className="text-xs text-ink-3">
          Sabit seviye seçilirse TV her açılışta ve senkronda bu seviyeye döner; kumandayla yapılan değişiklik kalıcı olmaz.
        </p>
      </fieldset>

      {canEdit && (
        <>
          <FormError message={update.isError ? errorMessage(update.error) : null} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" icon={Save} pending={update.isPending} disabled={!dirty || nameMissing}>
              Ayarları kaydet
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(fromDevice(device))} disabled={update.isPending}>
                Değişiklikleri geri al
              </Button>
            )}
          </div>
        </>
      )}
    </form>
  );
}
