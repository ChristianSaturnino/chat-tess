CREATE TABLE "context_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"previous_id" uuid,
	"cutoff_seq" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"model" text NOT NULL,
	"run_id" uuid,
	"tokens_before" integer NOT NULL,
	"tokens_after" integer NOT NULL,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"mode" text NOT NULL,
	"snapshot" jsonb,
	"allowed_attachment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_summaries" ADD CONSTRAINT "context_summaries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_summaries" ADD CONSTRAINT "context_summaries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "context_summaries_conv_version_uq" ON "context_summaries" USING btree ("conversation_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_token_hash_uq" ON "shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "shares_conversation_idx" ON "shares" USING btree ("conversation_id");