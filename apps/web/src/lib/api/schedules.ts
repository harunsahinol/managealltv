import { api } from "@managealltv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { get, requestJson, requestVoid } from "./client";
import { keys } from "./keys";

const path = (id: string) => `/api/schedules/${encodeURIComponent(id)}`;

export function useSchedules() {
  return useQuery({
    queryKey: keys.schedules,
    queryFn: ({ signal }) => get("/api/schedules", z.array(api.Schedule), signal),
    staleTime: 15_000,
  });
}

function useInvalidateScheduleViews() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.schedules }),
      // expectedPlaylistId and manifest versions depend on the schedule.
      queryClient.invalidateQueries({ queryKey: keys.devices }),
    ]);
}

export function useCreateSchedule() {
  const invalidate = useInvalidateScheduleViews();
  return useMutation({
    mutationFn: (input: api.ScheduleInput) => requestJson("POST", "/api/schedules", api.Schedule, { body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateSchedule() {
  const invalidate = useInvalidateScheduleViews();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<api.ScheduleInput> }) =>
      requestJson("PATCH", path(id), api.Schedule, { body: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteSchedule() {
  const invalidate = useInvalidateScheduleViews();
  return useMutation({
    mutationFn: (id: string) => requestVoid("DELETE", path(id)),
    onSuccess: invalidate,
  });
}
