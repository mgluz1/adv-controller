-- Segurança multi-escritório: papel de aplicação, RLS forçado e permissões mínimas.
--
-- Modelo: o servidor conecta com o papel dono do esquema (migrações, Better Auth) e, para tudo que
-- toca dados de um escritório, executa `SET LOCAL ROLE adv_app` + `app.organization_id` dentro de uma
-- transação (src/server/db/tenant.ts). `adv_app` NÃO é dono das tabelas, não tem BYPASSRLS e só vê
-- linhas do escritório ativo. Nenhuma política vale para outros papéis (o dono continua fora das regras
-- de RLS por design: ele nunca é usado para consultas de dados de escritório).

-- 1) Papel de aplicação (sem login, sem privilégios especiais).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adv_app') THEN
    CREATE ROLE adv_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- O papel que roda as migrações precisa poder assumir `adv_app` (SET ROLE).
GRANT adv_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO adv_app;
--> statement-breakpoint

-- 2) Escritório ativo da transação. Vazio/ausente => NULL => nenhuma linha visível nem gravável.
CREATE OR REPLACE FUNCTION public.app_current_org() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.organization_id', true), '') $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_current_org() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_current_org() TO adv_app;
--> statement-breakpoint

-- 3) Permissões mínimas por tabela (princípio do menor privilégio). Nenhuma nas tabelas do Better Auth.
GRANT SELECT, INSERT, UPDATE ON public.attorneys TO adv_app;       -- sem DELETE: OAB é desativada
--> statement-breakpoint
GRANT SELECT, INSERT ON public.audit_log TO adv_app;               -- trilha somente-inserção
--> statement-breakpoint

-- 4) RLS habilitado E forçado, com políticas por operação.
ALTER TABLE public.attorneys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.attorneys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attorneys_tenant_select ON public.attorneys FOR SELECT TO adv_app
  USING (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY attorneys_tenant_insert ON public.attorneys FOR INSERT TO adv_app
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY attorneys_tenant_update ON public.attorneys FOR UPDATE TO adv_app
  USING (organization_id = public.app_current_org())
  WITH CHECK (organization_id = public.app_current_org());
--> statement-breakpoint
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_log_tenant_select ON public.audit_log FOR SELECT TO adv_app
  USING (organization_id = public.app_current_org());
--> statement-breakpoint
CREATE POLICY audit_log_tenant_insert ON public.audit_log FOR INSERT TO adv_app
  WITH CHECK (organization_id = public.app_current_org());
