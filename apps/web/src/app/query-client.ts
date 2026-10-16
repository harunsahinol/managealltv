import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "../lib/api/errors";
import { keys } from "../lib/api/keys";

const isUnauthorized = (error: unknown) => error instanceof ApiRequestError && error.status === 401;

/** Client errors (4xx) will not change on retry; network and 5xx errors get two more tries. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/**
 * Drops everything cached for the previous account except the session query itself. Needed on
 * sign-in too, not only on sign-out: when a session expires the panel just redirects to /login, so
 * the old account's (location-scoped) lists stay cached and the next person signing in on the same
 * tab would see them, plus a stale 401 notice, until the first refetch finished.
 */
export function clearAccountQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
}

export function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // A session that expires mid-use: re-check /api/me, whose guard then sends the user to /login.
        if (isUnauthorized(error) && query.queryKey[0] !== keys.me[0]) {
          void queryClient.invalidateQueries({ queryKey: keys.me });
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (isUnauthorized(error)) void queryClient.invalidateQueries({ queryKey: keys.me });
      },
      // Every successful change writes an audit entry on the server.
      onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.audit }),
    }),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 5_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
  return queryClient;
}
