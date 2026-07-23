import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  inet,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["owner", "administrator", "user", "guest"]);

export const registrationMode = pgEnum("registration_mode", [
  "disabled",
  "invitation-only",
  "open",
]);

export const installation = pgTable(
  "installation",
  {
    id: boolean("id").primaryKey().default(true),
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true, mode: "date" }),
    serverName: text("server_name"),
    language: text("language"),
    registrationMode: registrationMode("registration_mode").notNull().default("invitation-only"),
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

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRole("role").notNull(),
    email: text("email"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The database refuses use_count > max_uses structurally, so a logic bug
    // cannot over-redeem an invite even if the transaction guard were wrong.
    check("invitations_max_uses_positive", sql`${t.maxUses} >= 1`),
    check(
      "invitations_use_count_bounded",
      sql`${t.useCount} >= 0 and ${t.useCount} <= ${t.maxUses}`,
    ),
    // created_by is a foreign key; Postgres does not auto-index the referencing
    // side, and both "list an admin's invites" and the ON DELETE cascade need it.
    index("invitations_created_by_idx").on(t.createdBy),
  ],
);

export const titleType = pgEnum("title_type", ["movie", "series"]);

export const externalIdSource = pgEnum("external_id_source", ["tmdb", "imdb"]);

export const metadataProviderConfig = pgTable("metadata_provider_config", {
  providerId: text("provider_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  encryptedApiKey: text("encrypted_api_key"),
  language: text("language").notNull().default("en-US"),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const titles = pgTable(
  "titles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: titleType("type").notNull(),
    title: text("title").notNull(),
    originalTitle: text("original_title"),
    year: integer("year"),
    overview: text("overview"),
    posterPath: text("poster_path"),
    backdropPath: text("backdrop_path"),
    runtime: integer("runtime"),
    genres: jsonb("genres").$type<string[]>().notNull().default([]),
    // Distinct from fetchedAt on purpose. A row created by search holds only
    // summary fields; without this there is no way to tell "Harbor knows this
    // title exists" from "Harbor has the whole title", and the detail page
    // would either refetch on every visit or render half-empty from search
    // data.
    detailFetchedAt: timestamp("detail_fetched_at", { withTimezone: true, mode: "date" }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("titles_title_idx").on(t.title)],
);

export const titleExternalIds = pgTable(
  "title_external_ids",
  {
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    source: externalIdSource("source").notNull(),
    externalId: text("external_id").notNull(),
  },
  (t) => [
    // The natural key for a title. Upserts target this, never the display
    // title -- two films can share a name and must stay distinct rows.
    uniqueIndex("title_external_ids_source_external_idx").on(t.source, t.externalId),
    index("title_external_ids_title_idx").on(t.titleId),
  ],
);

export const metadataSearchCache = pgTable(
  "metadata_search_cache",
  {
    queryHash: text("query_hash").notNull(),
    language: text("language").notNull(),
    // Ordered: this array IS the provider's relevance ranking. Anything that
    // reads it must preserve order.
    titleIds: jsonb("title_ids").$type<string[]>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.queryHash, t.language] })],
);

export type Installation = typeof installation.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type MetadataProviderConfig = typeof metadataProviderConfig.$inferSelect;
export type Title = typeof titles.$inferSelect;
export type NewTitle = typeof titles.$inferInsert;
export type TitleExternalIdRow = typeof titleExternalIds.$inferSelect;
export type MetadataSearchCache = typeof metadataSearchCache.$inferSelect;

export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    seasonNumber: integer("season_number").notNull(),
    name: text("name"),
    overview: text("overview"),
    posterPath: text("poster_path"),
    episodeCount: integer("episode_count"),
    // Stored as text, not date: provider payloads carry "" for an unknown
    // air date as often as null, and a text column keeps that faithfully
    // instead of failing the insert.
    airDate: text("air_date"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [uniqueIndex("seasons_title_number_idx").on(t.titleId, t.seasonNumber)],
);

export const episodes = pgTable(
  "episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    episodeNumber: integer("episode_number").notNull(),
    name: text("name"),
    overview: text("overview"),
    stillPath: text("still_path"),
    runtime: integer("runtime"),
    airDate: text("air_date"),
  },
  (t) => [uniqueIndex("episodes_season_number_idx").on(t.seasonId, t.episodeNumber)],
);

/**
 * Freshness lives on its own row, separate from membership.
 *
 * Stamped on the entries instead, a kind the provider returns EMPTY would
 * store no rows, therefore hold no timestamp, therefore look permanently
 * stale -- refetching on every request forever, for the one case guaranteed
 * to keep returning nothing.
 */
export const catalogRows = pgTable("catalog_rows", {
  kind: text("kind").primaryKey(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const catalogEntries = pgTable(
  "catalog_entries",
  {
    kind: text("kind")
      .notNull()
      .references(() => catalogRows.kind, { onDelete: "cascade" }),
    // Providers return RANKED order, and that ranking is the entire
    // information content of a "Popular" row. A SELECT without an explicit
    // ORDER BY on this column is unordered in PostgreSQL no matter what
    // order the rows were inserted in.
    position: integer("position").notNull(),
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.kind, table.position] })],
);

/**
 * One row per discover type, holding that type's whole genre list as JSON.
 *
 * Genre lists are tiny and near-immutable and read on every Discover load --
 * an ideal thing to cache. Discover *results* are deliberately not cached
 * (their key space is huge and cold); only this list is.
 */
export const genreCache = pgTable("genre_cache", {
  // 'movie' | 'series' -- kept a plain text column so the database layer stays
  // agnostic about the vocabulary, exactly as catalog_rows.kind is.
  type: text("type").primaryKey(),
  genres: jsonb("genres").$type<{ id: string; name: string }[]>().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});
