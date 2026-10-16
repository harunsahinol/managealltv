import type { api } from "@managealltv/protocol";
import { ArrowLeft, CalendarClock, History, Trash } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useCurrentUser } from "../../app/session";
import { DeviceCommands } from "../../components/devices/device-commands";
import { DeviceScreen } from "../../components/devices/device-screen";
import { DeviceSettings } from "../../components/devices/device-settings";
import { OnlineIndicator, SyncStatus } from "../../components/devices/device-status";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Alert, Badge, EmptyState, ErrorState, LoadingState, StaleDataNotice } from "../../components/ui/feedback";
import { Facts, PageHeader, Section } from "../../components/ui/page";
import { useToast } from "../../components/ui/toast";
import { activeRuleId, schedulesForDevice, toManifestRules } from "../../lib/active-schedule";
import { useDeleteDevice, useDevice, useDeviceCommands } from "../../lib/api/devices";
import { isApiError } from "../../lib/api/errors";
import { useLocationIndex, useMediaIndex, usePlaylistIndex } from "../../lib/api/lookups";
import { useSchedules } from "../../lib/api/schedules";
import { COMMAND_STATUS_LABELS, COMMAND_STATUS_TONE, describeCommand } from "../../lib/devices";
import { formatBytes, formatDateTime, formatRelative, formatUptime } from "../../lib/format";
import { canControlDevice, isAdmin } from "../../lib/permissions";
import { summarizeSchedule } from "../../lib/schedule";
import { useNow } from "../../lib/use-now";

function BackLink() {
  return (
    <Link to="/devices" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-accent">
      <ArrowLeft size={14} aria-hidden />
      Ekranlar
    </Link>
  );
}

function SetupWarnings({ status }: { status: api.Device["status"] }) {
  if (status === null) return null;
  return (
    <>
      {!status.overlayPermission && (
        <Alert tone="warn" title="“Diğer uygulamaların üzerinde göster” izni yok">
          TV bekleme modundan uyandığında uygulama kendiliğinden öne gelemeyebilir. TV ayarlarında Uygulamalar → Özel
          uygulama erişimi bölümünden izni verin; menüde yoksa kurulum listesindeki adb komutuyla verin.
        </Alert>
      )}
      {!status.deviceOwner && (
        <Alert tone="info" title="Uygulama cihaz sahibi (Device Owner) değil">
          Uzaktan yeniden başlatma ve onaysız güncelleme çalışmaz, uygulama ana ekran olarak kilitlenemez. Yalnız tabela
          olarak kullanılan TV'lerde, TV'den hesaplar kaldırıldıktan sonra adb ile etkinleştirilebilir.
        </Alert>
      )}
    </>
  );
}

