import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { ensureInstallationRow } from "./installation.js";
import { createUser } from "./users.js";
import { createInvitation } from "./invitations.js";
import { InvitationUnusableError, InviteEmailMismatchError, redeemInvitation } from "./redeem.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

let container: StartedPostgreSqlContainer;
let client: Awaited<ReturnType<typeof createClient>>["sql"];
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  await runMigrations(container.getConnectionUri(), migrationsFolder);
  const c = createClient(container.getConnectionUri(), { max: 10 });
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
  await ensureInstallationRow(db);
  const admin = await createUser(db, {
    username: "admin",
    email: "admin@example.com",
    passwordHash: "$argon2id$fake",
    role: "administrator",
  });
  adminId = admin.id;
});

async function useCount(hash: string): Promise<number> {
  const rows = await db.execute<{ use_count: number }>(
    sql`select use_count from invitations where token_hash = ${hash}`,
  );
  return Number(rows[0]?.use_count ?? -1);
}

describe("redeemInvitation happy path", () => {
  it("creates the user with the invited role and consumes exactly one use", async () => {
    await createInvitation(db, {
      tokenHash: "h1",
      createdBy: adminId,
      role: "user",
      email: null,
      maxUses: 1,
      expiresAt: null,
    });
    const user = await redeemInvitation(db, {
      tokenHash: "h1",
      username: "newbie",
      email: "newbie@example.com",
      passwordHash: "$argon2id$fake",
    });
    expect(user.role).toBe("user");
    expect(user.username).toBe("newbie");
    expect(await useCount("h1")).toBe(1);
  });
});

describe("redeemInvitation concurrency on a single-use invite", () => {
  it("admits exactly one of many racers; use_count never exceeds max_uses", async () => {
    await createInvitation(db, {
      tokenHash: "hrace",
      createdBy: adminId,
      role: "user",
      email: null,
      maxUses: 1,
      expiresAt: null,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        redeemInvitation(db, {
          tokenHash: "hrace",
          username: `racer-${i}`,
          email: `racer-${i}@example.com`,
          passwordHash: "$argon2id$fake",
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(await useCount("hrace")).toBe(1);

    const count = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from users where role = 'user'`,
    );
    expect(count[0]?.count).toBe("1");
  });
});

describe("redeemInvitation rollback on user-insert failure", () => {
  it("does not burn a use when the username is taken, and a retry succeeds", async () => {
    await createInvitation(db, {
      tokenHash: "h2",
      createdBy: adminId,
      role: "user",
      email: null,
      maxUses: 3,
      expiresAt: null,
    });
    await createUser(db, {
      username: "taken",
      email: "taken@example.com",
      passwordHash: "$argon2id$fake",
      role: "user",
    });

    await expect(
      redeemInvitation(db, {
        tokenHash: "h2",
        username: "taken",
        email: "fresh@example.com",
        passwordHash: "$argon2id$fake",
      }),
    ).rejects.toThrow();
    expect(await useCount("h2")).toBe(0);

    const ok = await redeemInvitation(db, {
      tokenHash: "h2",
      username: "fresh",
      email: "fresh@example.com",
      passwordHash: "$argon2id$fake",
    });
    expect(ok.username).toBe("fresh");
    expect(await useCount("h2")).toBe(1);
  });
});

describe("redeemInvitation email binding", () => {
  it("rejects a mismatched email and consumes no use", async () => {
    await createInvitation(db, {
      tokenHash: "h3",
      createdBy: adminId,
      role: "user",
      email: "bound@example.com",
      maxUses: 1,
      expiresAt: null,
    });
    await expect(
      redeemInvitation(db, {
        tokenHash: "h3",
        username: "impostor",
        email: "someone-else@example.com",
        passwordHash: "$argon2id$fake",
      }),
    ).rejects.toBeInstanceOf(InviteEmailMismatchError);
    expect(await useCount("h3")).toBe(0);
  });

  it("accepts a case-insensitive email match", async () => {
    await createInvitation(db, {
      tokenHash: "h5",
      createdBy: adminId,
      role: "user",
      email: "bound@example.com",
      maxUses: 1,
      expiresAt: null,
    });
    const user = await redeemInvitation(db, {
      tokenHash: "h5",
      username: "boundee",
      email: "Bound@Example.com",
      passwordHash: "$argon2id$fake",
    });
    expect(user.username).toBe("boundee");
    expect(await useCount("h5")).toBe(1);
  });

  it("throws InvitationUnusableError for a revoked invite", async () => {
    const inv = await createInvitation(db, {
      tokenHash: "h4",
      createdBy: adminId,
      role: "user",
      email: null,
      maxUses: 1,
      expiresAt: null,
    });
    await db.execute(sql`update invitations set revoked_at = now() where id = ${inv.id}`);
    await expect(
      redeemInvitation(db, {
        tokenHash: "h4",
        username: "late",
        email: "late@example.com",
        passwordHash: "$argon2id$fake",
      }),
    ).rejects.toBeInstanceOf(InvitationUnusableError);
    expect(await useCount("h4")).toBe(0);
  });
});
