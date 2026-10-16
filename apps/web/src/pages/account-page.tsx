import { useQueryClient } from "@tanstack/react-query";
import { Copy, Download, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { toDataURL } from "qrcode";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useCurrentUser } from "../app/session";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Alert, Badge } from "../components/ui/feedback";
import { Field, FormError, Input } from "../components/ui/form";
import { Facts, PageHeader, Section } from "../components/ui/page";
import { useToast } from "../components/ui/toast";
import { errorMessage } from "../lib/api/errors";
import { keys } from "../lib/api/keys";
import { useLocations } from "../lib/api/locations";
import { changePassword, disableTwoFactor, enableTwoFactor, regenerateBackupCodes, verifyTotp } from "../lib/auth";
import { passwordProblems } from "../lib/passwords";
import { ROLE_LABELS } from "../lib/permissions";
import { groupSecret, normalizeTotpCode, totpSecretFromUri } from "../lib/totp";

function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const blob = new Blob([`ManageAllTV yedek kodları\n\n${text}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "managealltv-yedek-kodlar.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-2">
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-control border border-line bg-surface-2 px-4 py-3 font-mono text-base sm:grid-cols-3">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={Copy} onClick={() => void copy()}>
          {copied ? "Kopyalandı" : "Kopyala"}
        </Button>
        <Button size="sm" icon={Download} onClick={download}>
          Dosya olarak indir
        </Button>
      </div>
      <p className="text-sm text-ink-2">
        Telefonunuzu kaybederseniz bu kodlarla giriş yapabilirsiniz. Her kod bir kez kullanılır; güvenli bir yerde saklayın.
      </p>
    </div>
  );
}

function PasswordPrompt({
  formId,
  onSubmit,
  error,
  hint,
}: {
  formId: string;
  onSubmit: (password: string) => void;
  error: unknown;
  hint: string;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      id={formId}
      onSubmit={(event) => {
        event.preventDefault();
        if (password !== "") onSubmit(password);
      }}
      className="flex flex-col gap-3"
    >
      <Field label="Parolanız" hint={hint}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </Field>
      <FormError message={error !== null ? errorMessage(error) : null} />
    </form>
  );
}

type SetupState =
  | { step: "password" }
  | { step: "scan"; totpURI: string; backupCodes: string[] }
  | { step: "done"; backupCodes: string[] };

function EnableTwoFactorDialog({ onClose }: { onClose: () => void }) {
  const formId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<SetupState>({ step: "password" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const totpURI = state.step === "scan" ? state.totpURI : null;
  useEffect(() => {
    if (totpURI === null) return;
    let cancelled = false;
    toDataURL(totpURI, { margin: 1, width: 220, errorCorrectionLevel: "M" })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => setQr(null));
    return () => {
      cancelled = true;
    };
  }, [totpURI]);

  const start = async (password: string) => {
    setPending(true);
    setError(null);
    try {
      const result = await enableTwoFactor(password);
      setState({ step: "scan", totpURI: result.totpURI, backupCodes: result.backupCodes });
    } catch (failure) {
      setError(failure);
    }
    setPending(false);
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (state.step !== "scan") return;
    setPending(true);
    setError(null);
    try {
      await verifyTotp(normalizeTotpCode(code));
      await queryClient.invalidateQueries({ queryKey: keys.me });
      setState({ step: "done", backupCodes: state.backupCodes });
      toast.success("İki adımlı doğrulama açıldı.");
    } catch (failure) {
      setError(failure);
    }
    setPending(false);
  };

  const secret = totpURI !== null ? totpSecretFromUri(totpURI) : null;

  return (
    <Dialog
      open
      onClose={onClose}
      size={state.step === "password" ? "sm" : "lg"}
      dismissible={!pending}
      title={state.step === "done" ? "İki adımlı doğrulama açık" : "İki adımlı doğrulamayı aç"}
      footer={
        state.step === "done" ? (
          <Button variant="primary" onClick={onClose}>
            Kodları kaydettim
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={pending}>
              Vazgeç
            </Button>
            <Button type="submit" form={formId} variant="primary" pending={pending}>
              {state.step === "password" ? "Devam et" : "Doğrula ve aç"}
            </Button>
          </>
        )
      }
    >
      {state.step === "password" && (
        <PasswordPrompt
          formId={formId}
          onSubmit={(password) => void start(password)}
          error={error}
          hint="Güvenlik için parolanızı yeniden girin."
        />
      )}
      {state.step === "scan" && (
        <form id={formId} onSubmit={(event) => void confirm(event)} className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-[auto_minmax(0,1fr)]">
            <div className="grid size-[236px] place-items-center self-start rounded-control border border-line bg-white p-2">
              {qr !== null ? (
                <img src={qr} alt="Doğrulama uygulamasıyla taranacak QR kod" className="size-[220px]" />
              ) : (
                <span className="text-sm text-ink-3">QR kod hazırlanıyor…</span>
              )}
            </div>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-base text-ink-2">
              <li>Telefonunuzda bir doğrulama uygulaması açın (Google Authenticator, Microsoft Authenticator, 1Password vb.).</li>
              <li>
                QR kodu tarayın.
                {secret !== null && (
                  <>
                    {" "}
                    Tarayamıyorsanız anahtarı elle girin:
                    <span className="mt-1 block font-mono text-base break-all text-ink select-all">{groupSecret(secret)}</span>
                  </>
                )}
              </li>
              <li>Uygulamanın gösterdiği 6 haneli kodu aşağıya yazın.</li>
            </ol>
          </div>
          <Field label="Doğrulama kodu">
            {({ id }) => (
              <Input
                id={id}
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="w-40 text-center font-mono text-lg tracking-[0.3em]"
              />
            )}
          </Field>
          <div>
            <h3 className="mb-2 text-base font-semibold">Yedek kodlar</h3>
            <BackupCodes codes={state.backupCodes} />
          </div>
          <FormError message={error !== null ? errorMessage(error) : null} />
        </form>
      )}
      {state.step === "done" && (
        <div className="flex flex-col gap-4">
          <Alert tone="ok">Bundan sonra girişte parolanızdan sonra doğrulama uygulamasındaki kod sorulacak.</Alert>
          <BackupCodes codes={state.backupCodes} />
        </div>
      )}
    </Dialog>
  );
}

function RegenerateCodesDialog({ onClose }: { onClose: () => void }) {
  const formId = useId();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (password: string) => {
    setPending(true);
    setError(null);
    try {
      setCodes(await regenerateBackupCodes(password));
    } catch (failure) {
      setError(failure);
    }
    setPending(false);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Yeni yedek kodlar"
      size={codes === null ? "sm" : "md"}
      dismissible={!pending}
      description={codes === null ? "Yeni kodlar üretildiğinde eskileri geçersiz olur." : undefined}
      footer={
        codes === null ? (
          <>
            <Button onClick={onClose} disabled={pending}>
              Vazgeç
            </Button>
            <Button type="submit" form={formId} variant="primary" pending={pending}>
              Yeni kodlar üret
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Kodları kaydettim
          </Button>
        )
      }
    >
      {codes === null ? (
        <PasswordPrompt formId={formId} onSubmit={(password) => void submit(password)} error={error} hint="Güvenlik için parolanızı yeniden girin." />
      ) : (
        <BackupCodes codes={codes} />
      )}
    </Dialog>
  );
}

function DisableTwoFactorDialog({ onClose, admin }: { onClose: () => void; admin: boolean }) {
  const formId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (password: string) => {
    setPending(true);
    setError(null);
    try {
      await disableTwoFactor(password);
      await queryClient.invalidateQueries({ queryKey: keys.me });
      toast.success("İki adımlı doğrulama kapatıldı.");
      onClose();
    } catch (failure) {
      setError(failure);
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="İki adımlı doğrulama kapatılsın mı?"
      size="sm"
      dismissible={!pending}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" form={formId} variant="danger" pending={pending}>
            Kapat
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {admin && (
          <Alert tone="warn">Yönetici hesaplarında iki adımlı doğrulama zorunludur. Kapatırsanız en kısa sürede yeniden açın.</Alert>
        )}
        <PasswordPrompt formId={formId} onSubmit={(password) => void submit(password)} error={error} hint="Hesabınızı yalnız parolanız korur." />
      </div>
    </Dialog>
  );
}

function ChangePasswordForm() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const problems = passwordProblems(next, repeat);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (current === "" || problems.password !== undefined || problems.repeat !== undefined) return;
    setPending(true);
    setError(null);
    try {
      await changePassword(current, next);
      toast.success("Parolanız değiştirildi. Diğer cihazlardaki oturumlarınız kapatıldı.");
      setCurrent("");
      setNext("");
      setRepeat("");
      setSubmitted(false);
    } catch (failure) {
      setError(failure);
    }
    setPending(false);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex max-w-md flex-col gap-4" noValidate>
      <Field label="Mevcut parola" error={submitted && current === "" ? "Mevcut parolanızı girin." : undefined}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </Field>
      <Field label="Yeni parola" hint="En az 12 karakter." error={submitted ? problems.password : undefined}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </Field>
      <Field label="Yeni parola (tekrar)" error={submitted ? problems.repeat : undefined}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </Field>
      <FormError message={error !== null ? errorMessage(error) : null} />
      <div>
        <Button type="submit" variant="primary" icon={KeyRound} pending={pending}>
          Parolayı değiştir
        </Button>
      </div>
    </form>
  );
}

export function AccountPage() {
  const me = useCurrentUser();
  const locations = useLocations();
  const [dialog, setDialog] = useState<"enable" | "disable" | "codes" | null>(null);
  const admin = me.role === "admin";
  const locationNames = me.locationIds
    .map((id) => locations.data?.find((l) => l.id === id)?.name)
    .filter((name): name is string => name !== undefined);

  return (
    <>
      <PageHeader title="Hesabım" description="Hesap bilgileriniz, parolanız ve iki adımlı doğrulama." />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Section title="Bilgiler" description="Ad, rol ve konumları yalnız bir yönetici değiştirebilir.">
            <Facts
              items={[
                { label: "Ad", value: me.name },
                { label: "E-posta", value: me.email },
                { label: "Rol", value: ROLE_LABELS[me.role] },
                {
                  label: "Konumlar",
                  value: admin ? "Tümü" : locationNames.length > 0 ? locationNames.join(", ") : "Atanmış konum yok",
                },
              ]}
            />
          </Section>

          <Section
            title="İki adımlı doğrulama"
            description="Girişte parolaya ek olarak telefonunuzdaki doğrulama uygulamasından bir kod sorulur."
            actions={me.twoFactorEnabled ? <Badge tone="ok">Açık</Badge> : <Badge tone={admin ? "warn" : "neutral"}>Kapalı</Badge>}
          >
            {me.twoFactorEnabled ? (
              <div className="flex flex-wrap gap-2">
                <Button icon={KeyRound} onClick={() => setDialog("codes")}>
                  Yeni yedek kodlar üret
                </Button>
                <Button variant="danger-ghost" icon={ShieldOff} onClick={() => setDialog("disable")}>
                  Kapat
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {admin && (
                  <Alert tone="warn">Yönetici hesaplarında zorunludur. Parolanız ele geçse bile hesabınız korunur.</Alert>
                )}
                <div>
                  <Button variant="primary" icon={ShieldCheck} onClick={() => setDialog("enable")}>
                    İki adımlı doğrulamayı aç
                  </Button>
                </div>
              </div>
            )}
          </Section>
        </div>

        <Section title="Parola" description="Değiştirdiğinizde diğer cihazlardaki oturumlarınız kapatılır.">
          <ChangePasswordForm />
        </Section>
      </div>

      {dialog === "enable" && <EnableTwoFactorDialog onClose={() => setDialog(null)} />}
      {dialog === "codes" && <RegenerateCodesDialog onClose={() => setDialog(null)} />}
      {dialog === "disable" && <DisableTwoFactorDialog admin={admin} onClose={() => setDialog(null)} />}
    </>
  );
}
