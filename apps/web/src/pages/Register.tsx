import { type FormEvent, type JSX, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useInstallationState } from "../api";
import { useRegister } from "../invitations";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
      <main className="flex min-h-screen items-center justify-center bg-background p-8" role="status">
        Loading…
      </main>
    );
  }

  if (install.isError || install.data.registrationMode !== "open") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-8">
        <Card className="w-full max-w-md p-8">
          <h1 className="font-display text-2xl text-foreground">Registration</h1>
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>Open registration is not enabled on this server.</AlertDescription>
          </Alert>
          <Link to="/login" className="mt-6 inline-block text-primary hover:underline">
            Back to sign in
          </Link>
        </Card>
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
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <form onSubmit={onSubmit} className="w-full max-w-md">
        <Card className="p-8">
          <h1 className="font-display text-2xl text-foreground">Create your account</h1>

          <Label className="mt-6 block" htmlFor="username">
            Username
          </Label>
          <Input
            id="username"
            required
            minLength={3}
            maxLength={32}
            pattern={USERNAME_PATTERN}
            autoComplete="username"
            aria-describedby="username-hint"
            className="mt-1"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <p id="username-hint" className="mt-1 text-xs text-muted-foreground">
            3–32 characters. Letters, numbers, dots, underscores, and hyphens only. No &quot;@&quot;.
          </p>

          <Label className="mt-4 block" htmlFor="email">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            className="mt-1"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <Label className="mt-4 block" htmlFor="password">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            required
            minLength={12}
            maxLength={200}
            autoComplete="new-password"
            aria-describedby="password-hint"
            className="mt-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p id="password-hint" className="mt-1 text-xs text-muted-foreground">
            At least 12 characters.
          </p>

          {register.isError && (
            <Alert variant="destructive" aria-live="assertive" className="mt-4">
              <AlertDescription>{register.error.message}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" isDisabled={register.isPending} className="mt-6 w-full">
            {register.isPending ? "Creating…" : "Create account"}
          </Button>
        </Card>
      </form>
    </main>
  );
}
