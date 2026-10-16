import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Menu, X } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Button, IconButton } from "../components/ui/button";
import { cx } from "../components/ui/cx";
import { Alert, LoadingState } from "../components/ui/feedback";
import { useToast } from "../components/ui/toast";
import { errorMessage } from "../lib/api/errors";
import { keys } from "../lib/api/keys";
import { signOut } from "../lib/auth";
import { isAdmin, ROLE_LABELS } from "../lib/permissions";
import { NAV_GROUPS } from "./nav";
import { useCurrentUser } from "./session";

/** Brand mark: a tiny TV showing test-card bars. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <span aria-hidden className="relative grid h-[22px] w-[34px] place-items-center rounded-[4px] bg-bezel p-[3px]">
        <span className="color-bars block h-full w-full rounded-[2px]" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">ManageAllTV</span>
    </span>
  );
}

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  const me = useCurrentUser();
  const admin = isAdmin(me);
  return (
    <nav aria-label="Ana menü" className="flex flex-col gap-5">
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((item) => !item.adminOnly || admin);
        if (items.length === 0) return null;
        return (
          <div key={group.label}>
            <p className="px-3 pb-1.5 text-xs font-medium text-ink-3">{group.label}</p>
            <ul className="flex flex-col gap-0.5">
              {items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cx(
                        "relative flex h-9 items-center gap-2.5 rounded-control px-3 text-base transition-colors",
                        isActive
                          ? "bg-accent-soft font-medium text-accent before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-accent"
                          : "text-ink-2 hover:bg-surface-3 hover:text-ink",
                      )
                    }
                  >
                    <item.icon size={17} aria-hidden />
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function UserFooter() {
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  const logout = async () => {
    setPending(true);
    try {
      await signOut();
    } catch (error) {
      // The session may already be gone on the server; leave the panel either way.
      toast.error(errorMessage(error));
    }
    queryClient.setQueryData(keys.me, null);
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
    setPending(false);
    void navigate("/login", { replace: true });
  };

  return (
    <div className="flex items-center gap-2 border-t border-line px-3 pt-3">
      <Link to="/account" className="min-w-0 flex-1 rounded-control px-1 py-1 hover:bg-surface-3">
        <p className="truncate text-sm font-medium text-ink">{me.name}</p>
        <p className="truncate text-xs text-ink-3">{ROLE_LABELS[me.role]}</p>
      </Link>
      <Button variant="ghost" size="sm" icon={LogOut} onClick={() => void logout()} pending={pending}>
        Çıkış
      </Button>
    </div>
  );
}

/** Off-canvas menu below the lg breakpoint; native <dialog> keeps focus inside while open. */
function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label="Menü"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-0 h-dvh max-h-dvh w-72 max-w-[85vw] border-r border-line bg-surface p-0 text-ink"
    >
      {open && (
        <div className="flex h-full flex-col gap-4 py-3">
          <div className="flex items-center justify-between px-4">
            <BrandMark />
            <IconButton icon={X} label="Menüyü kapat" onClick={onClose} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2">
            <NavContent onNavigate={onClose} />
          </div>
          <UserFooter />
        </div>
      )}
    </dialog>
  );
}

export function AppShell() {
  const me = useCurrentUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Close the drawer when navigation happens by other means (back button, links in content).
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const needsTwoFactor = isAdmin(me) && !me.twoFactorEnabled && location.pathname !== "/account";

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-5 border-r border-line bg-surface py-4 lg:flex">
        <Link to="/devices" className="mx-4 rounded-control">
          <BrandMark />
        </Link>
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          <NavContent />
        </div>
        <UserFooter />
      </aside>

      <header className="sticky top-0 z-30 flex h-13 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur lg:hidden">
        <IconButton icon={Menu} label="Menüyü aç" onClick={() => setMenuOpen(true)} />
        <Link to="/devices" className="rounded-control">
          <BrandMark />
        </Link>
      </header>
      <MobileNav open={menuOpen} onClose={() => setMenuOpen(false)} />

      <main id="main" className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <div className="mx-auto max-w-[1440px]">
          {needsTwoFactor && (
            <Alert
              tone="warn"
              className="mb-5"
              title="İki adımlı doğrulamayı etkinleştirin"
              action={
                <Link to="/account" className="text-sm font-medium text-accent underline-offset-2 hover:underline">
                  Hesabım
                </Link>
              }
            >
              Yönetici hesapları her şeyi değiştirebildiği için iki adımlı doğrulama zorunludur.
            </Alert>
          )}
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
