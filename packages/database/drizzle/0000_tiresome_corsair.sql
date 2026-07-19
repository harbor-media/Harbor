CREATE TABLE "installation" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_singleton" CHECK ("installation"."id" = true)
);
