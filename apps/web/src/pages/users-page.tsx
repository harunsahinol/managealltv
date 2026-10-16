import { api } from "@managealltv/protocol";
import { Check, Copy, KeyRound, Pencil, UserPlus, Users } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { useCurrentUser } from "../app/session";
import { Button, IconButton } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { cx } from "../components/ui/cx";
import { Dialog } from "../components/ui/dialog";
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from "../components/ui/feedback";
import { Checkbox, Field, FormError, Input } from "../components/ui/form";
import { PageHeader } from "../components/ui/page";
import { useToast } from "../components/ui/toast";
import { errorMessage } from "../lib/api/errors";
import { useLocations } from "../lib/api/locations";
import { useCreatePasswordReset, useInviteUser, useUpdateUser, useUsers } from "../lib/api/users";
import { formatDate, formatDateTime } from "../lib/format";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "../lib/permissions";

const ROLES: api.Role[] = ["admin", "editor", "viewer"];

/** One-time link with a copy button; the panel has no e-mail server, so a person passes it on. */
function LinkBox({ link }: { link: api.InviteLink }) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard blocked (non-HTTPS origin, permissions): select the text so Ctrl+C works.
      input.current?.select();
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          ref={input}
          readOnly
          value={link.url}
          aria-label="Tek kullanımlık bağlantı"
          onFocus={(event) => event.target.select()}
          className="font-mono text-sm"
        />
        <Button variant="primary" icon={copied ? Check : Copy} onClick={() => void copy()}>
          {copied ? "Kopyalandı" : "Kopyala"}
        </Button>
      </div>
      <p className="text-sm text-ink-2">
        Bağlantı tek kullanımlıktır ve {formatDateTime(link.expiresAt)} tarihine kadar geçerlidir. Kişiye güvenli bir kanaldan
        iletin; bağlantıyı açan herkes parolayı belirleyebilir.
      </p>
    </div>
  );
}

