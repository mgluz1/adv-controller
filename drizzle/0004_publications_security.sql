-- Segurança das tabelas de publicações: privilégios mínimos para adv_app, RLS forçado, políticas por
-- operação e gatilhos de integridade. Mesmo padrão de 0001_tenant_security.sql.
--
-- Nenhuma tabela recebe acesso para adv_runtime: dados de escritório só por withTenant (SET ROLE adv_app).
-- Nada de DELETE em publications (o descarte é um "tombstone": UPDATE que apaga o conteúdo).
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.publications TO adv_app;
--> statement-breakpoint
REVOKE ALL ON public.publications FROM adv_runtime;
--> statement-breakpoint
ALTER TABLE public.publications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY publications_tenant_select ON public.publications FOR SELECT TO adv_app
  USING (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY publications_tenant_insert ON public.publications FOR INSERT TO adv_app
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY publications_tenant_update ON public.publications FOR UPDATE TO adv_app
  USING (organization_id = public.app_current_org())
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.publication_attorneys TO adv_app;
--> statement-breakpoint
REVOKE ALL ON public.publication_attorneys FROM adv_runtime;
--> statement-breakpoint
ALTER TABLE public.publication_attorneys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY publication_attorneys_tenant_select ON public.publication_attorneys FOR SELECT TO adv_app
  USING (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY publication_attorneys_tenant_insert ON public.publication_attorneys FOR INSERT TO adv_app
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY publication_attorneys_tenant_delete ON public.publication_attorneys FOR DELETE TO adv_app
  USING (organization_id = public.app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.sync_cursors TO adv_app;
--> statement-breakpoint
REVOKE ALL ON public.sync_cursors FROM adv_runtime;
--> statement-breakpoint
ALTER TABLE public.sync_cursors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sync_cursors_tenant_select ON public.sync_cursors FOR SELECT TO adv_app
  USING (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY sync_cursors_tenant_insert ON public.sync_cursors FOR INSERT TO adv_app
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY sync_cursors_tenant_update ON public.sync_cursors FOR UPDATE TO adv_app
  USING (organization_id = public.app_current_org())
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.sync_runs TO adv_app;
--> statement-breakpoint
REVOKE ALL ON public.sync_runs FROM adv_runtime;
--> statement-breakpoint
ALTER TABLE public.sync_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sync_runs_tenant_select ON public.sync_runs FOR SELECT TO adv_app
  USING (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY sync_runs_tenant_insert ON public.sync_runs FOR INSERT TO adv_app
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY sync_runs_tenant_update ON public.sync_runs FOR UPDATE TO adv_app
  USING (organization_id = public.app_current_org())
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.interest_terms TO adv_app;
--> statement-breakpoint
REVOKE ALL ON public.interest_terms FROM adv_runtime;
--> statement-breakpoint
ALTER TABLE public.interest_terms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY interest_terms_tenant_select ON public.interest_terms FOR SELECT TO adv_app
  USING (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY interest_terms_tenant_insert ON public.interest_terms FOR INSERT TO adv_app
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY interest_terms_tenant_update ON public.interest_terms FOR UPDATE TO adv_app
  USING (organization_id = public.app_current_org())
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
-- Gatilho: tombstone é imutável (nunca "volta") e a identidade da comunicação não muda.
CREATE FUNCTION public.publications_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'publicação descartada (tombstone) é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'identidade da publicação (escritório, ID oficial) não pode mudar' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.publications_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER publications_guard BEFORE UPDATE ON public.publications
  FOR EACH ROW EXECUTE FUNCTION public.publications_guard();
--> statement-breakpoint
-- Gatilho: não se vincula OAB a publicação descartada (o tombstone não guarda vínculos).
-- SECURITY INVOKER: a leitura de publications passa pelo RLS de quem grava.
CREATE FUNCTION public.publication_attorneys_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.publications p
     WHERE p.id = NEW.publication_id AND p.organization_id = NEW.organization_id AND p.removed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'não é possível vincular OAB a publicação descartada' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.publication_attorneys_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER publication_attorneys_guard BEFORE INSERT ON public.publication_attorneys
  FOR EACH ROW EXECUTE FUNCTION public.publication_attorneys_guard();
