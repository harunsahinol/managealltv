import type { api } from "@managealltv/protocol";
import { useMemo } from "react";
import { useLocations } from "./locations";
import { useMediaList } from "./media";
import { usePlaylists } from "./playlists";

/** id → record maps for showing names next to ids (current media, active playlist, ...). */
export function useMediaIndex(): Map<string, api.Media> {
  const media = useMediaList();
  return useMemo(() => new Map((media.data ?? []).map((m) => [m.id, m])), [media.data]);
}

export function usePlaylistIndex(): Map<string, api.Playlist> {
  const playlists = usePlaylists();
  return useMemo(() => new Map((playlists.data ?? []).map((p) => [p.id, p])), [playlists.data]);
}

export function useLocationIndex(): Map<string, api.Location> {
  const locations = useLocations();
  return useMemo(() => new Map((locations.data ?? []).map((l) => [l.id, l])), [locations.data]);
}
