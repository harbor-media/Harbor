import { roleRank } from "@harbor/shared";
import type { JSX } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { useCurrentUser, useLogout } from "../auth";
import { Button } from "@/components/ui/button";

/**
 * A destination that exists in the roadmap but not yet in the app.
 *
 * Rendered with aria-disabled rather than the disabled attribute, and so it
 * stays in the tab order. A natively disabled control is unfocusable, which
 * means the explanation for why it is inert reaches nobody using a keyboard or
 * a screen reader -- the exact defect logged against the title page's Play
 * button. The "Soon" text carries the same information visually, so nothing
 * depends on colour alone.
 */
function ComingSoon({ label }: { label: string }): JSX.Element {
  const describedBy = `soon-${label.toLowerCase()}`;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-disabled="true"
        aria-describedby={describedBy}
        className="text-muted-foreground"
        onPress={() => {
          // Intentionally inert. See ComingSoon's doc comment.
        }}
      >
        {label}
        <span className="ml-2 font-mono text-[10px] tracking-widest uppercase">Soon</span>
      </Button>
      <span id={describedBy} className="sr-only">
        {label} arrives in a later phase.
      </span>
    </>
  );
}

export function AppShell(): JSX.Element {
  const { data: user } = useCurrentUser();
  const logout = useLogout();
  const isAdmin = user != null && roleRank(user.role) >= roleRank("administrator");

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    isActive
      ? "text-foreground border-b-2 border-primary pb-0.5"
      : "text-muted-foreground hover:text-foreground";

  return (
    // No bg-background here: the body already paints the canvas colour, and an
    // opaque background on this wrapper would sit in front of any page's
    // `-z-10` backdrop (the title page's) and hide it -- which is exactly what
    // it did until this was removed.
    <div className="min-h-screen">
      {/* Sticky and transparent: on /home it sits over the hero backdrop, and
          the blur keeps the labels legible over whatever artwork loads. */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur">
        <nav aria-label="Main" className="mx-auto flex max-w-[1600px] items-center gap-6 px-6 py-3">
          <Link to="/home" className="font-display text-lg tracking-tight">
            Harbor
          </Link>
          <NavLink to="/home" className={linkClass}>
            Home
          </NavLink>
          <NavLink to="/discover" className={linkClass}>
            Discover
          </NavLink>
          <ComingSoon label="Library" />
          <div className="flex-1" />
          <NavLink to="/search" className={linkClass}>
            Search
          </NavLink>
          {isAdmin ? (
            <>
              <NavLink to="/admin/metadata" className={linkClass}>
                Metadata
              </NavLink>
              <NavLink to="/admin/invitations" className={linkClass}>
                Invitations
              </NavLink>
            </>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            isDisabled={logout.isPending}
            onPress={() => {
              logout.mutate();
            }}
          >
            {logout.isPending ? "Signing out…" : "Sign out"}
          </Button>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
