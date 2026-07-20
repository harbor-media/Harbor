CREATE TYPE "public"."registration_mode" AS ENUM('disabled', 'invitation-only', 'open');--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"role" "user_role" NOT NULL,
	"email" text,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_max_uses_positive" CHECK ("invitations"."max_uses" >= 1),
	CONSTRAINT "invitations_use_count_bounded" CHECK ("invitations"."use_count" >= 0 and "invitations"."use_count" <= "invitations"."max_uses")
);
--> statement-breakpoint
ALTER TABLE "installation" ADD COLUMN "registration_mode" "registration_mode" DEFAULT 'invitation-only' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_created_by_idx" ON "invitations" USING btree ("created_by");