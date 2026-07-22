import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

// The shell reads the session and the logout mutation. Mocking the module is
// simpler and less brittle than standing up a fake session endpoint, and the
// hooks themselves are covered by the auth tests.
const mockUser = vi.hoisted(() => ({
  current: { username: "owner", role: "owner" } as { username: string; role: string },
}));

vi.mock("../auth", () => ({
  useCurrentUser: () => ({ data: mockUser.current }),
  useLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderShell(role: "owner" | "user" = "owner"): void {
  mockUser.current = { username: "owner", role };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: JSX.Element = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/home"]}>
        <AppShell />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(ui);
}

describe("AppShell", () => {
  it("keeps unbuilt destinations reachable by keyboard and explains why they are inert", () => {
    renderShell();

    const discover = screen.getByRole("button", { name: /discover/i });

    // aria-disabled, NOT the disabled attribute. A natively disabled control
    // is removed from the tab order, so a keyboard or screen-reader user never
    // reaches it and never hears why it does nothing -- the defect recorded
    // against the title page Play button in docs/deferred-minors.md. It must
    // not be reproduced here.
    expect(discover.getAttribute("aria-disabled")).toBe("true");
    expect(discover.hasAttribute("disabled")).toBe(false);

    // And the explanation must actually be associated with it.
    const describedBy = discover.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")?.textContent).toMatch(/later phase/i);
  });

  it("does not offer admin links to a plain user", () => {
    renderShell("user");
    expect(screen.queryByRole("link", { name: /invitations/i })).toBeNull();
  });

  it("offers admin links to an administrator", () => {
    renderShell("owner");
    expect(screen.queryByRole("link", { name: /invitations/i })).not.toBeNull();
  });
});
