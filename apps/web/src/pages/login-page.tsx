import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogIn } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { BrandMark } from "../app/app-shell";
import { Button } from "../components/ui/button";
import { LoadingState } from "../components/ui/feedback";
import { Checkbox, Field, FormError, Input } from "../components/ui/form";
import { errorMessage } from "../lib/api/errors";
import { keys } from "../lib/api/keys";
import { useMeQuery } from "../lib/api/me";
import { signInWithPassword, verifyBackupCode, verifyTotp } from "../lib/auth";
import { safeNextPath } from "../lib/navigation";
import { normalizeTotpCode } from "../lib/totp";

/** Centered card used by the public pages (login, invite). */
export function AuthCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex justify-center">
          <BrandMark />
        </div>
        <div className="panel overflow-hidden">
          <div className="color-bars h-1" aria-hidden />
          <div className="px-6 pt-6 pb-7">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description !== undefined && <p className="mt-1.5 text-base text-ink-2">{description}</p>}
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PasswordStep({ initialEmail, onTwoFactor, onDone }: { initialEmail: string; onTwoFactor: () => void; onDone: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await signInWithPassword(email.trim(), password);
      if (result.twoFactor) onTwoFactor();
      else onDone();
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      <Field label="E-posta">
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="email"
            autoComplete="username"
            required
            autoFocus={initialEmail === ""}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </Field>
      <Field label="Parola">
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            required
            autoFocus={initialEmail !== ""}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </Field>
      <FormError message={error} />
      <Button type="submit" variant="primary" icon={LogIn} pending={pending} disabled={email === "" || password === ""}>
        Giriş yap
      </Button>
      <p className="text-sm text-ink-3">
        Parolanızı unuttuysanız bir yöneticiden sıfırlama bağlantısı isteyin.
      </p>
    </form>
  );
}

function TwoFactorStep({ onDone, onRestart }: { onDone: () => void; onRestart: () => void }) {
  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (mode === "totp") await verifyTotp(normalizeTotpCode(code), trustDevice);
      else await verifyBackupCode(code.trim(), trustDevice);
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  const switchMode = () => {
    setMode(mode === "totp" ? "backup" : "totp");
    setCode("");
    setError(null);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      {mode === "totp" ? (
        <Field label="Doğrulama kodu" hint="Doğrulama uygulamanızdaki 6 haneli kod.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-describedby={describedBy}
              className="text-center font-mono text-lg tracking-[0.4em]"
            />
          )}
        </Field>
      ) : (
        <Field label="Yedek kod" hint="İki adımlı doğrulamayı açarken kaydettiğiniz kodlardan biri. Her kod bir kez kullanılır.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-describedby={describedBy}
              className="font-mono"
            />
          )}
        </Field>
      )}
      <Checkbox
        label="Bu tarayıcıya 30 gün güven"
        description="Ortak kullanılan bilgisayarlarda işaretlemeyin."
        checked={trustDevice}
        onChange={(event) => setTrustDevice(event.target.checked)}
      />
      <FormError message={error} />
      <Button type="submit" variant="primary" icon={KeyRound} pending={pending} disabled={code.trim() === ""}>
        Doğrula
      </Button>
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <button type="button" onClick={switchMode} className="font-medium text-accent hover:underline">
          {mode === "totp" ? "Yedek kod kullan" : "Doğrulama uygulamasını kullan"}
        </button>
        <button type="button" onClick={onRestart} className="text-ink-2 hover:text-ink hover:underline">
          Baştan başla
        </button>
      </div>
    </form>
  );
}

export function LoginPage() {
  const me = useMeQuery();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [step, setStep] = useState<"password" | "two-factor">("password");
  const next = safeNextPath(params.get("next"));

  const finish = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.me });
    void navigate(next, { replace: true });
  };

  if (me.isPending) return <LoadingState className="min-h-dvh" />;
  if (me.data !== null && me.data !== undefined) return <Navigate to={next} replace />;

  return step === "password" ? (
    <AuthCard title="Giriş yap" description="TV'lerinizi yönetmek için hesabınızla giriş yapın.">
      <PasswordStep
        initialEmail={params.get("email") ?? ""}
        onTwoFactor={() => setStep("two-factor")}
        onDone={() => void finish()}
      />
    </AuthCard>
  ) : (
    <AuthCard title="İki adımlı doğrulama" description="Hesabınız iki adımlı doğrulamayla korunuyor.">
      <TwoFactorStep onDone={() => void finish()} onRestart={() => setStep("password")} />
    </AuthCard>
  );
}
