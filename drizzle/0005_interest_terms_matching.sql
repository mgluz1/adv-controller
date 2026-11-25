-- Termos de interesse: padrão de casamento calculado (única função de casamento, src/server/domain/interest.ts) e o advogado a
-- cuja aba o termo pertence. interest_terms é nova (1.2) e nenhuma operação gravava nela até aqui: está VAZIA em todos os
-- ambientes, por isso `ADD COLUMN ... NOT NULL` sem valor padrão é seguro.
ALTER TABLE "interest_terms" ADD COLUMN "pattern" text NOT NULL;--> statement-breakpoint
ALTER TABLE "interest_terms" ADD COLUMN "attorney_id" uuid;--> statement-breakpoint
ALTER TABLE "interest_terms" ADD CONSTRAINT "interest_terms_attorney_fk" FOREIGN KEY ("organization_id","attorney_id") REFERENCES "public"."attorneys"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interest_terms_org_pattern_unique" ON "interest_terms" USING btree ("organization_id","pattern");--> statement-breakpoint
ALTER TABLE "interest_terms" ADD CONSTRAINT "interest_terms_pattern_chk" CHECK (char_length("interest_terms"."pattern") between 1 and 1000);