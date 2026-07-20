import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  inet,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["owner", "administrator", "user", "guest"]);

export const installation = pgTable(
  "installation",
  {
    id: boolean("id").primaryKey().default(true),
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true, mode: "date" }),
    serverName: text("server_name"),
    language: text("language"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("installation_singleton", sql`${t.id} = true`)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull().unique(),
    email: text("email").unique(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull(),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Application code normalizes username/email to lowercase before writing or
    // looking up (see normalize() in the identity layer), but that is convention,
    // not structure. These functional unique indexes are the structural backstop:
    // Postgres rejects a case-variant duplicate even if a future write path
    // forgets to normalize. Kept alongside the plain .unique() constraints above,
    // which are redundant once everything is stored lowercase but cost nothing
    // and document intent.
    uniqueIndex("users_username_lower_idx").on(sql`lower(${t.username})`),
    uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
    // Usernames and emails are uniquely constrained independently, so nothing
    // otherwise stops one user's username from equaling another user's email
    // (e.g. username "victim@example.com"), which would make identifier
    // lookup ambiguous. Forbidding "@" in usernames makes the two namespaces
    // structurally disjoint. Enforced in application code too (see
    // createUser in users.ts); this CHECK is the database-level backstop.
    check("users_username_no_at", sql`position('@' in ${t.username}) = 0`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    userAgent: text("user_agent"),
    ip: inet("ip"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Postgres does not automatically index foreign-key columns (only the
    // referenced side, users.id, is indexed via its primary key). Every
    // "list this user's sessions" query, "log out all devices" operation, and
    // the ON DELETE cascade sweep on user deletion needs this index to avoid a
    // sequential scan. sessions.token_hash already has a unique constraint,
    // which Postgres backs with its own btree index automatically, so it does
    // not need a second index here.
    index("sessions_user_id_idx").on(t.userId),
  ],
);

export type Installation = typeof installation.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
