CREATE TABLE "catalog_entries" (
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"title_id" uuid NOT NULL,
	CONSTRAINT "catalog_entries_kind_position_pk" PRIMARY KEY("kind","position")
);
--> statement-breakpoint
CREATE TABLE "catalog_rows" (
	"kind" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_entries" ADD CONSTRAINT "catalog_entries_kind_catalog_rows_kind_fk" FOREIGN KEY ("kind") REFERENCES "public"."catalog_rows"("kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entries" ADD CONSTRAINT "catalog_entries_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;