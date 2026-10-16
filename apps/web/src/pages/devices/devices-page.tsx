import type { api } from "@managealltv/protocol";
import { LayoutGrid, List, Play, Plus, Search, Tv } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useCurrentUser } from "../../app/session";
import { ClaimDeviceDialog } from "../../components/devices/claim-device-dialog";
import { DeviceScreen } from "../../components/devices/device-screen";
import { OnlineIndicator, SyncStatus } from "../../components/devices/device-status";
import { Button } from "../../components/ui/button";
import { Alert, EmptyState, ErrorState, LoadingState, StaleDataNotice } from "../../components/ui/feedback";
import { Input, Select } from "../../components/ui/form";
import { PageHeader } from "../../components/ui/page";
import { Segmented } from "../../components/ui/segmented";
import { useDevices } from "../../lib/api/devices";
import { useLocations } from "../../lib/api/locations";
import { useMediaIndex, usePlaylistIndex } from "../../lib/api/lookups";
import { isLongOffline } from "../../lib/devices";
import { formatRelative } from "../../lib/format";
import { useLocalPreference } from "../../lib/local-preference";
import { isAdmin } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";

type View = "grid" | "list";

function NowPlaying({ device, mediaIndex, playlistIndex }: {
  device: api.Device;
  mediaIndex: Map<string, api.Media>;
  playlistIndex: Map<string, api.Playlist>;
}) {
  const status = device.status;
  if (status === null || status.currentMediaId === null) {
    return <span className="text-ink-3">Oynatılan içerik yok</span>;
  }
  const media = mediaIndex.get(status.currentMediaId);
  const playlist = status.activePlaylistId !== null ? playlistIndex.get(status.activePlaylistId) : undefined;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Play size={12} className="shrink-0 text-ink-3" aria-label="Oynatılıyor" />
      <span className="truncate" title={media?.name}>
        {media?.name ?? "Bilinmeyen içerik"}
      </span>
      {playlist !== undefined && <span className="hidden shrink-0 text-ink-3 xl:inline">({playlist.name})</span>}
    </span>
  );
}

