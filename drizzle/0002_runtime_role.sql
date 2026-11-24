-- Papel de RUNTIME, separado do papel que roda migrações (dono do esquema).
--
-- Antes: o servidor conectava como dono do esquema; código que consultasse `attorneys` sem
-- `withTenant` ignorava o RLS (risco nº 6 de docs/BACKEND.md). Agora o servidor conecta como
-- `adv_runtime`, que NÃO é dono de nada, não tem BYPASSRLS e:
--   * acessa apenas as tabelas do Better Auth (leitura/escrita);
--   * não tem NENHUM privilégio em tabelas de domínio (attorneys, audit_log, …);
--   * só alcança dados de escritório assumindo `adv_app` (SET ROLE dentro de withTenant).
--
-- O papel nasce SEM LOGIN e sem senha: segredo não entra em migração versionada. Quem opera o
-- banco habilita o login uma vez (npm run db:runtime-login), que grava a senha em .env.local.
-- Tabela de domínio nova NÃO ganha acesso automático: nada de ALTER DEFAULT PRIVILEGES.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adv_runtime') THEN
    CREATE ROLE adv_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- Pode TROCAR para adv_app (SET ROLE), mas não herda os privilégios dele: fora do withTenant, nada.
GRANT adv_app TO adv_runtime WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO adv_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public."user" TO adv_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.session TO adv_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account TO adv_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.verification TO adv_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization TO adv_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member TO adv_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invitation TO adv_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limit TO adv_runtime;
--> statement-breakpoint
-- Explícito, para quem ler: nenhum acesso direto às tabelas de domínio.
REVOKE ALL ON public.attorneys FROM adv_runtime;
--> statement-breakpoint
REVOKE ALL ON public.audit_log FROM adv_runtime;
