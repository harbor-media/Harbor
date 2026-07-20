import { roleRank } from "@harbor/shared";
import type { JSX } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router";
import { useInstallationState } from "./api";
import { useCurrentUser } from "./auth";
import { Home } from "./pages/Home";
import { Invite } from "./pages/Invite";
import { Invitations } from "./pages/Invitations";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { Setup } from "./pages/Setup";

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

  const onInvite = location.pathname.startsWith("/invite/");
  if (onInvite) {
    return signedIn ? <Navigate to="/home" replace /> : <Outlet />;
  }

  const onRegister = location.pathname === "/register";
  if (onRegister) {
    return signedIn ? <Navigate to="/home" replace /> : <Outlet />;
  }

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
      { path: "invite/:token", Component: Invite },
      { path: "register", Component: Register },
      { path: "home", Component: Home },
      { path: "admin/invitations", Component: Invitations },
    ],
  },
]);
