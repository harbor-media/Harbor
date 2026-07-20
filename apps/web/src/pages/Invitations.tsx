import { roleRank, type RegistrationMode, type UserRole } from "@harbor/shared";
import { type FormEvent, type JSX, useState } from "react";
import { useCurrentUser } from "../auth";
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
        <h1 className="font-display text-2xl text-accent-500">Invitations</h1>

        <section className="mt-6 rounded-card bg-harbor-900 p-8">
          <h2 className="font-display text-lg">Create an invitation</h2>
          <form className="mt-4" onSubmit={onCreate}>
            <label className="block text-sm" htmlFor="role">
              Role
            </label>
            <select
              id="role"
              className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              {grantable.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>

            <label className="mt-4 block text-sm" htmlFor="email">
              Email (optional)
            </label>
            <input
              id="email"
              type="email"
              className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <label className="mt-4 block text-sm" htmlFor="maxUses">
              Max uses
            </label>
            <input
              id="maxUses"
              type="number"
              min={1}
              className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
            />

            <label className="mt-4 block text-sm" htmlFor="expiresInDays">
              Expires in days (optional)
            </label>
            <input
              id="expiresInDays"
              type="number"
              min={1}
              className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />

            <button
              type="submit"
              className="mt-6 w-full rounded bg-accent-500 p-2 font-medium disabled:opacity-50"
              disabled={createInvitation.isPending || grantable.length === 0}
            >
              {createInvitation.isPending ? "Creating…" : "Create invitation"}
            </button>
          </form>

          {grantable.length === 0 ? (
            <p role="status" className="mt-4 text-sm opacity-80">
              Your role cannot grant any invitations.
            </p>
          ) : null}

          {createInvitation.isError ? (
            <p role="alert" aria-live="assertive" className="mt-4 text-sm text-red-400">
              {createInvitation.error.message}
            </p>
          ) : null}

          {inviteUrl !== null ? (
            <div className="mt-4">
              <label className="block text-sm" htmlFor="inviteUrl">
                Invite link (shown once — copy it now)
              </label>
              <input
                id="inviteUrl"
                readOnly
                className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
                value={inviteUrl}
              />
              <button
                type="button"
                className="mt-2 w-full rounded bg-harbor-800 p-2 font-medium"
                onClick={() => {
                  void navigator.clipboard.writeText(inviteUrl).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : null}
        </section>

        <section className="mt-6 rounded-card bg-harbor-900 p-8">
          <h2 className="font-display text-lg">Registration mode</h2>
          <label className="mt-4 block text-sm" htmlFor="registrationMode">
            Mode
          </label>
          <select
            id="registrationMode"
            className="mt-1 w-full rounded bg-harbor-950 p-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
            value={registrationMode.data ?? "invitation-only"}
            onChange={(e) => onModeSelect(e.target.value as RegistrationMode)}
          >
            <option value="disabled">disabled</option>
            <option value="invitation-only">invitation-only</option>
            <option value="open">open</option>
          </select>

          {pendingOpenMode ? (
            <div className="mt-2 rounded bg-harbor-950 p-3">
              <p role="alert" aria-live="assertive" className="text-sm text-red-400">
                Open registration lets anyone create an account without an invitation.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="rounded bg-accent-500 px-3 py-1 font-medium"
                  onClick={onConfirmOpenMode}
                >
                  Confirm open registration
                </button>
                <button
                  type="button"
                  className="rounded bg-harbor-800 px-3 py-1 font-medium"
                  onClick={() => setPendingOpenMode(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {!pendingOpenMode && registrationMode.data === "open" ? (
            <p role="status" className="mt-2 text-sm text-red-400">
              Anyone can create an account without an invitation.
            </p>
          ) : null}

          {setRegistrationMode.isError ? (
            <p role="alert" aria-live="assertive" className="mt-2 text-sm text-red-400">
              {setRegistrationMode.error.message}
            </p>
          ) : null}
        </section>

        <section className="mt-6 rounded-card bg-harbor-900 p-8">
          <h2 className="font-display text-lg">Existing invitations</h2>
          {invitations.isPending ? <p className="mt-4">Loading…</p> : null}
          {invitations.isError ? (
            <p role="alert" aria-live="assertive" className="mt-4 text-sm text-red-400">
              {invitations.error.message}
            </p>
          ) : null}
          {invitations.data?.length === 0 ? (
            <p className="mt-4 text-sm">No invitations yet.</p>
          ) : null}
          <ul className="mt-4">
            {(invitations.data ?? []).map((invite) => (
              <li
                key={invite.id}
                className="mt-2 flex items-center justify-between rounded bg-harbor-950 p-2"
              >
                <span className="text-sm">
                  {invite.role} · {invite.status} · {invite.uses}/{invite.maxUses}
                  {invite.emailBound ? " · email-bound" : ""}
                </span>
                {invite.status === "active" ? (
                  <button
                    type="button"
                    className="rounded bg-harbor-800 px-3 py-1 font-medium disabled:opacity-50"
                    disabled={revokeInvitation.isPending}
                    onClick={() => revokeInvitation.mutate(invite.id)}
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {revokeInvitation.isError ? (
            <p role="alert" aria-live="assertive" className="mt-4 text-sm text-red-400">
              {revokeInvitation.error.message}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
