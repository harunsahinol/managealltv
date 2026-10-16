/** Query keys in one place so mutations invalidate exactly what they change. */
export const keys = {
  me: ["me"] as const,
  devices: ["devices"] as const,
  device: (id: string) => ["devices", id] as const,
  deviceCommands: (id: string) => ["devices", id, "commands"] as const,
  locations: ["locations"] as const,
  media: ["media"] as const,
  playlists: ["playlists"] as const,
  playlist: (id: string) => ["playlists", id] as const,
  schedules: ["schedules"] as const,
  users: ["users"] as const,
  audit: ["audit"] as const,
  invite: (token: string) => ["invite", token] as const,
};
