CREATE TYPE "public"."external_id_source" AS ENUM('tmdb', 'imdb');--> statement-breakpoint
CREATE TYPE "public"."title_type" AS ENUM('movie', 'series');--> statement-breakpoint
CREATE TABLE "metadata_provider_config" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"encrypted_api_key" text,
	"language" text DEFAULT 'en-US' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metadata_search_cache" (
	"query_hash" text NOT NULL,
	"language" text NOT NULL,
	"title_ids" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metadata_search_cache_query_hash_language_pk" PRIMARY KEY("query_hash","language")
);
--> statement-breakpoint
CREATE TABLE "title_external_ids" (
	"title_id" uuid NOT NULL,
	"source" "external_id_source" NOT NULL,
	"external_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "titles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "title_type" NOT NULL,
	"title" text NOT NULL,
	"original_title" text,
	"year" integer,
	"overview" text,
	"poster_path" text,
	"backdrop_path" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "title_external_ids" ADD CONSTRAINT "title_external_ids_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "title_external_ids_source_external_idx" ON "title_external_ids" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "title_external_ids_title_idx" ON "title_external_ids" USING btree ("title_id");--> statement-breakpoint
CREATE INDEX "titles_title_idx" ON "titles" USING btree ("title");