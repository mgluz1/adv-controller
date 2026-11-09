-- Multiusuário por escritório: teste transacional com contas de fixture. ROLLBACK obrigatório.
begin;
-- O dono, M (membro), X (sem conta), P (dono de escritório desativado) e N (membro de P).
insert into auth.users(id) values
 ('00000000-0000-4000-8000-0000000000a1'),('00000000-0000-4000-8000-0000000000a2'),
 ('00000000-0000-4000-8000-0000000000a3'),('00000000-0000-4000-8000-0000000000a4'),
 ('00000000-0000-4000-8000-0000000000a5');
insert into public.djen_accounts(owner_id, enabled) values
 ('00000000-0000-4000-8000-0000000000a1', true),
 ('00000000-0000-4000-8000-0000000000a4', false);
insert into public.djen_members(user_id, office_id) values
 ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a1'),
 ('00000000-0000-4000-8000-0000000000a5', '00000000-0000-4000-8000-0000000000a4');

-- O dono prepara o escritório e o coletor importa duas publicações (uma por OAB)
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a1',true);
set local role authenticated;
select public.djen_setup();
reset role;
do $$
declare o uuid := '00000000-0000-4000-8000-0000000000a1'; isa uuid; adv-b uuid; tk uuid; dia date := current_date;
begin
  select id into isa from public.djen_attorneys where owner_id=o and oab_number='123456';
  select id into adv-b from public.djen_attorneys where owner_id=o and oab_number='234567';
  tk := gen_random_uuid();
  update public.djen_sync_cursors set scan_day=dia,target_day=dia,lease_id=tk,lease_until=now()+interval '1 minute' where attorney_id=isa;
  perform public.djen_commit(isa,tk,jsonb_build_array(jsonb_build_object('id',990101,'data_disponibilizacao',dia,'siglaTribunal','TRT18','texto','Intimação A.')));
  tk := gen_random_uuid();
  update public.djen_sync_cursors set scan_day=dia,target_day=dia,lease_id=tk,lease_until=now()+interval '1 minute' where attorney_id=adv-b;
  perform public.djen_commit(adv-b,tk,jsonb_build_array(jsonb_build_object('id',990102,'data_disponibilizacao',dia,'siglaTribunal','TJRJ','texto','Intimação B.')));
end $$;

-- Membro M: vê o mesmo conjunto do dono e consegue operar
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a2',true);
set local role authenticated;
do $$ begin
  perform public.djen_setup(); -- idempotente: não duplica advogados nem cursores
  if (public.djen_list('{}')->>'total')::int <> 2 then raise exception 'FAIL membro não vê o total: %', public.djen_list('{}')->>'total'; end if;
  if (select count(*) from public.djen_publications) <> 2 then raise exception 'FAIL membro leitura direta'; end if;
  if (select count(*) from public.djen_attorneys) <> 2 or (select count(*) from public.djen_sync_cursors) <> 2 then raise exception 'FAIL membro advogados/cursores'; end if;
  if (select count(*) from public.djen_publication_attorneys) <> 2 then raise exception 'FAIL membro vínculos'; end if;
  if (public.djen_list('{"attorney":"adv-b"}')->>'total')::int <> 1 or (public.djen_list('{}')->'tab_stats'->'todos'->>'total')::int <> 2 then raise exception 'FAIL membro abas'; end if;
  -- operações compartilhadas
  if public.djen_mutate('status', array['990101'], 'em_analise', 'nota do membro', 'prov. do membro') <> 1 then raise exception 'FAIL membro status'; end if;
  if public.djen_mutate('archive', array['990102']) <> 1 then raise exception 'FAIL membro arquivar'; end if;
  perform public.djen_request_sync();
  -- sem acesso à tabela de mapeamento e sem escrita direta
  begin perform count(*) from public.djen_members; raise exception 'FAIL membro leu djen_members'; exception when insufficient_privilege then null; end;
  begin insert into public.djen_members(user_id,office_id) values ('00000000-0000-4000-8000-0000000000a3','00000000-0000-4000-8000-0000000000a1'); raise exception 'FAIL membro escreveu djen_members'; exception when insufficient_privilege then null; end;
  begin update public.djen_publications set status='concluida'; raise exception 'FAIL escrita direta'; exception when insufficient_privilege then null; end;
  begin insert into public.djen_attorneys(owner_id,name,oab_number,uf) values ('00000000-0000-4000-8000-0000000000a1','X','1','GO'); raise exception 'FAIL insert direto'; exception when insufficient_privilege then null; end;
  if (select count(*) from public.djen_accounts) <> 0 then raise exception 'FAIL membro enxerga djen_accounts'; end if;
