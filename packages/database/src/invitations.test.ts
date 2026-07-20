import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { ensureInstallationRow } from "./installation.js";
import { createUser } from "./users.js";
import {
  createInvitation,
  deriveInvitationStatus,
  findInvitationByTokenHash,
  listInvitations,
  revokeInvitation,
} from "./invitations.js";
import { getRegistrationMode, setRegistrationMode } from "./registration.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

let container: StartedPostgreSqlContainer;
let client: Awaited<ReturnType<typeof createClient>>["sql"];
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  await runMigrations(container.getConnectionUri(), migrationsFolder);
  const c = createClient(container.getConnectionUri(), { max: 5 });
  client = c.sql;
  db = c.db;
}, 120_000);

afterAll(async () => {
  await closeClient(client);
  await container.stop();
});

let adminId: string;

beforeEach(async () => {
  await db.execute(sql`truncate table invitations, sessions, users restart identity cascade`);
  await db.execute(sql`update installation set registration_mode = 'invitation-only'`);
  await ensureInstallationRow(db);
  const admin = await createUser(db, {
    username: "admin",
    email: "admin@example.com",
    passwordHash: "$argon2id$fake",
    role: "administrator",
  });
  adminId = admin.id;
});

describe("createInvitation / findInvitationByTokenHash", () => {
  it("round-trips an invite and normalizes a bound email to lowercase", async () => {
    const created = await createInvitation(db, {
      tokenHash: "hash-a",
      createdBy: adminId,
      role: "user",
      email: "Invited@Example.com",
      maxUses: 1,
      expiresAt: null,
    });
    expect(created.role).toBe("user");
    expect(created.useCount).toBe(0);
    expect(created.email).toBe("invited@example.com");

    const found = await findInvitationByTokenHash(db, "hash-a");
    expect(found?.id).toBe(created.id);
    expect(await findInvitationByTokenHash(db, "no-such-hash")).toBeNull();
  });
});

describe("listInvitations derived status + ordering", () => {
  it("returns newest first with active / expired / revoked / spent derived", async () => {
    const active = await createInvitation(db, {
      tokenHash: "h-active",
      createdBy: adminId,
      role: "user",
      email: null,
      maxUses: 1,
      expiresAt: null,
    });
    const expired = await createInvitation(db, {
      tokenHash: "h-expired",
      createdBy: adminId,
      role: "user",
      email: null,
      maxUses: 1,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const revoked = await createInvitation(db, {
      tokenHash: "h-revoked",
      createdBy: adminId,
      role: "user",
      email: null,
      maxUses: 1,
      expiresAt: null,
    });
    await revokeInvitation(db, revoked.id);
    const spent = await createInvitation(db, {
      tokenHash: "h-spent",
      createdBy: adminId,
      role: "user",
      email: null,
      maxUses: 1,
      expiresAt: null,
    });
    await db.execute(sql`update invitations set use_count = 1 where id = ${spent.id}`);

    const rows = await listInvitations(db);
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(active.id)).toBe("active");
    expect(byId.get(expired.id)).toBe("expired");
    expect(byId.get(revoked.id)).toBe("revoked");
    expect(byId.get(spent.id)).toBe("spent");
    // newest first: spent was created last.
    expect(rows[0]?.id).toBe(spent.id);
    // no raw token/hash leaks through the summary shape.
    expect(rows[0]).not.toHaveProperty("tokenHash");
  });
});

describe("revokeInvitation idempotency", () => {
  it("returns true on first revoke and false on a repeat", async () => {
    const inv = await createInvitation(db, {
      tokenHash: "h-rev",
      createdBy: adminId,
      role: "user",
      email: null,
      maxUses: 1,
      expiresAt: null,
    });
    expect(await revokeInvitation(db, inv.id)).toBe(true);
    expect(await revokeInvitation(db, inv.id)).toBe(false);
  });
});

describe("registration mode", () => {
  it("reads the default and round-trips a set", async () => {
    expect(await getRegistrationMode(db)).toBe("invitation-only");
    await setRegistrationMode(db, "open");
    expect(await getRegistrationMode(db)).toBe("open");
    await setRegistrationMode(db, "disabled");
    expect(await getRegistrationMode(db)).toBe("disabled");
  });
});

describe("deriveInvitationStatus precedence with overlapping conditions", () => {
  it("proves revoked takes precedence over spent and expired", () => {
    // A row that is simultaneously revoked, past expiry, and fully used
    // must return "revoked" to prove revoked wins both checks.
    const now = new Date();
    const pastDate = new Date(now.getTime() - 60_000);

    const result = deriveInvitationStatus(
      {
        revokedAt: now,
        useCount: 5,
        maxUses: 5,
        expiresAt: pastDate,
      },
      now,
    );

    expect(result).toBe("revoked");
  });

  it("proves spent takes precedence over expired", () => {
    // A row that is simultaneously fully used and past expiry (but not revoked)
    // must return "spent" to prove spent wins over expired.
    const now = new Date();
    const pastDate = new Date(now.getTime() - 60_000);

    const result = deriveInvitationStatus(
      {
        revokedAt: null,
        useCount: 10,
        maxUses: 10,
        expiresAt: pastDate,
      },
      now,
    );

    expect(result).toBe("spent");
  });
});
