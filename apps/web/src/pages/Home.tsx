import type { JSX } from "react";
import { useCurrentUser, useLogout } from "../auth";

export function Home(): JSX.Element {
  const { data: user } = useCurrentUser();
  const logout = useLogout();

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md rounded-card bg-harbor-900 p-8">
        <h1 className="text-2xl font-display">Harbor</h1>
        <p className="mt-3 text-sm opacity-80">
          Signed in as <span className="font-medium">{user?.username ?? "…"}</span>
          {user ? ` (${user.role})` : null}.
        </p>
        <p className="mt-2 text-sm opacity-60">
          The catalog arrives in Phase 3. For now this confirms authentication works.
        </p>

        <button
          type="button"
          onClick={() => {
            logout.mutate();
          }}
          disabled={logout.isPending}
          className="mt-6 w-full rounded bg-harbor-800 p-2 font-medium disabled:opacity-50"
        >
          {logout.isPending ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </main>
  );
}
