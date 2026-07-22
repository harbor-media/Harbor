CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"episode_number" integer NOT NULL,
	"name" text,
	"overview" text,
	"still_path" text,
	"runtime" integer,
	"air_date" text
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid NOT NULL,
	"season_number" integer NOT NULL,
	"name" text,
	"overview" text,
	"poster_path" text,
	"episode_count" integer,
	"air_date" text,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "runtime" integer;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "genres" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "detail_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_season_number_idx" ON "episodes" USING btree ("season_id","episode_number");--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_title_number_idx" ON "seasons" USING btree ("title_id","season_number");