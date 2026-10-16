import type { api } from "@managealltv/protocol";
import { ShieldAlert } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { Navigate, useLocation } from "react-router";
import { useMeQuery } from "../lib/api/me";
import { loginPathFor } from "../lib/navigation";
import { isAdmin } from "../lib/permissions";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback";

const CurrentUserContext = createContext<api.Me | null>(null);

/** The signed-in user. Only valid below <RequireAuth>. */
export function useCurrentUser(): api.Me {
  const me = useContext(CurrentUserContext);
  if (me === null) throw new Error("useCurrentUser must be used below RequireAuth");
  return me;
}

/** Session guard: shows the page for signed-in users, otherwise sends them to /login?next=… */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const me = useMeQuery();

  if (me.isPending) return <LoadingState className="min-h-dvh" label="Oturum kontrol ediliyor…" />;
  // Keep the panel up when a background re-check fails (network blip); only a failed first check blocks it.
  if (me.isError && me.data === undefined) {
    return (
      <div className="mx-auto max-w-lg px-4 py-20">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (me.data === null || me.data === undefined) {
    return <Navigate to={loginPathFor(location.pathname, location.search)} replace />;
  }
  return <CurrentUserContext.Provider value={me.data}>{children}</CurrentUserContext.Provider>;
}

/** Admin-only pages. The server answers 403 anyway; this avoids a page full of errors. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const me = useCurrentUser();
  if (!isAdmin(me)) {
    return (
      <EmptyState icon={ShieldAlert} title="Bu sayfa yöneticilere açık">
        Hesabınızın rolü bu sayfayı görmeye yetmiyor. Erişim gerekiyorsa bir yöneticiye başvurun.
      </EmptyState>
    );
  }
  return <>{children}</>;
}
