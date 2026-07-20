import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AuthenticatedUser,
  CreateInvitationRequest,
  CreateInvitationResponse,
  Invitation,
  InviteInspection,
  RegisterRequest,
  RegistrationMode,
} from "@harbor/shared";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(parsed?.error?.message ?? "Request failed.");
  }
  return (await res.json()) as T;
}

export function useInvitations() {
  return useQuery({
    queryKey: ["invitations"],
    queryFn: () =>
      request<{ invitations: Invitation[] }>("GET", "/api/v1/invitations").then(
        (body) => body.invitations,
      ),
  });
}

export function useCreateInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInvitationRequest) =>
      request<CreateInvitationResponse>("POST", "/api/v1/invitations", input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["invitations"] });
    },
  });
}

export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request<{ revoked: true }>("DELETE", `/api/v1/invitations/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["invitations"] });
    },
  });
}

export function useRegistrationMode() {
  return useQuery({
    queryKey: ["registration-mode"],
    queryFn: () =>
      request<{ mode: RegistrationMode }>("GET", "/api/v1/settings/registration").then(
        (body) => body.mode,
      ),
  });
}

export function useSetRegistrationMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { mode: RegistrationMode; acknowledgeOpenRisk?: boolean }) =>
      request<{ mode: RegistrationMode }>("PATCH", "/api/v1/settings/registration", input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["registration-mode"] });
    },
  });
}

export function useInviteInspection(token: string) {
  return useQuery({
    queryKey: ["invite", token],
    queryFn: () => request<InviteInspection>("GET", `/api/v1/invitations/${token}`),
    retry: false,
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterRequest) =>
      request<{ user: AuthenticatedUser }>("POST", "/api/v1/register", input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });
}
