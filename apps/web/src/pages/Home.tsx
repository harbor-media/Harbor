import { roleRank } from "@harbor/shared";
import type { JSX } from "react";
import { Link } from "react-router";
import { useCurrentUser, useLogout } from "../auth";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function Home(): JSX.Element {
  const { data: user } = useCurrentUser();
  const logout = useLogout();
  const isAdmin = user !== null && user !== undefined && roleRank(user.role) >= roleRank("administrator");

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md p-8">
        <h1 className="text-2xl font-display text-foreground">Harbor</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{user?.username ?? "…"}</span>
          {user ? ` (${user.role})` : null}.
        </p>
        <nav className="mt-6" aria-label="Main">
          <Link className={buttonVariants({ variant: "secondary", className: "block w-full" })} to="/search">
            Search
          </Link>
          {isAdmin ? (
            <>
              <Link
                className={buttonVariants({ variant: "secondary", className: "mt-2 block w-full" })}
                to="/admin/metadata"
              >
                Metadata settings
              </Link>
              <Link
                className={buttonVariants({ variant: "secondary", className: "mt-2 block w-full" })}
                to="/admin/invitations"
              >
                Invitations
              </Link>
            </>
          ) : null}
        </nav>

        <Button
          type="button"
          variant="secondary"
          onPress={() => {
            logout.mutate();
          }}
          isDisabled={logout.isPending}
          className="mt-6 w-full"
        >
          {logout.isPending ? "Signing out…" : "Sign out"}
        </Button>
      </Card>
    </main>
  );
}
