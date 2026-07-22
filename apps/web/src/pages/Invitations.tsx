import { roleRank, type RegistrationMode, type UserRole } from "@harbor/shared";
import { type FormEvent, type JSX, useState } from "react";
import { useCurrentUser } from "../auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCreateInvitation,
  useInvitations,
  useRegistrationMode,
  useRevokeInvitation,
  useSetRegistrationMode,
} from "../invitations";

const GRANTABLE: UserRole[] = ["administrator", "user", "guest"];

export function Invitations(): JSX.Element {
  const currentUser = useCurrentUser();
  const invitations = useInvitations();
  const createInvitation = useCreateInvitation();
  const revokeInvitation = useRevokeInvitation();
  const registrationMode = useRegistrationMode();
  const setRegistrationMode = useSetRegistrationMode();

  const myRole = currentUser.data?.role ?? "user";
  const grantable = GRANTABLE.filter((r) => roleRank(r) < roleRank(myRole));

  const [role, setRole] = useState<UserRole>(grantable[0] ?? "user");
  const [email, setEmail] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingOpenMode, setPendingOpenMode] = useState(false);

  async function onCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    setCopied(false);
    const result = await createInvitation.mutateAsync({
      role: role as Exclude<UserRole, "owner">,
      email: email.trim() === "" ? undefined : email.trim(),
      maxUses: Number(maxUses),
      expiresInDays: expiresInDays.trim() === "" ? undefined : Number(expiresInDays),
    });
    setInviteUrl(result.inviteUrl);
    setEmail("");
  }

  function onModeSelect(next: RegistrationMode): void {
    if (next === "open") {
      setPendingOpenMode(true);
      return;
    }
    setPendingOpenMode(false);
    setRegistrationMode.mutate({ mode: next });
  }

  function onConfirmOpenMode(): void {
    setPendingOpenMode(false);
    setRegistrationMode.mutate({ mode: "open", acknowledgeOpenRisk: true });
  }

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="font-display text-2xl text-foreground">Invitations</h1>

        <Card className="mt-6 p-8">
          <h2 className="font-display text-lg">Create an invitation</h2>
          <form className="mt-4" onSubmit={onCreate}>
            <Select
              className="w-full"
              selectedKey={role}
              onSelectionChange={(key) => {
                setRole(String(key) as UserRole);
              }}
            >
              {/* The label lives inside Select, not beside it with htmlFor.
                  React Aria points the trigger's aria-labelledby at the slot
                  label, and aria-labelledby beats aria-label -- so a label
                  placed outside leaves the control announced as its bare
                  value, with no field name at all. */}
              <Label className="block">Role</Label>
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {grantable.map((r) => (
                  <SelectItem key={r} id={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label className="mt-4 block" htmlFor="email">
              Email (optional)
            </Label>
            <Input
              id="email"
              type="email"
              className="mt-1"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <Label className="mt-4 block" htmlFor="maxUses">
              Max uses
            </Label>
            <Input
              id="maxUses"
              type="number"
              min={1}
              className="mt-1"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
            />

            <Label className="mt-4 block" htmlFor="expiresInDays">
              Expires in days (optional)
            </Label>
            <Input
              id="expiresInDays"
              type="number"
              min={1}
              className="mt-1"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />

            <Button
              type="submit"
              className="mt-6 w-full"
              isDisabled={createInvitation.isPending || grantable.length === 0}
            >
              {createInvitation.isPending ? "Creating…" : "Create invitation"}
            </Button>
          </form>

          {grantable.length === 0 ? (
            <p role="status" className="mt-4 text-sm opacity-80">
              Your role cannot grant any invitations.
            </p>
          ) : null}

          {createInvitation.isError ? (
            <Alert variant="destructive" aria-live="assertive" className="mt-4">
              <AlertDescription>{createInvitation.error.message}</AlertDescription>
            </Alert>
          ) : null}

          {inviteUrl !== null ? (
            <div className="mt-4">
              <Label className="block" htmlFor="inviteUrl">
                Invite link (shown once — copy it now)
              </Label>
              <Input
                id="inviteUrl"
                readOnly
                className="mt-1"
                value={inviteUrl}
              />
              <Button
                type="button"
                variant="secondary"
                className="mt-2 w-full"
                onPress={() => {
                  void navigator.clipboard.writeText(inviteUrl).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : null}
        </Card>

        <Card className="mt-6 p-8">
          <h2 className="font-display text-lg">Registration mode</h2>
          <Select
            className="mt-4 w-full"
            selectedKey={registrationMode.data ?? "invitation-only"}
            onSelectionChange={(key) => {
              onModeSelect(String(key) as RegistrationMode);
            }}
          >
            <Label className="block">Mode</Label>
            <SelectTrigger className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem id="disabled">disabled</SelectItem>
              <SelectItem id="invitation-only">invitation-only</SelectItem>
              <SelectItem id="open">open</SelectItem>
            </SelectContent>
          </Select>

          {pendingOpenMode ? (
            <div className="mt-2 rounded-lg bg-background p-3">
              <Alert variant="destructive" aria-live="assertive">
              <AlertDescription>Open registration lets anyone create an account without an invitation.</AlertDescription>
            </Alert>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onPress={onConfirmOpenMode}
                >
                  Confirm open registration
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onPress={() => setPendingOpenMode(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {!pendingOpenMode && registrationMode.data === "open" ? (
            <p role="status" className="mt-2 text-sm text-destructive">
              Anyone can create an account without an invitation.
            </p>
          ) : null}

          {setRegistrationMode.isError ? (
            <Alert variant="destructive" aria-live="assertive" className="mt-2">
              <AlertDescription>{setRegistrationMode.error.message}</AlertDescription>
            </Alert>
          ) : null}
        </Card>

        <Card className="mt-6 p-8">
          <h2 className="font-display text-lg">Existing invitations</h2>
          {invitations.isPending ? <p className="mt-4">Loading…</p> : null}
          {invitations.isError ? (
            <Alert variant="destructive" aria-live="assertive" className="mt-4">
              <AlertDescription>{invitations.error.message}</AlertDescription>
            </Alert>
          ) : null}
          {invitations.data?.length === 0 ? (
            <p className="mt-4 text-sm">No invitations yet.</p>
          ) : null}
          <ul className="mt-4">
            {(invitations.data ?? []).map((invite) => (
              <li
                key={invite.id}
                className="mt-2 flex items-center justify-between rounded-lg bg-background p-2"
              >
                <span className="text-sm">
                  {invite.role} · {invite.status} · {invite.uses}/{invite.maxUses}
                  {invite.emailBound ? " · email-bound" : ""}
                </span>
                {invite.status === "active" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    isDisabled={revokeInvitation.isPending}
                    onPress={() => revokeInvitation.mutate(invite.id)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {revokeInvitation.isError ? (
            <Alert variant="destructive" aria-live="assertive" className="mt-4">
              <AlertDescription>{revokeInvitation.error.message}</AlertDescription>
            </Alert>
          ) : null}
        </Card>
      </div>
    </main>
  );
}
