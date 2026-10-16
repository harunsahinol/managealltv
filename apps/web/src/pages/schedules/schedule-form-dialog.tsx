import { api, TimeOfDay, type Weekday } from "@managealltv/protocol";
import { MapPin, Moon, Tv } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { cx } from "../../components/ui/cx";
import { Dialog } from "../../components/ui/dialog";
import { Field, FormError, Input, Select } from "../../components/ui/form";
import { useToast } from "../../components/ui/toast";
import { useDevices } from "../../lib/api/devices";
import { errorMessage } from "../../lib/api/errors";
import { useLocations } from "../../lib/api/locations";
import { usePlaylists } from "../../lib/api/playlists";
import { useCreateSchedule, useUpdateSchedule } from "../../lib/api/schedules";
import { inScope } from "../../lib/permissions";
import {
  scheduleFormProblems,
  sortDays,
  summarizeSchedule,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  WEEKDAYS,
  WEEKDAYS_WEEKEND,
  WEEKDAYS_WORK,
  windowKind,
} from "../../lib/schedule";
import { useCurrentUser } from "../../app/session";

export const DEFAULT_PRIORITY = 10;

interface Draft {
  playlistId: string;
  targetType: api.ScheduleTargetType;
  targetId: string;
  days: Weekday[];
  startTime: string;
  endTime: string;
  startDate: string;
  endDate: string;
  priority: string;
}

function fromSchedule(schedule: api.Schedule | null): Draft {
  if (schedule === null) {
    return {
      playlistId: "",
      targetType: "location",
      targetId: "",
      days: [...WEEKDAYS_WORK],
      startTime: "09:00",
      endTime: "18:00",
      startDate: "",
      endDate: "",
      priority: String(DEFAULT_PRIORITY),
    };
  }
  return {
    playlistId: schedule.playlistId,
    targetType: schedule.targetType,
    targetId: schedule.targetId,
    days: sortDays(schedule.days),
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    startDate: schedule.startDate ?? "",
    endDate: schedule.endDate ?? "",
    priority: String(schedule.priority),
  };
}

const PRESETS: { label: string; days: readonly Weekday[] }[] = [
  { label: "Hafta içi", days: WEEKDAYS_WORK },
  { label: "Hafta sonu", days: WEEKDAYS_WEEKEND },
  { label: "Her gün", days: WEEKDAYS },
];

