import { Check, CircleCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "../components/ui/button";
import { ErrorState, LoadingState } from "../components/ui/feedback";
import { Field, FormError, Input } from "../components/ui/form";
import { errorMessage, isApiError } from "../lib/api/errors";
import { useAcceptInvite, useInviteInfo } from "../lib/api/users";
import { formatDateTime } from "../lib/format";
import { passwordProblems } from "../lib/passwords";
import { AuthCard } from "./login-page";

export function InvitePage() {
  const { token = "" } = useParams();
  const info = useInviteInfo(token);
  const accept = useAcceptInvite(token);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (info.isPending) return <LoadingState className="min-h-dvh" />;

  if (info.isError) {
    const gone = isApiError(info.error, "not_found");
    return (
      <AuthCard title={gone ? "Bağlantı geçersiz" : "Bağlantı açılamadı"}>
        {gone ? (
          <div className="flex flex-col gap-4 text-base text-ink-2">
            <p>
              Bu bağlantı kullanılmış, süresi dolmuş ya da hiç var olmamış. Bağlantılar tek kullanımlıktır ve 72 saat
              geçerlidir.
            </p>
            <p>Yöneticinizden yeni bir bağlantı isteyin.</p>
            <Link to="/login" className="font-medium text-accent hover:underline">
              Giriş sayfasına git
            </Link>
          </div>
        ) : (
          <ErrorState error={info.error} onRetry={() => void info.refetch()} className="border-0 py-4" />
        )}
      </AuthCard>
    );
  }

  const invite = info.data;
  const isReset = invite.kind === "password_reset";

  if (accept.isSuccess) {
    return (
      <AuthCard title={isReset ? "Parolanız değiştirildi" : "Hesabınız hazır"}>
        <div className="flex flex-col gap-4">
          <p className="flex items-start gap-2 text-base text-ink-2">
            <CircleCheck size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden />
            {isReset
              ? "Yeni parolanızla giriş yapabilirsiniz. Diğer cihazlardaki oturumlarınız kapatıldı."
              : "Belirlediğiniz parolayla giriş yapabilirsiniz."}
          </p>
          <Link
            to={`/login?email=${encodeURIComponent(invite.email)}`}
            className="inline-flex h-9 items-center justify-center rounded-control bg-accent px-3.5 font-medium text-accent-ink hover:bg-accent-hover"
          >
            Giriş yap
          </Link>
        </div>
      </AuthCard>
    );
  }

  const problems = passwordProblems(password, repeat);
  const valid = problems.password === undefined && problems.repeat === undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!valid) return;
    accept.mutate({ password });
  };

  return (
    <AuthCard
      title={isReset ? "Yeni parola belirleyin" : "Hesabınızı oluşturun"}
      description={
        isReset
          ? "Bir yönetici sizin için parola sıfırlama bağlantısı oluşturdu."
          : "ManageAllTV paneline davet edildiniz. Giriş için kullanacağınız parolayı belirleyin."
      }
    >
      <dl className="mb-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-control bg-surface-2 px-3.5 py-3 text-base">
        <dt className="text-ink-3">Ad</dt>
        <dd className="truncate">{invite.name}</dd>
        <dt className="text-ink-3">E-posta</dt>
        <dd className="truncate">{invite.email}</dd>
        <dt className="text-ink-3">Geçerlilik</dt>
        <dd>{formatDateTime(invite.expiresAt)} tarihine kadar</dd>
      </dl>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {/* Lets password managers save the new password under the right account. */}
        <input type="email" autoComplete="username" value={invite.email} readOnly hidden />
        <Field label="Parola" hint="En az 12 karakter. Uzun bir cümle hatırlaması kolay ve güçlü bir paroladır." error={submitted ? problems.password : undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </Field>
        <Field label="Parola (tekrar)" error={submitted ? problems.repeat : undefined}>
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
        <FormError message={accept.isError ? errorMessage(accept.error) : null} />
        <Button type="submit" variant="primary" icon={Check} pending={accept.isPending}>
          {isReset ? "Parolayı değiştir" : "Hesabı oluştur"}
        </Button>
      </form>
    </AuthCard>
  );
}
