CREATE TABLE "genre_cache" (
	"type" text PRIMARY KEY NOT NULL,
	"genres" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
