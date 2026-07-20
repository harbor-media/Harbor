import { type FormEvent, type JSX, useState } from "react";
import { Link } from "react-router";
import { useInstallationState } from "../api";
import { useLogin } from "../auth";

export function Login(): JSX.Element {
  const login = useLogin();
  const install = useInstallationState();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    login.mutate({ identifier, password });
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-card bg-harbor-900 p-8">
        <h1 className="font-display text-2xl">Sign in to Harbor</h1>

        <label className="mt-6 block text-sm" htmlFor="identifier">
          Username or email
        </label>
        <input
          id="identifier"
          required
          autoComplete="username"
          className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />

        <label className="mt-4 block text-sm" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {login.isError && (
          <p role="alert" aria-live="assertive" className="mt-4 text-sm text-red-400">
            {login.error.message}
          </p>
        )}

        <button
          type="submit"
          disabled={login.isPending}
          className="mt-6 w-full rounded bg-accent-500 p-2 font-medium disabled:opacity-50"
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>

        {install.data?.registrationMode === "open" && (
          <p className="mt-4 text-center text-sm">
            New here?{" "}
            <Link to="/register" className="text-accent-500 hover:underline">
              Create an account
            </Link>
          </p>
        )}
      </form>
    </main>
  );
}
