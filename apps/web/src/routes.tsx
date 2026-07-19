import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router";
import { fetchInstallationState } from "./api";
import { Home } from "./pages/Home";
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
  const { data, isPending, isError } = useInstallationState();

  if (isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center" role="status">
        Starting Harbor…
      </main>
    );
  }

  if (isError) {
    return (
      <main className="flex min-h-screen items-center justify-center" role="alert">
        Harbor is unavailable. Check the server logs.
      </main>
    );
  }

  const onSetup = location.pathname === "/setup";

  if (!data.setupComplete && !onSetup) return <Navigate to="/setup" replace />;
  if (data.setupComplete && onSetup) return <Navigate to="/home" replace />;

  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      { index: true, Component: () => <Navigate to="/home" replace /> },
      { path: "setup", Component: Setup },
      { path: "home", Component: Home },
    ],
  },
]);
