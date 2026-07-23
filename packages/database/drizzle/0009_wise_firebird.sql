ALTER TABLE "titles" ADD COLUMN "tagline" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "rating" real;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "logo_path" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "director" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "writers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "studios" jsonb DEFAULT '[]'::jsonb NOT NULL;