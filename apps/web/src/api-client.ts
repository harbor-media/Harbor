import type { ErrorCode } from "@harbor/shared";

/**
 * Carries the API's stable error code alongside the message.
 *
 * The helper in ./invitations.ts keeps only the message, which is fine where
 * every failure reads the same to a user. Metadata and catalog requests are
 * different: a rejected key and an unreachable provider need opposite advice
 * ("fix your key" versus "this is not your fault"), and only the code
 * distinguishes them reliably. Message text is not a contract.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as {
      error?: { code?: ErrorCode; message?: string };
    } | null;
    throw new ApiError(parsed?.error?.code ?? null, parsed?.error?.message ?? "Request failed.");
  }
  return (await res.json()) as T;
}
