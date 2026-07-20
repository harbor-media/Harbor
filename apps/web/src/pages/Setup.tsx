import { type FormEvent, type JSX, useState } from "react";
import { useSetup } from "../auth";

const USERNAME_PATTERN = "^[a-zA-Z0-9._-]+$";

export function Setup(): JSX.Element {
  const setup = useSetup();
  const [form, setForm] = useState({
    language: "en",
    serverName: "",
    username: "",
    email: "",
    password: "",
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    setup.mutate(form);
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-card bg-harbor-900 p-8">
        <h1 className="font-display text-2xl">Welcome to Harbor</h1>
        <p className="mt-2 text-sm opacity-80">Create the owner account for this server.</p>

        <label className="mt-6 block text-sm" htmlFor="serverName">
          Server name
        </label>
        <input
          id="serverName"
          required
          className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
          {...field("serverName")}
        />

        <label className="mt-4 block text-sm" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          required
          minLength={3}
          maxLength={32}
          pattern={USERNAME_PATTERN}
          autoComplete="username"
          aria-describedby="username-hint"
          className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
          {...field("username")}
        />
        <p id="username-hint" className="mt-1 text-xs opacity-60">
          3–32 characters. Letters, numbers, dots, underscores, and hyphens only. No &quot;@&quot;.
        </p>

        <label className="mt-4 block text-sm" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
          {...field("email")}
        />

        <label className="mt-4 block text-sm" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          aria-describedby="password-hint"
          className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
          {...field("password")}
        />
        <p id="password-hint" className="mt-1 text-xs opacity-60">
          At least 12 characters.
        </p>

        {setup.isError && (
          <p role="alert" aria-live="assertive" className="mt-4 text-sm text-red-400">
            {setup.error.message}
          </p>
        )}

        <button
          type="submit"
          disabled={setup.isPending}
          className="mt-6 w-full rounded bg-accent-500 p-2 font-medium disabled:opacity-50"
        >
          {setup.isPending ? "Creating…" : "Create owner account"}
        </button>
      </form>
    </main>
  );
}
