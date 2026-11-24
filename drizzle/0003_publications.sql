-- Alvo das chaves estrangeiras compostas (organization_id, id): precisa existir ANTES das tabelas filhas.
ALTER TABLE "attorneys" ADD CONSTRAINT "attorneys_org_id_unique" UNIQUE("organization_id","id");
--> statement-breakpoint
CREATE TABLE "interest_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"term" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interest_terms_term_chk" CHECK (char_length("interest_terms"."term") between 2 and 80 and "interest_terms"."term" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "interest_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "publication_attorneys" (
	"organization_id" text NOT NULL,
	"publication_id" uuid NOT NULL,
	"attorney_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_attorneys_pk" PRIMARY KEY("publication_id","attorney_id")
);
--> statement-breakpoint
ALTER TABLE "publication_attorneys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_hash" text,
	"tribunal" text,
	"judging_body" text,
	"process_number" text,
	"process_mask" text,
	"class_name" text,
	"communication_type" text,
	"original_text" text,
	"medium" text,
	"source_url" text,
	"recipients" jsonb,
	"available_on" date,
	"published_on" date,
	"status" text DEFAULT 'a_revisar' NOT NULL,
	"notes" text,
	"action_note" text,
	"raw_payload" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	CONSTRAINT "publications_org_source_unique" UNIQUE("organization_id","source_id"),
	CONSTRAINT "publications_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "publications_source_id_chk" CHECK ("publications"."source_id" ~ '^[1-9][0-9]{0,17}$'),
	CONSTRAINT "publications_status_chk" CHECK ("publications"."status" in ('a_revisar', 'em_analise', 'concluida')),
	CONSTRAINT "publications_notes_len_chk" CHECK (char_length("publications"."notes") <= 20000),
	CONSTRAINT "publications_action_note_len_chk" CHECK (char_length("publications"."action_note") <= 2000),
	CONSTRAINT "publications_text_len_chk" CHECK (char_length("publications"."original_text") <= 2000000),
	CONSTRAINT "publications_source_url_chk" CHECK ("publications"."source_url" is null or "publications"."source_url" ~* '^https?://'),
	CONSTRAINT "publications_available_on_chk" CHECK ("publications"."available_on" is null or "publications"."available_on" >= date '2000-01-01'),
	CONSTRAINT "publications_live_chk" CHECK ("publications"."removed_at" is not null or ("publications"."original_text" is not null and "publications"."available_on" is not null)),
	CONSTRAINT "publications_tombstone_chk" CHECK ("publications"."removed_at" is null or (
        "publications"."archived_at" is not null
        and "publications"."original_text" is null and "publications"."raw_payload" is null and "publications"."recipients" is null
        and "publications"."process_number" is null and "publications"."process_mask" is null
        and "publications"."notes" is null and "publications"."action_note" is null and "publications"."source_url" is null
      ))
);
--> statement-breakpoint
ALTER TABLE "publications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"organization_id" text NOT NULL,
	"attorney_id" uuid PRIMARY KEY NOT NULL,
	"scan_day" date,
	"target_day" date,
	"last_complete_day" date,
	"last_reconciled_on" date,
	"next_due_at" timestamp with time zone,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_cursors_lease_chk" CHECK (("sync_cursors"."lease_id" is null) = ("sync_cursors"."lease_until" is null)),
	CONSTRAINT "sync_cursors_failures_chk" CHECK ("sync_cursors"."consecutive_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sync_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"attorney_id" uuid NOT NULL,
	"window_day" date NOT NULL,
	"trigger" text DEFAULT 'agendada' NOT NULL,
	"status" text DEFAULT 'executando' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"http_status" integer,
	"pages" integer,
	"items_found" integer,
	"items_inserted" integer,
	"error_kind" text,
	"error_message" text,
	"requested_by" text,
	CONSTRAINT "sync_runs_status_chk" CHECK ("sync_runs"."status" in ('executando', 'sucesso', 'erro')),
	CONSTRAINT "sync_runs_trigger_chk" CHECK ("sync_runs"."trigger" in ('manual', 'agendada')),
	CONSTRAINT "sync_runs_error_len_chk" CHECK (char_length("sync_runs"."error_message") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "sync_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interest_terms" ADD CONSTRAINT "interest_terms_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_terms" ADD CONSTRAINT "interest_terms_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_attorneys" ADD CONSTRAINT "publication_attorneys_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_attorneys" ADD CONSTRAINT "publication_attorneys_publication_fk" FOREIGN KEY ("organization_id","publication_id") REFERENCES "public"."publications"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_attorneys" ADD CONSTRAINT "publication_attorneys_attorney_fk" FOREIGN KEY ("organization_id","attorney_id") REFERENCES "public"."attorneys"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_attorney_fk" FOREIGN KEY ("organization_id","attorney_id") REFERENCES "public"."attorneys"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_attorney_fk" FOREIGN KEY ("organization_id","attorney_id") REFERENCES "public"."attorneys"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interest_terms_org_term_unique" ON "interest_terms" USING btree ("organization_id",lower("term"));--> statement-breakpoint
CREATE INDEX "interest_terms_org_idx" ON "interest_terms" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "publication_attorneys_attorney_idx" ON "publication_attorneys" USING btree ("organization_id","attorney_id");--> statement-breakpoint
CREATE INDEX "publications_org_active_idx" ON "publications" USING btree ("organization_id","available_on" DESC NULLS LAST,"id") WHERE "publications"."archived_at" is null and "publications"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "publications_org_archived_idx" ON "publications" USING btree ("organization_id","archived_at") WHERE "publications"."archived_at" is not null and "publications"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "publications_org_status_idx" ON "publications" USING btree ("organization_id","status") WHERE "publications"."archived_at" is null and "publications"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "publications_org_tribunal_idx" ON "publications" USING btree ("organization_id","tribunal");--> statement-breakpoint
CREATE INDEX "sync_cursors_org_due_idx" ON "sync_cursors" USING btree ("organization_id","next_due_at");--> statement-breakpoint
CREATE INDEX "sync_runs_org_started_idx" ON "sync_runs" USING btree ("organization_id","started_at" DESC NULLS LAST);