export function ScheduleFormDialog({
  open,
  schedule,
  onClose,
}: {
  open: boolean;
  /** null = create. */
  schedule: api.Schedule | null;
  onClose: () => void;
}) {
  const me = useCurrentUser();
  const formId = useId();
  const playlists = usePlaylists();
  const devices = useDevices();
  const locations = useLocations();
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => fromSchedule(schedule));
  const [submitted, setSubmitted] = useState(false);
  const mutation = schedule === null ? create : update;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((old) => ({ ...old, [key]: value }));

  // Editors can only aim at their own locations (and the devices in them).
  const locationOptions = (locations.data ?? []).filter((l) => inScope(me, l.id));
  const deviceOptions = (devices.data ?? []).filter((d) => inScope(me, d.locationId));
  const targetOptions =
    draft.targetType === "device"
      ? deviceOptions.map((d) => ({ id: d.id, name: `${d.name} (${d.locationName})` }))
      : locationOptions.map((l) => ({ id: l.id, name: l.name }));

  const priority = Number(draft.priority);
  const input: api.ScheduleInput = {
    playlistId: draft.playlistId,
    targetType: draft.targetType,
    targetId: draft.targetId,
    days: sortDays(draft.days),
    startTime: draft.startTime,
    endTime: draft.endTime,
    startDate: draft.startDate === "" ? null : draft.startDate,
    endDate: draft.endDate === "" ? null : draft.endDate,
    priority: Number.isInteger(priority) ? priority : -1,
  };
  const parsed = api.ScheduleInput.safeParse(input);
  const issueFor = (field: keyof api.ScheduleInput) =>
    parsed.success ? undefined : parsed.error.issues.find((issue) => issue.path[0] === field);
  const problems = {
    playlistId: issueFor("playlistId") !== undefined ? "Bir oynatma listesi seçin." : undefined,
    targetId: issueFor("targetId") !== undefined ? (draft.targetType === "device" ? "Bir TV seçin." : "Bir konum seçin.") : undefined,
    startTime: issueFor("startTime") !== undefined ? "Başlangıç saatini girin." : undefined,
    endTime: issueFor("endTime") !== undefined ? "Bitiş saatini girin." : undefined,
    priority: issueFor("priority") !== undefined ? "0 ile 1000 arasında bir tam sayı girin." : undefined,
    ...scheduleFormProblems(input),
  };
  const valid = Object.values(problems).every((problem) => problem === undefined);
  const show = (problem: string | undefined) => (submitted ? problem : undefined);

  const timesValid = TimeOfDay.safeParse(draft.startTime).success && TimeOfDay.safeParse(draft.endTime).success;
  const kind = timesValid ? windowKind(draft.startTime, draft.endTime) : null;
  const allDay = kind === "whole_day";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!valid || !parsed.success) return;
    const done = () => {
      toast.success(schedule === null ? "Zamanlama eklendi." : "Zamanlama kaydedildi.");
      onClose();
    };
    if (schedule === null) create.mutate(parsed.data, { onSuccess: done });
    else update.mutate({ id: schedule.id, input: parsed.data }, { onSuccess: done });
  };

  const toggleDay = (day: Weekday) =>
    set("days", draft.days.includes(day) ? draft.days.filter((d) => d !== day) : sortDays([...draft.days, day]));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={schedule === null ? "Yeni zamanlama" : "Zamanlamayı düzenle"}
      size="lg"
      dismissible={!mutation.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" form={formId} variant="primary" pending={mutation.isPending}>
            {schedule === null ? "Zamanlamayı ekle" : "Değişiklikleri kaydet"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field label="Oynatma listesi" error={show(problems.playlistId)}>
          {({ id, describedBy, invalid }) => (
            <Select
              id={id}
              value={draft.playlistId}
              onChange={(event) => set("playlistId", event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            >
              <option value="">Liste seçin</option>
              {playlists.data?.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium">Hedef</legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { value: "location", label: "Konumdaki tüm TV'ler", icon: MapPin },
                { value: "device", label: "Tek bir TV", icon: Tv },
              ] as const
            ).map((option) => (
              <label
                key={option.value}
                className={cx(
                  "flex cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-base",
                  draft.targetType === option.value ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-surface-2",
                )}
              >
                <input
                  type="radio"
                  name={`${formId}-target-type`}
                  value={option.value}
                  checked={draft.targetType === option.value}
                  onChange={() => setDraft((old) => ({ ...old, targetType: option.value, targetId: "" }))}
                  className="size-4 accent-(--accent)"
                />
                <option.icon size={15} className="text-ink-2" aria-hidden />
                {option.label}
              </label>
            ))}
          </div>
          <Field label={draft.targetType === "device" ? "TV" : "Konum"} error={show(problems.targetId)}>
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                value={draft.targetId}
                onChange={(event) => set("targetId", event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              >
                <option value="">{draft.targetType === "device" ? "TV seçin" : "Konum seçin"}</option>
                {schedule !== null && draft.targetType === schedule.targetType && !targetOptions.some((o) => o.id === schedule.targetId) && (
                  <option value={schedule.targetId}>{schedule.targetName}</option>
                )}
                {targetOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium">Günler</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((day) => {
              const checked = draft.days.includes(day);
              return (
                <label
                  key={day}
                  title={WEEKDAY_LONG[day]}
                  className={cx(
                    "flex h-8 min-w-12 cursor-pointer items-center justify-center rounded-control border px-2 text-sm font-medium select-none",
                    "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                    checked ? "border-accent bg-accent text-accent-ink" : "border-line-strong text-ink-2 hover:bg-surface-2",
                  )}
                >
                  <input type="checkbox" className="sr-only" checked={checked} onChange={() => toggleDay(day)} />
                  <span aria-hidden>{WEEKDAY_SHORT[day]}</span>
                  <span className="sr-only">{WEEKDAY_LONG[day]}</span>
                </label>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-ink-3">Hızlı seçim:</span>
            {PRESETS.map((preset) => (
              <Button key={preset.label} size="sm" variant="ghost" onClick={() => set("days", [...preset.days])}>
                {preset.label}
              </Button>
            ))}
          </div>
          {draft.days.length === 0 && <p className="text-xs text-ink-3">Gün seçilmezse zamanlama her gün geçerlidir.</p>}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium">Saat</legend>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Başlangıç" error={show(problems.startTime)} className="w-32">
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="time"
                  step={60}
                  value={draft.startTime}
                  onChange={(event) => set("startTime", event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </Field>
            <Field label="Bitiş" error={show(problems.endTime)} className="w-32">
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="time"
                  step={60}
                  value={draft.endTime}
                  onChange={(event) => set("endTime", event.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </Field>
            <Button
              size="sm"
              variant={allDay ? "secondary" : "ghost"}
              className="mb-1"
              aria-pressed={allDay}
              onClick={() => setDraft((old) => (allDay ? { ...old, startTime: "09:00", endTime: "18:00" } : { ...old, startTime: "00:00", endTime: "00:00" }))}
            >
              Tüm gün
            </Button>
          </div>
          {kind === "overnight" && (
            <p className="flex items-start gap-1.5 text-sm text-ink-2">
              <Moon size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              Bitiş başlangıçtan önce olduğu için pencere gece yarısını geçer ve başladığı güne sayılır. Ör. Cuma saat{" "}
              {draft.startTime} başlayan pencere Cumartesi saat {draft.endTime} olunca biter.
            </p>
          )}
          {kind === "whole_day" && <p className="text-sm text-ink-2">Başlangıç ve bitiş aynıysa seçilen günlerin tamamı kapsanır.</p>}
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="İlk gün" optional>
            {({ id }) => (
              <Input id={id} type="date" value={draft.startDate} onChange={(event) => set("startDate", event.target.value)} />
            )}
          </Field>
          <Field label="Son gün" optional error={problems.endDate}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="date"
                value={draft.endDate}
                min={draft.startDate !== "" ? draft.startDate : undefined}
                onChange={(event) => set("endDate", event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </Field>
          <Field label="Öncelik" hint="Çakışmada büyük sayı kazanır." error={show(problems.priority)}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={1000}
                step={1}
                value={draft.priority}
                onChange={(event) => set("priority", event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </Field>
        </div>

        <div className="rounded-control border border-line bg-surface-2 px-3.5 py-2.5">
          <p className="text-sm text-ink-3">Özet</p>
          <p className="mt-0.5 text-base font-medium">
            {timesValid
              ? summarizeSchedule({
                  days: draft.days,
                  startTime: draft.startTime,
                  endTime: draft.endTime,
                  startDate: input.startDate,
                  endDate: input.endDate,
                })
              : "Saatleri girin"}
          </p>
        </div>

        <FormError message={mutation.isError ? errorMessage(mutation.error) : null} />
      </form>
    </Dialog>
  );
}
