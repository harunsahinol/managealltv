import { api } from "@managealltv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { get, requestJson, requestVoid } from "./client";
import { keys } from "./keys";

const path = (id: string) => `/api/playlists/${encodeURIComponent(id)}`;

export function usePlaylists() {
  return useQuery({
    queryKey: keys.playlists,
    queryFn: ({ signal }) => get("/api/playlists", z.array(api.Playlist), signal),
    staleTime: 15_000,
  });
}

export function usePlaylist(id: string) {
  return useQuery({
    queryKey: keys.playlist(id),
    queryFn: ({ signal }) => get(path(id), api.PlaylistDetail, signal),
  });
}

export function useCreatePlaylist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.PlaylistInput) => requestJson("POST", "/api/playlists", api.PlaylistDetail, { body: input }),
    onSuccess: (playlist) => {
      queryClient.setQueryData(keys.playlist(playlist.id), playlist);
      return queryClient.invalidateQueries({ queryKey: keys.playlists, exact: true });
    },
  });
}

export function useRenamePlaylist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      requestJson("PATCH", path(id), api.PlaylistDetail, { body: { name } satisfies api.PlaylistInput }),
    onSuccess: (playlist) => {
      queryClient.setQueryData(keys.playlist(playlist.id), playlist);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.playlists, exact: true }),
        // Schedules show the playlist name.
        queryClient.invalidateQueries({ queryKey: keys.schedules }),
      ]);
    },
  });
}

export function useSavePlaylistItems(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.PlaylistItemsInput) =>
      requestJson("PUT", `${path(id)}/items`, api.PlaylistDetail, { body: input }),
    onSuccess: (playlist) => {
      queryClient.setQueryData(keys.playlist(id), playlist);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.playlists, exact: true }),
        // playlistCount on media changes, and devices may get a new manifest version.
        queryClient.invalidateQueries({ queryKey: keys.media }),
        queryClient.invalidateQueries({ queryKey: keys.devices }),
      ]);
    },
  });
}

export function useDeletePlaylist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => requestVoid("DELETE", path(id)),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: keys.playlist(id) });
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.playlists, exact: true }),
        queryClient.invalidateQueries({ queryKey: keys.media }),
      ]);
    },
  });
}
