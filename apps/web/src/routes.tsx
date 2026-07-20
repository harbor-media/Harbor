import { roleRank } from "@harbor/shared";
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router";
import { fetchInstallationState } from "./api";
import { useCurrentUser } from "./auth";
import { Home } from "./pages/Home";
import { Invitations } from "./pages/Invitations";
import { Login } from "./pages/Login";
import { Setup } from "./pages/Setup";

function useInstallationState() {
  return useQuery({
    queryKey: ["installation-state"],
    queryFn: ({ signal }) => fetchInstallationState(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 2,
  });
}

function RootLayout(): JSX.Element {
  const location = useLocation();
  const install = useInstallationState();
  const currentUser = useCurrentUser();

  if (install.isPending || currentUser.isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center" role="status">
        Starting Harbor…
      </main>
    );
  }

  if (install.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center" role="alert">
        Harbor is unavailable. Check the server logs.
      </main>
    );
  }

  const onSetup = location.pathname === "/setup";
  const onLogin = location.pathname === "/login";
  const signedIn = currentUser.data !== null && currentUser.data !== undefined;

  if (!install.data.setupComplete) {
    return onSetup ? <Outlet /> : <Navigate to="/setup" replace />;
  }
  if (onSetup) return <Navigate to={signedIn ? "/home" : "/login"} replace />;
  if (!signedIn) return onLogin ? <Outlet /> : <Navigate to="/login" replace />;
  if (onLogin) return <Navigate to="/home" replace />;

  const onAdmin = location.pathname.startsWith("/admin");
  if (onAdmin && currentUser.data && roleRank(currentUser.data.role) < roleRank("administrator")) {
    return <Navigate to="/home" replace />;
  }

  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      { index: true, Component: () => <Navigate to="/home" replace /> },
      { path: "setup", Component: Setup },
      { path: "login", Component: Login },
      { path: "home", Component: Home },
      { path: "admin/invitations", Component: Invitations },
    ],
  },
]);
