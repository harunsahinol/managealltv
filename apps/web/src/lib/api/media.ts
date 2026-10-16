import { api } from "@managealltv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { get, requestJson, requestVoid } from "./client";
import { keys } from "./keys";

/** While anything is being processed the library refreshes on its own until it is ready or failed. */
const PROCESSING_POLL_MS = 3_000;

const path = (id: string) => `/api/media/${encodeURIComponent(id)}`;
export const mediaThumbnailUrl = (id: string) => `${path(id)}/thumbnail`;
export const mediaFileUrl = (id: string) => `${path(id)}/file`;

export function useMediaList() {
  return useQuery({
    queryKey: keys.media,
    queryFn: ({ signal }) => get("/api/media", z.array(api.Media), signal),
    refetchInterval: (query) =>
      query.state.data?.some((media) => media.status === "processing") === true ? PROCESSING_POLL_MS : false,
  });
}

export function useRenameMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      requestJson("PATCH", path(id), api.Media, { body: { name } satisfies api.MediaUpdate }),
    onSuccess: (media) => {
      queryClient.setQueryData<api.Media[]>(keys.media, (old) => old?.map((m) => (m.id === media.id ? media : m)));
      // Playlist details embed media names.
      return queryClient.invalidateQueries({ queryKey: keys.playlists });
    },
  });
}

export function useDeleteMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => requestVoid("DELETE", path(id)),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<api.Media[]>(keys.media, (old) => old?.filter((m) => m.id !== id));
      return queryClient.invalidateQueries({ queryKey: keys.media });
    },
  });
}
