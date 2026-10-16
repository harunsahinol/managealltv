import { api } from "@managealltv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { get, requestJson, requestVoid } from "./client";
import { keys } from "./keys";

export function useLocations() {
  return useQuery({
    queryKey: keys.locations,
    queryFn: ({ signal }) => get("/api/locations", z.array(api.Location), signal),
    staleTime: 30_000,
  });
}

function useInvalidateLocationViews() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.locations }),
      // Devices carry locationName and schedules carry targetName.
      queryClient.invalidateQueries({ queryKey: keys.devices }),
      queryClient.invalidateQueries({ queryKey: keys.schedules }),
    ]);
}

export function useCreateLocation() {
  const invalidate = useInvalidateLocationViews();
  return useMutation({
    mutationFn: (input: api.LocationInput) => requestJson("POST", "/api/locations", api.Location, { body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateLocation() {
  const invalidate = useInvalidateLocationViews();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<api.LocationInput> }) =>
      requestJson("PATCH", `/api/locations/${encodeURIComponent(id)}`, api.Location, { body: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteLocation() {
  const invalidate = useInvalidateLocationViews();
  return useMutation({
    mutationFn: (id: string) => requestVoid("DELETE", `/api/locations/${encodeURIComponent(id)}`),
    onSuccess: invalidate,
  });
}
