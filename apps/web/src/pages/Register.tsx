import { type FormEvent, type JSX, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useInstallationState } from "../api";
import { useRegister } from "../invitations";

// The hyphen is escaped deliberately. Browsers compile the HTML `pattern`
// attribute with the RegExp `v` flag, which rejects an unescaped trailing `-`
// in a character class as "Invalid character in character class" — the whole
// pattern is then discarded and the field silently loses client-side
// validation. The server's Zod regex is a plain RegExp and is unaffected.
const USERNAME_PATTERN = "^[a-zA-Z0-9._\\-]+$";

export function Register(): JSX.Element {
  const install = useInstallationState();
  const register = useRegister();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  if (install.isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8" role="status">
        Loading…
      </main>
    );
  }

  if (install.isError || install.data.registrationMode !== "open") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="w-full max-w-md rounded-card bg-harbor-900 p-8">
          <h1 className="font-display text-2xl">Registration</h1>
          <p role="alert" className="mt-4 text-sm text-red-400">
            Open registration is not enabled on this server.
          </p>
          <Link to="/login" className="mt-6 inline-block text-accent-500 hover:underline">
            Back to sign in
          </Link>
        </div>
      </main>
    );
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    await register.mutateAsync({
      username: username.trim(),
      email: email.trim(),
      password,
    });
    void navigate("/home", { replace: true });
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-card bg-harbor-900 p-8">
        <h1 className="font-display text-2xl">Create your account</h1>

        <label className="mt-6 block text-sm" htmlFor="username">
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
          value={username}
          onChange={(e) => setUsername(e.target.value)}
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
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label className="mt-4 block text-sm" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={12}
          maxLength={200}
          autoComplete="new-password"
          aria-describedby="password-hint"
          className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p id="password-hint" className="mt-1 text-xs opacity-60">
          At least 12 characters.
        </p>

        {register.isError && (
          <p role="alert" aria-live="assertive" className="mt-4 text-sm text-red-400">
            {register.error.message}
          </p>
        )}

        <button
          type="submit"
          disabled={register.isPending}
          className="mt-6 w-full rounded bg-accent-500 p-2 font-medium disabled:opacity-50"
        >
          {register.isPending ? "Creating…" : "Create account"}
        </button>
      </form>
    </main>
  );
}