function CommandHistory({ deviceId }: { deviceId: string }) {
  const commands = useDeviceCommands(deviceId);
  const now = useNow();
  if (commands.isPending) return <LoadingState className="py-8" />;
  if (commands.data === undefined) return <ErrorState error={commands.error} onRetry={() => void commands.refetch()} />;
  if (commands.data.length === 0) {
    return <p className="py-2 text-base text-ink-3">Bu TV'ye henüz komut gönderilmedi.</p>;
  }
  return (
    <div className="-mx-4 -my-4 overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Komut</th>
            <th scope="col">Durum</th>
            <th scope="col">Gönderen</th>
            <th scope="col">Zaman</th>
          </tr>
        </thead>
        <tbody>
          {commands.data.slice(0, 20).map((command) => (
            <tr key={command.id}>
              <td>
                <span className="font-medium">{describeCommand(command.command)}</span>
                {command.message !== null && command.message !== "" && (
                  <span className="mt-0.5 block text-sm break-words text-ink-2">{command.message}</span>
                )}
              </td>
              <td>
                <Badge tone={COMMAND_STATUS_TONE[command.status]}>{COMMAND_STATUS_LABELS[command.status]}</Badge>
              </td>
              <td className="text-ink-2">{command.createdByName ?? "—"}</td>
              <td className="whitespace-nowrap text-ink-2" title={formatDateTime(command.createdAt)}>
                {formatRelative(command.createdAt, now)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeviceSchedules({ device, timezone }: { device: api.Device; timezone: string | undefined }) {
  const schedules = useSchedules();
  const now = useNow(60_000);
  const relevant = useMemo(() => {
    const list = schedulesForDevice(schedules.data ?? [], device);
    // Same order as the manifest, so the list reads top-down in the order the TV checks it.
    const order = toManifestRules(list).map((rule) => rule.id);
    return order.map((id) => list.find((s) => s.id === id)).filter((s): s is api.Schedule => s !== undefined);
  }, [schedules.data, device]);
  const activeId = timezone !== undefined ? activeRuleId(relevant, device.defaultPlaylistId, timezone, now) : null;

  if (schedules.isPending) return <LoadingState className="py-8" />;
  if (schedules.isError) return <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />;
  if (relevant.length === 0) {
    return (
      <p className="text-base text-ink-3">
        Bu TV'yi etkileyen zamanlama yok; her zaman varsayılan listeyi oynatır.{" "}
        <Link to="/schedules" className="font-medium text-accent hover:underline">
          Zamanlama ekle
        </Link>
      </p>
    );
  }
  return (
    <ul className="-my-1 divide-y divide-line">
      {relevant.map((schedule) => (
        <li key={schedule.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
          <div className="min-w-0">
            <p className="font-medium">{schedule.playlistName}</p>
            <p className="text-sm text-ink-2">{summarizeSchedule(schedule)}</p>
            <p className="text-xs text-ink-3">
              {schedule.targetType === "device" ? "Yalnız bu TV" : `Konumun tümü: ${schedule.targetName}`}, öncelik{" "}
              {schedule.priority}
            </p>
          </div>
          {schedule.id === activeId && <Badge tone="ok">Şu an etkin</Badge>}
        </li>
      ))}
    </ul>
  );
}

export function DeviceDetailPage() {
  const { id = "" } = useParams();
  const me = useCurrentUser();
  const device = useDevice(id);
  const mediaIndex = useMediaIndex();
  const playlistIndex = usePlaylistIndex();
  const locationIndex = useLocationIndex();
  const remove = useDeleteDevice();
  const navigate = useNavigate();
  const toast = useToast();
  const now = useNow();
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (device.isPending) return <LoadingState />;
  // A failed poll keeps showing the last known state (with a notice); a 404 means the TV is gone.
  if (device.isError && (device.data === undefined || isApiError(device.error, "not_found"))) {
    if (isApiError(device.error, "not_found")) {
      return (
        <>
          <PageHeader title="TV bulunamadı" back={<BackLink />} />
          <EmptyState icon={History} title="Bu TV kaldırılmış ya da görme yetkiniz yok">
            Ekranlar listesine dönüp güncel TV'lere bakın.
          </EmptyState>
        </>
      );
    }
    return (
      <>
        <PageHeader title="TV" back={<BackLink />} />
        <ErrorState error={device.error} onRetry={() => void device.refetch()} />
      </>
    );
  }

  const d = device.data;
  if (d === undefined) return <LoadingState />;
  const status = d.status;
  const admin = isAdmin(me);
  const canControl = canControlDevice(me, d);
  const currentMedia = status?.currentMediaId != null ? mediaIndex.get(status.currentMediaId) : undefined;
  const activePlaylist = status?.activePlaylistId != null ? playlistIndex.get(status.activePlaylistId) : undefined;
  const expectedPlaylist = d.expectedPlaylistId !== null ? playlistIndex.get(d.expectedPlaylistId) : undefined;
  const playlistMismatch =
    status !== null && d.online && status.activePlaylistId !== d.expectedPlaylistId && status.syncState !== "downloading";
  const location = locationIndex.get(d.locationId);

  const doRemove = () =>
    remove.mutate(d.id, {
      onSuccess: () => {
        toast.success(`"${d.name}" kaldırıldı. TV eşleştirme ekranına döner.`);
        void navigate("/devices", { replace: true });
      },
    });

  return (
    <>
      <PageHeader
        back={<BackLink />}
        title={d.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{d.locationName}</span>
            <OnlineIndicator device={d} now={now} />
          </span>
        }
        actions={
          admin ? (
            <Button
              variant="danger-ghost"
              icon={Trash}
              onClick={() => {
                remove.reset();
                setConfirmRemove(true);
              }}
            >
              TV'yi kaldır
            </Button>
          ) : undefined
        }
      />

      <StaleDataNotice show={device.isError} error={device.error} className="mb-5" />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <div className="flex flex-col gap-5">
          <Section title="Şu an">
            <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <DeviceScreen device={d} media={currentMedia} size="lg" />
              <Facts
                items={[
                  {
                    label: "Oynatılan",
                    value: status?.currentMediaId != null ? (currentMedia?.name ?? "Bilinmeyen içerik") : "—",
                  },
                  {
                    label: "Etkin liste",
                    value: status?.activePlaylistId != null ? (activePlaylist?.name ?? "Bilinmeyen liste") : "Liste yok",
                  },
                  {
                    label: "Zamanlamaya göre oynaması gereken",
                    value: d.expectedPlaylistId !== null ? (expectedPlaylist?.name ?? "Bilinmeyen liste") : "Liste yok (boş ekran)",
                  },
                  { label: "İçerik", value: <SyncStatus device={d} detailed /> },
                ]}
              />
            </div>
            {playlistMismatch && (
              <p className="mt-4 text-sm text-ink-2">
                TV şu an zamanlamanın gerektirdiğinden farklı bir liste oynatıyor. Saat dilimi farkı ya da henüz inmemiş
                içerik olabilir; TV geçişi bütün dosyalar hazır olunca yapar.
              </p>
            )}
            {status?.lastError != null && status.syncState !== "error" && (
              <p className="mt-3 text-sm break-words text-bad">Son hata: {status.lastError}</p>
            )}
          </Section>

          <SetupWarnings status={status} />

          {canControl && (
            <Section title="Komutlar" description="Komutlar TV'ye anında iletilir; çevrimdışıysa sıraya alınır.">
              <DeviceCommands device={d} />
            </Section>
          )}

          <Section title="Komut geçmişi">
            <CommandHistory deviceId={d.id} />
          </Section>
        </div>

        <div className="flex flex-col gap-5">
          <Section title="Ayarlar">
            <DeviceSettings key={d.id} device={d} admin={admin} canEdit={canControl} />
          </Section>

          <Section
            title="Zamanlamalar"
            description={location !== undefined ? `Saatler ${location.timezone} saat dilimine göre.` : undefined}
            actions={
              <Link to="/schedules" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                <CalendarClock size={14} aria-hidden />
                Tümü
              </Link>
            }
          >
            <DeviceSchedules device={d} timezone={location?.timezone} />
          </Section>

          <Section title="Cihaz bilgileri">
            <Facts
              items={[
                { label: "Model", value: `${d.manufacturer} ${d.model}`.trim() || "—" },
                { label: "Android", value: d.androidVersion || "—" },
                { label: "Uygulama sürümü", value: status?.appVersionName ?? d.appVersionName },
                { label: "Boş depolama", value: status !== null ? formatBytes(status.freeStorageBytes) : "—" },
                { label: "Açık kalma süresi", value: status !== null ? formatUptime(status.uptimeSec) : "—" },
                { label: "Ses", value: status?.volume != null ? String(status.volume) : "Bilinmiyor" },
                { label: "Son görülme", value: formatDateTime(d.lastSeenAt) },
                { label: "Eklenme", value: formatDateTime(d.createdAt) },
                {
                  label: "İçerik sürümü",
                  value: `Sunucu ${d.manifestVersion}, TV ${status?.manifestVersion ?? "—"}`,
                },
              ]}
            />
          </Section>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="TV kaldırılsın mı?"
        confirmLabel="TV'yi kaldır"
        pending={remove.isPending}
        error={remove.isError ? remove.error : null}
        onConfirm={doRemove}
      >
        <p>
          “{d.name}” panelden silinir ve anahtarı iptal edilir. TV eşleştirme ekranına döner; yeniden eklemek için yeni kod
          gerekir.
        </p>
      </ConfirmDialog>
    </>
  );
}
