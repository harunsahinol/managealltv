import { api } from "@managealltv/protocol";
import { useQuery } from "@tanstack/react-query";
import { ApiRequestError, requestJson } from "./client";
import { keys } from "./keys";

/** The signed-in user, or null when there is no session (401). Other errors propagate. */
export async function fetchMe(signal?: AbortSignal): Promise<api.Me | null> {
  try {
    return await requestJson("GET", "/api/me", api.Me, { signal });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) return null;
    throw error;
  }
}

export function useMeQuery() {
  return useQuery({
    queryKey: keys.me,
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof ApiRequestError && error.status < 500) && count < 2,
  });
}
