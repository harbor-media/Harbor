import { type FormEvent, type JSX, useState } from "react";
import { Link } from "react-router";
import { useInstallationState } from "../api";
import { useLogin } from "../auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <form onSubmit={onSubmit} className="w-full max-w-sm">
        <Card className="p-8">
          <h1 className="font-display text-2xl text-foreground">Sign in to Harbor</h1>

          <Label className="mt-6 block" htmlFor="identifier">
            Username or email
          </Label>
          <Input
            id="identifier"
            required
            autoComplete="username"
            className="mt-1"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />

          <Label className="mt-4 block" htmlFor="password">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            className="mt-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {login.isError && (
            <Alert variant="destructive" aria-live="assertive" className="mt-4">
              <AlertDescription>{login.error.message}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={login.isPending} className="mt-6 w-full">
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>

          {install.data?.registrationMode === "open" && (
            <p className="mt-4 text-center text-sm text-foreground">
              New here?{" "}
              <Link to="/register" className="text-primary hover:underline">
                Create an account
              </Link>
            </p>
          )}
        </Card>
      </form>
    </main>
  );
}
