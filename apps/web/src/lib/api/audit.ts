import { api } from "@managealltv/protocol";
import { useInfiniteQuery } from "@tanstack/react-query";
import { z } from "zod";
import { get } from "./client";
import { keys } from "./keys";

export const AUDIT_PAGE_SIZE = 100;

/** Newest first; each "load more" asks for entries before the oldest one shown. */
export function useAuditLog() {
  return useInfiniteQuery({
    queryKey: keys.audit,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
      if (pageParam !== null) params.set("before", pageParam);
      return get(`/api/audit?${params.toString()}`, z.array(api.AuditEntry), signal);
    },
    getNextPageParam: (lastPage) =>
      lastPage.length < AUDIT_PAGE_SIZE ? undefined : (lastPage[lastPage.length - 1]?.at ?? undefined),
  });
}
