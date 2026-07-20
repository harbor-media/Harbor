import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthenticatedUser, LoginRequest, SetupRequest } from "@harbor/shared";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(parsed?.error?.message ?? "Request failed.");
  }
  return (await res.json()) as T;
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: async (): Promise<AuthenticatedUser | null> => {
      const res = await fetch("/api/v1/auth/me");
      if (res.status === 401) return null;
      if (!res.ok) throw new Error("Failed to load the current user.");
      const body = (await res.json()) as { user: AuthenticatedUser };
      return body.user;
    },
    retry: false,
    staleTime: 30_000,
  });
}

export function useSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupRequest) =>
      post<{ user: AuthenticatedUser }>("/api/v1/setup", input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["installation-state"] });
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginRequest) =>
      post<{ user: AuthenticatedUser }>("/api/v1/auth/login", input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    },
    onSuccess: () => queryClient.clear(),
  });
}
