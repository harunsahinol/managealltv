import type { api } from "@managealltv/protocol";
import { CalendarClock, MapPin, Pencil, Plus, Trash, Tv } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useCurrentUser } from "../../app/session";
import { Button, IconButton } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/feedback";
import { Select } from "../../components/ui/form";
import { PageHeader } from "../../components/ui/page";
import { useToast } from "../../components/ui/toast";
import { useDevices } from "../../lib/api/devices";
import { useDeleteSchedule, useSchedules } from "../../lib/api/schedules";
import { canEditSchedule, canManageSchedules } from "../../lib/permissions";
import { summarizeSchedule } from "../../lib/schedule";
import { ScheduleFormDialog } from "./schedule-form-dialog";

function HowItWorks() {
  return (
    <details className="panel group px-4 py-3 text-base">
      <summary className="cursor-pointer font-medium text-ink marker:text-ink-3">Zamanlama nasıl çalışır?</summary>
      <ul className="mt-2.5 flex list-disc flex-col gap-1.5 pl-5 text-ink-2">
        <li>
          Bir TV, o anda geçerli zamanlamalardan <strong className="font-semibold text-ink">önceliği en yüksek</strong> olanın
          listesini oynatır. Öncelikler eşitse önce eklenen kazanır.
        </li>
        <li>Hiçbir zamanlama geçerli değilse TV'nin varsayılan listesi oynar; o da yoksa ekran boş kalır.</li>
        <li>
          Bitiş saati başlangıçtan önceyse (ör. 22:00–06:00) pencere gece yarısını geçer ve{" "}
          <strong className="font-semibold text-ink">başladığı güne</strong> sayılır: “Cuma 22:00–06:00” Cumartesi sabahı biter.
        </li>
        <li>Başlangıç ve bitiş aynıysa (ör. 00:00–00:00) seçilen günlerin tamamı kapsanır. Gün seçilmezse her gün geçerlidir.</li>
        <li>Tarih aralığı iki ucu da dahil olmak üzere pencerenin başladığı güne göre kontrol edilir.</li>
        <li>Saatler TV'nin bulunduğu konumun saat dilimine göredir. TV zamanlamayı kendisi uyguladığı için internet kesilse de doğru saatte doğru liste oynar.</li>
      </ul>
    </details>
  );
}

function TargetCell({ schedule }: { schedule: api.Schedule }) {
  const Icon = schedule.targetType === "device" ? Tv : MapPin;
  const label = schedule.targetType === "device" ? "TV" : "Konum";
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon size={14} className="shrink-0 text-ink-3" aria-label={label} />
      {schedule.targetType === "device" ? (
        <Link to={`/devices/${schedule.targetId}`} className="truncate hover:text-accent hover:underline">
          {schedule.targetName}
        </Link>
      ) : (
        <span className="truncate">{schedule.targetName}</span>
      )}
    </span>
  );
}

export function SchedulesPage() {
  const me = useCurrentUser();
  const schedules = useSchedules();
  const devices = useDevices();
  const remove = useDeleteSchedule();
  const toast = useToast();
  const [targetFilter, setTargetFilter] = useState("");
  const [editing, setEditing] = useState<{ schedule: api.Schedule | null } | null>(null);
  const [deleting, setDeleting] = useState<api.Schedule | null>(null);
  const canCreate = canManageSchedules(me);

  const deviceLocation = useMemo(() => {
    const map = new Map((devices.data ?? []).map((d) => [d.id, d.locationId]));
    return (id: string) => map.get(id);
  }, [devices.data]);

  const all = useMemo(() => schedules.data ?? [], [schedules.data]);
  const targets = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of all) seen.set(`${s.targetType}:${s.targetId}`, s.targetName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], "tr"));
  }, [all]);
  const visible = useMemo(
    () =>
      all
        .filter((s) => targetFilter === "" || `${s.targetType}:${s.targetId}` === targetFilter)
        .sort(
          (a, b) =>
            a.targetName.localeCompare(b.targetName, "tr") || b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
        ),
    [all, targetFilter],
  );

  const createButton = canCreate ? (
    <Button variant="primary" icon={Plus} onClick={() => setEditing({ schedule: null })}>
      Yeni zamanlama
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        title="Zamanlama"
        description="Hangi listenin hangi gün ve saatlerde oynatılacağı. Zamanlama yoksa TV varsayılan listesini oynatır."
        actions={createButton}
      />

      <div className="flex flex-col gap-4">
        <HowItWorks />

        {schedules.isPending ? (
          <LoadingState />
        ) : schedules.isError && schedules.data === undefined ? (
          <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />
        ) : all.length === 0 ? (
          <EmptyState icon={CalendarClock} title="Henüz zamanlama yok" action={createButton}>
            Ör. öğle saatlerinde menü listesini oynatmak için hafta içi 11:30–14:00 arası bir zamanlama ekleyin. Diğer
            saatlerde TV varsayılan listesine döner.
          </EmptyState>
        ) : (
          <>
            {targets.length > 1 && (
              <Select
                aria-label="Hedefe göre filtrele"
                value={targetFilter}
                onChange={(event) => setTargetFilter(event.target.value)}
                className="w-full sm:w-64"
              >
                <option value="">Tüm hedefler</option>
                {targets.map(([key, name]) => (
                  <option key={key} value={key}>
                    {key.startsWith("device:") ? `TV: ${name}` : `Konum: ${name}`}
                  </option>
                ))}
              </Select>
            )}
            <div className="panel overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Hedef</th>
                    <th scope="col">Liste</th>
                    <th scope="col">Ne zaman</th>
                    <th scope="col" className="text-right">
                      Öncelik
                    </th>
                    <th scope="col">
                      <span className="sr-only">İşlemler</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((schedule) => {
                    const editable = canEditSchedule(me, schedule, deviceLocation);
                    return (
                      <tr key={schedule.id}>
                        <td className="max-w-56">
                          <TargetCell schedule={schedule} />
                        </td>
                        <td className="font-medium">
                          <Link to={`/playlists/${schedule.playlistId}`} className="hover:text-accent hover:underline">
                            {schedule.playlistName}
                          </Link>
                        </td>
                        <td>{summarizeSchedule(schedule)}</td>
                        <td className="text-right tabular-nums">{schedule.priority}</td>
                        <td className="w-0 whitespace-nowrap">
                          {editable && (
                            <div className="flex justify-end gap-0.5">
                              <IconButton size="sm" icon={Pencil} label="Düzenle" onClick={() => setEditing({ schedule })} />
                              <IconButton
                                size="sm"
                                icon={Trash}
                                label="Sil"
                                variant="danger-ghost"
                                onClick={() => {
                                  remove.reset();
                                  setDeleting(schedule);
                                }}
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {editing !== null && (
        <ScheduleFormDialog
          key={editing.schedule?.id ?? "new"}
          open
          schedule={editing.schedule}
          onClose={() => setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Zamanlama silinsin mi?"
        confirmLabel="Zamanlamayı sil"
        pending={remove.isPending}
        error={remove.isError ? remove.error : null}
        onConfirm={() => {
          if (deleting === null) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success("Zamanlama silindi.");
              setDeleting(null);
            },
          });
        }}
      >
        {deleting !== null && (
          <p>
            {deleting.targetName} için “{deleting.playlistName}”, {summarizeSchedule(deleting)}. Silindiğinde bu saatlerde TV
            varsayılan listesine ya da başka bir zamanlamaya döner.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
