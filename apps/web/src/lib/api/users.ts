import { api } from "@managealltv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { get, requestJson, requestVoid } from "./client";
import { keys } from "./keys";

const path = (id: string) => `/api/users/${encodeURIComponent(id)}`;

export function useUsers() {
  return useQuery({
    queryKey: keys.users,
    queryFn: ({ signal }) => get("/api/users", z.array(api.User), signal),
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: api.UserUpdate }) =>
      requestJson("PATCH", path(id), api.User, { body: input }),
    onSuccess: (user) => {
      queryClient.setQueryData<api.User[]>(keys.users, (old) => old?.map((u) => (u.id === user.id ? user : u)));
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.users }),
        // Editing yourself (e.g. your name) changes the session view too.
        queryClient.invalidateQueries({ queryKey: keys.me }),
      ]);
    },
  });
}

export function useInviteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.InviteCreate) => requestJson("POST", "/api/users/invites", api.InviteLink, { body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.users }),
  });
}

export function useCreatePasswordReset() {
  return useMutation({
    mutationFn: (id: string) => requestJson("POST", `${path(id)}/password-reset`, api.InviteLink),
  });
}

// ---------------------------------------------------------------- public invite page

export function useInviteInfo(token: string) {
  return useQuery({
    queryKey: keys.invite(token),
    queryFn: ({ signal }) => get(`/api/invites/${encodeURIComponent(token)}`, api.InviteInfo, signal),
    retry: false,
    staleTime: Infinity,
  });
}

export function useAcceptInvite(token: string) {
  return useMutation({
    mutationFn: (input: api.InviteAccept) =>
      requestVoid("POST", `/api/invites/${encodeURIComponent(token)}/accept`, { body: input }),
  });
}
