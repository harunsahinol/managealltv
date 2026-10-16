import type { api, Command } from "@managealltv/protocol";
import { Crosshair, Power, RefreshCw, RotateCw, Volume2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useSendCommand } from "../../lib/api/devices";
import { errorMessage } from "../../lib/api/errors";
import { commandSentMessage } from "../../lib/devices";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Dialog } from "../ui/dialog";
import { Field, FormError, Input } from "../ui/form";
import { useToast } from "../ui/toast";

const IDENTIFY_SECONDS = 30;

type Confirmable = "restart_app" | "reboot";

function VolumeDialog({
  open,
  onClose,
  initial,
  onSend,
  pending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  initial: number;
  onSend: (volume: number) => void;
  pending: boolean;
  error: unknown;
}) {
  const formId = useId();
  const [volume, setVolume] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend(volume);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Ses seviyesini ayarla"
      size="sm"
      dismissible={!pending}
      description="TV'nin ses seviyesini bir kez değiştirir. Kalıcı bir seviye için ayarlardaki “Ses” alanını kullanın."
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" form={formId} variant="primary" icon={Volume2} pending={pending}>
            Sesi {volume} yap
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Ses seviyesi (0–100)">
          {({ id }) => (
            <div className="flex items-center gap-3">
              <input
                id={id}
                type="range"
                min={0}
                max={100}
                step={1}
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
                className="h-2 flex-1 accent-(--accent)"
              />
              <Input
                type="number"
                min={0}
                max={100}
                aria-label="Ses seviyesi"
                value={volume}
                onChange={(event) => setVolume(Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))))}
                className="w-20 text-center"
              />
            </div>
          )}
        </Field>
        {error !== null && error !== undefined && <FormError message={errorMessage(error)} />}
      </form>
    </Dialog>
  );
}

/**
 * Remote commands. Non-disruptive ones (reload, identify) go out immediately; restarting the app or
 * the TV interrupts what people are watching, so those ask first.
 */
export function DeviceCommands({ device }: { device: api.Device }) {
  const send = useSendCommand(device.id);
  const toast = useToast();
  const [confirm, setConfirm] = useState<Confirmable | null>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [pendingType, setPendingType] = useState<Command["type"] | null>(null);

  const run = (command: Command, after?: () => void) => {
    setPendingType(command.type);
    send.mutate(command, {
      onSuccess: (view) => {
        toast.success(commandSentMessage(view));
        after?.();
      },
      onError: (error) => {
        // Dialog-based commands show the error inside their dialog.
        if (after === undefined) toast.error(errorMessage(error));
      },
      onSettled: () => setPendingType(null),
    });
  };

  const deviceOwner = device.status?.deviceOwner ?? false;
  const busy = (type: Command["type"]) => pendingType === type && send.isPending;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button icon={RefreshCw} pending={busy("reload")} onClick={() => run({ type: "reload" })}>
          Yenile
        </Button>
        <Button icon={Crosshair} pending={busy("identify")} onClick={() => run({ type: "identify", durationSec: IDENTIFY_SECONDS })}>
          Tanımla
        </Button>
        <Button
          icon={Volume2}
          onClick={() => {
            send.reset();
            setVolumeOpen(true);
          }}
        >
          Ses
        </Button>
        <Button
          icon={RotateCw}
          onClick={() => {
            send.reset();
            setConfirm("restart_app");
          }}
        >
          Uygulamayı yeniden başlat
        </Button>
        <Button
          icon={Power}
          variant="danger-ghost"
          disabled={!deviceOwner}
          aria-describedby={!deviceOwner ? `reboot-hint-${device.id}` : undefined}
          onClick={() => {
            send.reset();
            setConfirm("reboot");
          }}
        >
          Yeniden başlat
        </Button>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-ink-3">
        <li>Yenile: TV içerik listesini sunucudan yeniden alır. Tanımla: TV'nin adı {IDENTIFY_SECONDS} saniye ekranda görünür.</li>
        {!deviceOwner && (
          <li id={`reboot-hint-${device.id}`}>
            Yeniden başlatma yalnız uygulama cihaz sahibi (Device Owner) olarak kurulduysa çalışır.
          </li>
        )}
        {!device.online && <li>TV çevrimdışı. Komutlar sıraya alınır ve TV 10 dakika içinde bağlanırsa iletilir.</li>}
      </ul>

      <VolumeDialog
        open={volumeOpen}
        onClose={() => setVolumeOpen(false)}
        initial={device.status?.volume ?? device.volume ?? 50}
        pending={send.isPending}
        error={send.isError ? send.error : null}
        onSend={(volume) => run({ type: "set_volume", volume }, () => setVolumeOpen(false))}
      />

      <ConfirmDialog
        open={confirm === "restart_app"}
        onClose={() => setConfirm(null)}
        title="Uygulama yeniden başlatılsın mı?"
        confirmLabel="Yeniden başlat"
        tone="primary"
        pending={send.isPending}
        error={send.isError ? send.error : null}
        onConfirm={() => run({ type: "restart_app" }, () => setConfirm(null))}
      >
        <p>
          “{device.name}” ekranındaki yayın birkaç saniye kesilir, sonra uygulama kaldığı listeden devam eder.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "reboot"}
        onClose={() => setConfirm(null)}
        title="TV yeniden başlatılsın mı?"
        confirmLabel="TV'yi yeniden başlat"
        pending={send.isPending}
        error={send.isError ? send.error : null}
        onConfirm={() => run({ type: "reboot" }, () => setConfirm(null))}
      >
        <p>
          “{device.name}” tamamen kapanıp açılır; yayın yaklaşık bir dakika kesilir. TV açıldığında uygulama kendiliğinden
          başlar.
        </p>
      </ConfirmDialog>
    </div>
  );
}