end $$;

-- Dono: vê o que o membro fez; a autoria está na auditoria; o limite de 5 min é compartilhado
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a1',true);
do $$ begin
  if (select status||'/'||notes||'/'||action_note from public.djen_publications where source_id='990101') <> 'em_analise/nota do membro/prov. do membro' then raise exception 'FAIL dono não vê status/nota do membro'; end if;
  if (public.djen_list('{"archived":true}')->>'total')::int <> 1 or (public.djen_list('{}')->>'total')::int <> 1 then raise exception 'FAIL dono não vê arquivamento do membro'; end if;
  if (select count(*) from public.djen_audit where details->>'actor'='00000000-0000-4000-8000-0000000000a2' and owner_id='00000000-0000-4000-8000-0000000000a1') <> 3 then raise exception 'FAIL autoria na auditoria'; end if;
  begin perform public.djen_request_sync(); raise exception 'FAIL limite compartilhado'; exception when raise_exception then if SQLERRM='FAIL limite compartilhado' then raise; end if; end;
  -- dono continua operando sem linha em djen_members
  if public.djen_mutate('restore', array['990102']) <> 1 then raise exception 'FAIL dono restaurar'; end if;
end $$;
reset role;

-- Usuário sem conta nem mapeamento: nada
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a3',true);
set local role authenticated;
do $$ begin
  if (public.djen_list('{}')->>'total')::int <> 0 then raise exception 'FAIL estranho vê dados'; end if;
  if (select count(*) from public.djen_publications) <> 0 or (select count(*) from public.djen_attorneys) <> 0 then raise exception 'FAIL estranho leitura direta'; end if;
  begin perform public.djen_setup(); raise exception 'FAIL estranho setup'; exception when raise_exception then if SQLERRM='FAIL estranho setup' then raise; end if; end;
  begin perform public.djen_mutate('archive', array['990101']); raise exception 'FAIL estranho mutate'; exception when raise_exception then if SQLERRM='FAIL estranho mutate' then raise; end if; end;
end $$;
reset role;

-- Membro de escritório desativado: nada, e não alcança o outro escritório
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a5',true);
set local role authenticated;
do $$ begin
  if (public.djen_list('{}')->>'total')::int <> 0 or (select count(*) from public.djen_publications) <> 0 then raise exception 'FAIL escritório desativado'; end if;
  begin perform public.djen_setup(); raise exception 'FAIL setup desativado'; exception when raise_exception then if SQLERRM='FAIL setup desativado' then raise; end if; end;
  begin perform public.djen_mutate('archive', array['990101']); raise exception 'FAIL mutate desativado'; exception when raise_exception then if SQLERRM='FAIL mutate desativado' then raise; end if; end;
end $$;
reset role;

-- Revogação: remover o mapeamento corta o acesso na hora
delete from public.djen_members where user_id='00000000-0000-4000-8000-0000000000a2';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a2',true);
set local role authenticated;
do $$ begin
  if (public.djen_list('{}')->>'total')::int <> 0 or (select count(*) from public.djen_publications) <> 0 then raise exception 'FAIL revogação'; end if;
end $$;
reset role;

-- Tudo isso sem tocar nos dados do escritório
do $$ begin
  if (select count(*) from public.djen_publications where owner_id='00000000-0000-4000-8000-0000000000a1') <> 2
     or (select count(*) from public.djen_publication_attorneys where owner_id='00000000-0000-4000-8000-0000000000a1') <> 2
  then raise exception 'FAIL dados do escritório alterados'; end if;
end $$;

select 'PASS: membro lê/opera o mesmo escritório, autoria auditada, limite compartilhado, sem acesso a djen_members nem escrita direta, estranho e escritório desativado bloqueados, revogação imediata' as result;
rollback;
