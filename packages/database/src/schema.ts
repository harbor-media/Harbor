import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  inet,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
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

export const users = pgTable("users", {
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
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
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
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type Installation = typeof installation.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
