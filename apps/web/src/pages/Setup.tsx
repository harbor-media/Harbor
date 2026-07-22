import { type FormEvent, type JSX, useState } from "react";
import { useSetup } from "../auth";
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
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <form onSubmit={onSubmit} className="w-full max-w-md">
        <Card className="p-8">
          <h1 className="font-display text-2xl text-foreground">Welcome to Harbor</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Create the owner account for this server.
          </p>

          <Label className="mt-6 block" htmlFor="serverName">
            Server name
          </Label>
          <Input id="serverName" required className="mt-1" {...field("serverName")} />

          <Label className="mt-4 block" htmlFor="username">
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
            {...field("username")}
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
            {...field("email")}
          />

          <Label className="mt-4 block" htmlFor="password">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            aria-describedby="password-hint"
            className="mt-1"
            {...field("password")}
          />
          <p id="password-hint" className="mt-1 text-xs text-muted-foreground">
            At least 12 characters.
          </p>

          {setup.isError && (
            <Alert variant="destructive" aria-live="assertive" className="mt-4">
              <AlertDescription>{setup.error.message}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" isDisabled={setup.isPending} className="mt-6 w-full">
            {setup.isPending ? "Creating…" : "Create owner account"}
          </Button>
        </Card>
      </form>
    </main>
  );
}