function DeviceCard(props: {
  device: api.Device;
  mediaIndex: Map<string, api.Media>;
  playlistIndex: Map<string, api.Playlist>;
  now: Date;
}) {
  const { device, mediaIndex, now } = props;
  const media = device.status?.currentMediaId != null ? mediaIndex.get(device.status.currentMediaId) : undefined;
  return (
    <li>
      <Link
        to={`/devices/${device.id}`}
        className="group panel flex h-full flex-col gap-3 p-3 transition-colors hover:border-line-strong"
      >
        <DeviceScreen device={device} media={media} />
        <div className="flex min-w-0 flex-col gap-1.5 px-0.5">
          <div className="flex items-start justify-between gap-2">
            <h2 className="truncate text-lg font-semibold group-hover:text-accent">{device.name}</h2>
            <SyncStatus device={device} />
          </div>
          <p className="truncate text-sm text-ink-2">{device.locationName}</p>
          <div className="text-sm">
            <NowPlaying {...props} />
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <OnlineIndicator device={device} now={now} />
            {device.online && device.lastSeenAt !== null && (
              <span className="text-xs text-ink-3">{formatRelative(device.lastSeenAt, now)}</span>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

function DeviceTable({ devices, mediaIndex, playlistIndex, now }: {
  devices: api.Device[];
  mediaIndex: Map<string, api.Media>;
  playlistIndex: Map<string, api.Playlist>;
  now: Date;
}) {
  return (
    <div className="panel overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Ad</th>
            <th scope="col">Durum</th>
            <th scope="col">Konum</th>
            <th scope="col">Oynatılan</th>
            <th scope="col">İçerik</th>
            <th scope="col">Son görülme</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.id}>
              <td className="font-medium">
                <Link to={`/devices/${device.id}`} className="text-ink hover:text-accent hover:underline">
                  {device.name}
                </Link>
              </td>
              <td>
                <OnlineIndicator device={device} now={now} />
              </td>
              <td className="text-ink-2">{device.locationName}</td>
              <td className="max-w-72">
                <NowPlaying device={device} mediaIndex={mediaIndex} playlistIndex={playlistIndex} />
              </td>
              <td>
                <SyncStatus device={device} />
              </td>
              <td className="whitespace-nowrap text-ink-2">{formatRelative(device.lastSeenAt, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DevicesPage() {
  const me = useCurrentUser();
  const devices = useDevices();
  const locations = useLocations();
  const mediaIndex = useMediaIndex();
  const playlistIndex = usePlaylistIndex();
  const now = useNow();
  const [view, setView] = useLocalPreference<View>("mtv.devices.view", ["grid", "list"], "grid");
  const [query, setQuery] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [claimOpen, setClaimOpen] = useState(false);

  const all = useMemo(() => devices.data ?? [], [devices.data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("tr");
    return all
      .filter((d) => locationFilter === "" || d.locationId === locationFilter)
      .filter((d) => q === "" || d.name.toLocaleLowerCase("tr").includes(q) || d.locationName.toLocaleLowerCase("tr").includes(q))
      .sort((a, b) => a.locationName.localeCompare(b.locationName, "tr") || a.name.localeCompare(b.name, "tr"));
  }, [all, query, locationFilter]);

  const onlineCount = all.filter((d) => d.online).length;
  const longOffline = all.filter((d) => isLongOffline(d, now));
  const admin = isAdmin(me);

  const addButton = admin ? (
    <Button variant="primary" icon={Plus} onClick={() => setClaimOpen(true)}>
      TV ekle
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        title="Ekranlar"
        description={
          all.length > 0
            ? `${all.length} TV, ${onlineCount} tanesi çevrimiçi. Bilgiler 10 saniyede bir yenilenir.`
            : "Konumlardaki TV'lerin durumu ve şu an oynattıkları."
        }
        actions={addButton}
      />

      {devices.isPending ? (
        <LoadingState />
      ) : devices.isError && devices.data === undefined ? (
        <ErrorState error={devices.error} onRetry={() => void devices.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState icon={Tv} title="Henüz TV eklenmedi" action={addButton}>
          {admin
            ? "TV'de ManageAllTV uygulamasını açın. Ekranda görünen 6 haneli kodu “TV ekle” ile girdiğinizde TV buraya gelir."
            : "Yetkili olduğunuz konumlarda kayıtlı TV yok. TV eklemek için bir yöneticiye başvurun."}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <StaleDataNotice show={devices.isError} error={devices.error} />
          {longOffline.length > 0 && (
            <Alert tone="warn" title={`${longOffline.length} TV 10 dakikadan uzun süredir çevrimdışı`}>
              {longOffline.map((d) => d.name).join(", ")}. TV'nin açık olduğunu ve Wi-Fi'a bağlandığını kontrol edin.
              İçerik indirilmiş olduğu için TV yayına devam ediyor olabilir; panel yalnız haber alamıyor.
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input
                type="search"
                placeholder="TV veya konum ara"
                aria-label="TV veya konum ara"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8"
              />
            </div>
            {(locations.data?.length ?? 0) > 1 && (
              <Select
                aria-label="Konuma göre filtrele"
                value={locationFilter}
                onChange={(event) => setLocationFilter(event.target.value)}
                className="w-full sm:w-52"
              >
                <option value="">Tüm konumlar</option>
                {locations.data?.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </Select>
            )}
            <div className="ml-auto">
              <Segmented<View>
                label="Görünüm"
                value={view}
                onChange={setView}
                options={[
                  { value: "grid", label: "Ekran görünümü", icon: LayoutGrid, iconOnly: true },
                  { value: "list", label: "Liste görünümü", icon: List, iconOnly: true },
                ]}
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState icon={Search} title="Eşleşen TV yok">
              Aramayı ya da konum filtresini değiştirin.
            </EmptyState>
          ) : view === "grid" ? (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((device) => (
                <DeviceCard key={device.id} device={device} mediaIndex={mediaIndex} playlistIndex={playlistIndex} now={now} />
              ))}
            </ul>
          ) : (
            <DeviceTable devices={filtered} mediaIndex={mediaIndex} playlistIndex={playlistIndex} now={now} />
          )}
        </div>
      )}

      {admin && <ClaimDeviceDialog open={claimOpen} onClose={() => setClaimOpen(false)} />}
    </>
  );
}
