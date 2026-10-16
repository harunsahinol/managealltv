import { api } from "@managealltv/protocol";
import { Plus } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useClaimDevice } from "../../lib/api/devices";
import { errorMessage } from "../../lib/api/errors";
import { useLocations } from "../../lib/api/locations";
import { formatPairingCode, normalizePairingCode } from "../../lib/pairing";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Alert, Spinner } from "../ui/feedback";
import { Field, FormError, Input, Select } from "../ui/form";
import { useToast } from "../ui/toast";

export function ClaimDeviceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const formId = useId();
  const claim = useClaimDevice();
  const locations = useLocations();
  const navigate = useNavigate();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [locationId, setLocationId] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const close = () => {
    if (claim.isPending) return;
    claim.reset();
    setCode("");
    setName("");
    setLocationId("");
    setSubmitted(false);
    onClose();
  };

  const list = locations.data ?? [];
  const selectedLocation = locationId !== "" ? locationId : (list.length === 1 ? (list[0]?.id ?? "") : "");
  const input = { pairingCode: normalizePairingCode(code), name: name.trim(), locationId: selectedLocation };
  const parsed = api.DeviceClaim.safeParse(input);
  const fieldError = (field: keyof api.DeviceClaim): string | undefined => {
    if (!submitted || parsed.success) return undefined;
    const issue = parsed.error.issues.find((i) => i.path[0] === field);
    if (issue === undefined) return undefined;
    if (field === "pairingCode") return "TV ekranındaki 6 haneli kodu girin.";
    if (field === "name") return "TV için bir ad girin.";
    return "Bir konum seçin.";
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!parsed.success) return;
    claim.mutate(parsed.data, {
      onSuccess: (device) => {
        toast.success(`"${device.name}" eklendi. TV birkaç saniye içinde içeriği indirmeye başlar.`);
        close();
        void navigate(`/devices/${device.id}`);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="TV ekle"
      dismissible={!claim.isPending}
      description="TV'de ManageAllTV uygulamasını açın. Ekranda görünen 6 haneli kodu buraya girin; kod 15 dakika geçerlidir."
      footer={
        <>
          <Button onClick={close} disabled={claim.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" form={formId} variant="primary" icon={Plus} pending={claim.isPending} disabled={list.length === 0}>
            TV'yi ekle
          </Button>
        </>
      }
    >
      {locations.isPending ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Alert tone="warn" title="Önce bir konum ekleyin">
          Her TV bir konuma bağlıdır (zamanlama ve saat dilimi konumdan gelir).{" "}
          <Link to="/locations" onClick={close} className="font-medium text-accent hover:underline">
            Konumlar sayfasına git
          </Link>
        </Alert>
      ) : (
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Eşleştirme kodu" error={fieldError("pairingCode")}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                autoFocus
                inputMode="numeric"
                autoComplete="off"
                placeholder="000 000"
                value={formatPairingCode(normalizePairingCode(code))}
                onChange={(event) => setCode(event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className="h-12 text-center font-mono text-2xl tracking-[0.3em]"
              />
            )}
          </Field>
          <Field label="TV adı" hint="Panelde ve TV'yi tanımlarken ekranda görünür, ör. “Lobi giriş”." error={fieldError("name")}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </Field>
          <Field label="Konum" error={fieldError("locationId")}>
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                value={selectedLocation}
                onChange={(event) => setLocationId(event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              >
                <option value="">Konum seçin</option>
                {list.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <FormError message={claim.isError ? errorMessage(claim.error) : null} />
        </form>
      )}
    </Dialog>
  );
}
