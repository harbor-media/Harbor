import { roleRank } from "@harbor/shared";
import type { JSX } from "react";
import { Link } from "react-router";
import { useCurrentUser, useLogout } from "../auth";

export function Home(): JSX.Element {
  const { data: user } = useCurrentUser();
  const logout = useLogout();
  const isAdmin = user !== null && user !== undefined && roleRank(user.role) >= roleRank("administrator");

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md rounded-card bg-harbor-900 p-8">
        <h1 className="text-2xl font-display">Harbor</h1>
        <p className="mt-3 text-sm opacity-80">
          Signed in as <span className="font-medium">{user?.username ?? "…"}</span>
          {user ? ` (${user.role})` : null}.
        </p>
        <nav className="mt-6" aria-label="Main">
          <Link
            className="block rounded bg-harbor-800 p-2 text-center font-medium focus:outline-none focus:ring-2 focus:ring-accent-500"
            to="/search"
          >
            Search
          </Link>
          {isAdmin ? (
            <>
              <Link
                className="mt-2 block rounded bg-harbor-800 p-2 text-center font-medium focus:outline-none focus:ring-2 focus:ring-accent-500"
                to="/admin/metadata"
              >
                Metadata settings
              </Link>
              <Link
                className="mt-2 block rounded bg-harbor-800 p-2 text-center font-medium focus:outline-none focus:ring-2 focus:ring-accent-500"
                to="/admin/invitations"
              >
                Invitations
              </Link>
            </>
          ) : null}
        </nav>

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