function RolePicker({ value, onChange, name }: { value: api.Role; onChange: (role: api.Role) => void; name: string }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">Rol</legend>
      {ROLES.map((role) => (
        <label
          key={role}
          className={cx(
            "flex cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2",
            value === role ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-surface-2",
          )}
        >
          <input
            type="radio"
            name={name}
            checked={value === role}
            onChange={() => onChange(role)}
            className="mt-0.5 size-4 shrink-0 accent-(--accent)"
          />
          <span>
            <span className="block text-base font-medium">{ROLE_LABELS[role]}</span>
            <span className="block text-sm text-ink-2">{ROLE_DESCRIPTIONS[role]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function LocationPicker({ role, value, onChange }: { role: api.Role; value: string[]; onChange: (ids: string[]) => void }) {
  const locations = useLocations();
  if (role === "admin") {
    return <p className="text-sm text-ink-2">Yöneticiler tüm konumları görür; konum seçmek gerekmez.</p>;
  }
  const list = locations.data ?? [];
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">Konumlar</legend>
      {list.length === 0 ? (
        <p className="text-sm text-ink-2">Henüz konum yok. Konum atanmayan kullanıcı hiçbir TV'yi göremez.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {list.map((location) => (
            <Checkbox
              key={location.id}
              label={location.name}
              checked={value.includes(location.id)}
              onChange={(event) =>
                onChange(event.target.checked ? [...value, location.id] : value.filter((id) => id !== location.id))
              }
            />
          ))}
        </div>
      )}
      {list.length > 0 && value.length === 0 && (
        <p className="text-xs text-warn">Konum seçilmezse kullanıcı hiçbir TV'yi ve zamanlamayı göremez.</p>
      )}
    </fieldset>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const formId = useId();
  const invite = useInviteUser();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<api.Role>("editor");
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const input: api.InviteCreate = { name: name.trim(), email: email.trim(), role, locationIds: role === "admin" ? [] : locationIds };
  const parsed = api.InviteCreate.safeParse(input);
  const problem = (field: keyof api.InviteCreate) =>
    submitted && !parsed.success && parsed.error.issues.some((issue) => issue.path[0] === field);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (parsed.success) invite.mutate(parsed.data);
  };

  if (invite.isSuccess) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Davet bağlantısı hazır"
        description={`${input.name} bu bağlantıyla parolasını belirleyip giriş yapabilir.`}
        footer={
          <Button variant="primary" onClick={onClose}>
            Bitti
          </Button>
        }
      >
        <LinkBox link={invite.data} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Kullanıcı davet et"
      description="Sistem tek kullanımlık bir davet bağlantısı üretir; e-posta gönderilmez, bağlantıyı siz iletirsiniz."
      dismissible={!invite.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={invite.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" form={formId} variant="primary" icon={UserPlus} pending={invite.isPending}>
            Davet bağlantısı oluştur
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Ad soyad" error={problem("name") ? "Ad girin." : undefined}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                autoFocus
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </Field>
          <Field label="E-posta" error={problem("email") ? "Geçerli bir e-posta adresi girin." : undefined}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </Field>
        </div>
        <RolePicker value={role} onChange={setRole} name={`${formId}-role`} />
        <LocationPicker role={role} value={locationIds} onChange={setLocationIds} />
        <FormError message={invite.isError ? errorMessage(invite.error) : null} />
      </form>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose }: { user: api.User; onClose: () => void }) {
  const me = useCurrentUser();
  const formId = useId();
  const update = useUpdateUser();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<api.Role>(user.role);
  const [locationIds, setLocationIds] = useState<string[]>(user.locationIds);
  const [disabled, setDisabled] = useState(user.disabled);
  const self = user.id === me.id;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const changes: api.UserUpdate = {};
    if (name.trim() !== user.name && name.trim() !== "") changes.name = name.trim();
    if (role !== user.role) changes.role = role;
    const nextLocations = role === "admin" ? [] : locationIds;
    if ([...nextLocations].sort().join() !== [...user.locationIds].sort().join()) changes.locationIds = nextLocations;
    if (disabled !== user.disabled) changes.disabled = disabled;
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    update.mutate(
      { id: user.id, input: changes },
      {
        onSuccess: () => {
          toast.success(`${user.name} güncellendi.`);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Kullanıcıyı düzenle"
      description={user.email}
      dismissible={!update.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={update.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" form={formId} variant="primary" pending={update.isPending} disabled={name.trim() === ""}>
            Değişiklikleri kaydet
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Ad soyad">
          {({ id }) => <Input id={id} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <RolePicker value={role} onChange={setRole} name={`${formId}-role`} />
        <LocationPicker role={role} value={locationIds} onChange={setLocationIds} />
        {self ? (
          <p className="text-sm text-ink-3">Kendi hesabınızı devre dışı bırakamazsınız.</p>
        ) : (
          <Checkbox
            label="Hesap devre dışı"
            description="Kişi giriş yapamaz ve açık oturumları kapatılır. Kayıtları ve işlem geçmişi silinmez."
            checked={disabled}
            onChange={(event) => setDisabled(event.target.checked)}
          />
        )}
        {self && role !== "admin" && (
          <Alert tone="warn">Kendi rolünüzü düşürürseniz bu sayfaya erişiminizi kaybedersiniz.</Alert>
        )}
        <FormError message={update.isError ? errorMessage(update.error) : null} />
      </form>
    </Dialog>
  );
}

function PasswordResetDialog({ user, onClose }: { user: api.User; onClose: () => void }) {
  const reset = useCreatePasswordReset();
  if (reset.isSuccess) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Sıfırlama bağlantısı hazır"
        description={`${user.name} bu bağlantıyla yeni parolasını belirler; belirlediğinde tüm oturumları kapanır.`}
        footer={
          <Button variant="primary" onClick={onClose}>
            Bitti
          </Button>
        }
      >
        <LinkBox link={reset.data} />
      </Dialog>
    );
  }
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Parola sıfırlama bağlantısı oluşturulsun mu?"
      confirmLabel="Bağlantı oluştur"
      tone="primary"
      pending={reset.isPending}
      error={reset.isError ? reset.error : null}
      onConfirm={() => reset.mutate(user.id)}
    >
      <p>
        {user.name} için tek kullanımlık bir bağlantı üretilir. Mevcut parolası, bağlantı kullanılana kadar çalışmaya devam eder.
      </p>
    </ConfirmDialog>
  );
}

type Modal = { kind: "invite" } | { kind: "edit"; user: api.User } | { kind: "reset"; user: api.User } | null;

export function UsersPage() {
  const me = useCurrentUser();
  const users = useUsers();
  const locations = useLocations();
  const [modal, setModal] = useState<Modal>(null);
  const locationName = new Map((locations.data ?? []).map((l) => [l.id, l.name]));

  const inviteButton = (
    <Button variant="primary" icon={UserPlus} onClick={() => setModal({ kind: "invite" })}>
      Kullanıcı davet et
    </Button>
  );
  const list = [...(users.data ?? [])].sort(
    (a, b) => Number(a.disabled) - Number(b.disabled) || a.name.localeCompare(b.name, "tr"),
  );

  return (
    <>
      <PageHeader
        title="Kullanıcılar"
        description="Panele erişimi olan kişiler. Yeni kişiler davet bağlantısıyla katılır."
        actions={inviteButton}
      />
      {users.isPending ? (
        <LoadingState />
      ) : users.isError && users.data === undefined ? (
        <ErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={Users} title="Kullanıcı yok" action={inviteButton} />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Kişi</th>
                <th scope="col">Rol</th>
                <th scope="col">Konumlar</th>
                <th scope="col">İki adımlı doğrulama</th>
                <th scope="col">Eklenme</th>
                <th scope="col">
                  <span className="sr-only">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((user) => (
                <tr key={user.id} className={cx(user.disabled && "text-ink-3")}>
                  <td>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium">{user.name}</span>
                      {user.id === me.id && <Badge tone="info">Siz</Badge>}
                      {user.disabled && <Badge>Devre dışı</Badge>}
                    </span>
                    <span className="block text-sm text-ink-3">{user.email}</span>
                  </td>
                  <td className="whitespace-nowrap">{ROLE_LABELS[user.role]}</td>
                  <td className="max-w-64 text-ink-2">
                    {user.role === "admin"
                      ? "Tümü"
                      : user.locationIds.length === 0
                        ? "Yok"
                        : user.locationIds.map((id) => locationName.get(id) ?? "Bilinmeyen konum").join(", ")}
                  </td>
                  <td>
                    {user.twoFactorEnabled ? (
                      <Badge tone="ok">Açık</Badge>
                    ) : (
                      <Badge tone={user.role === "admin" ? "warn" : "neutral"}>Kapalı</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-ink-2">{formatDate(user.createdAt)}</td>
                  <td className="w-0 whitespace-nowrap">
                    <div className="flex justify-end gap-0.5">
                      <IconButton size="sm" icon={Pencil} label={`${user.name} düzenle`} onClick={() => setModal({ kind: "edit", user })} />
                      <IconButton
                        size="sm"
                        icon={KeyRound}
                        label={`${user.name} için parola sıfırlama bağlantısı`}
                        onClick={() => setModal({ kind: "reset", user })}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal?.kind === "invite" && <InviteDialog onClose={() => setModal(null)} />}
      {modal?.kind === "edit" && <EditUserDialog key={modal.user.id} user={modal.user} onClose={() => setModal(null)} />}
      {modal?.kind === "reset" && <PasswordResetDialog key={modal.user.id} user={modal.user} onClose={() => setModal(null)} />}
    </>
  );
}
