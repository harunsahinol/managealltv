import { api, type Command } from "@managealltv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { get, requestJson, requestVoid } from "./client";
import { keys } from "./keys";

/** Devices report every 30 s; polling at 10 s keeps the online dot and sync progress fresh. */
export const DEVICE_POLL_MS = 10_000;

const path = (id: string) => `/api/devices/${encodeURIComponent(id)}`;

export function useDevices() {
  return useQuery({
    queryKey: keys.devices,
    queryFn: ({ signal }) => get("/api/devices", z.array(api.Device), signal),
    refetchInterval: DEVICE_POLL_MS,
  });
}

export function useDevice(id: string) {
  const queryClient = useQueryClient();
  return useQuery<api.Device>({
    queryKey: keys.device(id),
    queryFn: ({ signal }) => get(path(id), api.Device, signal),
    refetchInterval: DEVICE_POLL_MS,
    // Opening a device from the list shows its row immediately while the detail loads.
    placeholderData: () => queryClient.getQueryData<api.Device[]>(keys.devices)?.find((device) => device.id === id),
  });
}

export function useDeviceCommands(id: string) {
  return useQuery({
    queryKey: keys.deviceCommands(id),
    queryFn: ({ signal }) => get(`${path(id)}/commands`, z.array(api.CommandView), signal),
    refetchInterval: DEVICE_POLL_MS,
  });
}

export function useClaimDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.DeviceClaim) => requestJson("POST", "/api/devices/claim", api.Device, { body: input }),
    onSuccess: (device) => {
      queryClient.setQueryData(keys.device(device.id), device);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.devices, exact: true }),
        queryClient.invalidateQueries({ queryKey: keys.locations }),
      ]);
    },
  });
}

export function useUpdateDevice(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.DeviceUpdate) => requestJson("PATCH", path(id), api.Device, { body: input }),
    onSuccess: (device) => {
      queryClient.setQueryData(keys.device(id), device);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.devices, exact: true }),
        // Moving a device changes location counts; renaming it changes schedule target names.
        queryClient.invalidateQueries({ queryKey: keys.locations }),
        queryClient.invalidateQueries({ queryKey: keys.schedules }),
      ]);
    },
  });
}

export function useDeleteDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => requestVoid("DELETE", path(id)),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: keys.device(id) });
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.devices, exact: true }),
        queryClient.invalidateQueries({ queryKey: keys.locations }),
        queryClient.invalidateQueries({ queryKey: keys.schedules }),
      ]);
    },
  });
}

export function useSendCommand(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: Command) => requestJson("POST", `${path(id)}/commands`, api.CommandView, { body: command }),
    onSuccess: (view) => {
      queryClient.setQueryData<api.CommandView[]>(keys.deviceCommands(id), (old) => [view, ...(old ?? [])]);
      return queryClient.invalidateQueries({ queryKey: keys.deviceCommands(id) });
    },
  });
}
