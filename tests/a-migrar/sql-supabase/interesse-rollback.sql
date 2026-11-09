-- Aba A.B.C.D: teste transacional com conta de fixture. ROLLBACK obrigatório.
-- As publicações entram pelo caminho real de importação (djen_commit), como o coletor faz.
begin;
insert into auth.users(id) values ('00000000-0000-4000-8000-0000000000e1');
insert into public.djen_accounts(owner_id, enabled) values ('00000000-0000-4000-8000-0000000000e1', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000e1', true);
set local role authenticated;
select public.djen_setup();
reset role;

do $$
declare
  o uuid := '00000000-0000-4000-8000-0000000000e1';
  isa uuid; adv-b uuid; tk uuid; dia date := current_date;
  dest_interesse jsonb := '[{"nome":"A.B.C.D. EXEMPLO EMPREENDIMENTOS LTDA","polo":"P"}]';
  dest_comum jsonb := '[{"nome":"FULANO DE TAL","polo":"A"}]';
begin
  select id into isa from public.djen_attorneys where owner_id = o and oab_number = '123456';
  select id into adv-b from public.djen_attorneys where owner_id = o and oab_number = '234567';

  -- Importação pela OAB GO: A.B.C.D só em destinatários (1), comum (2), A.B.C.D no teor (3),
  -- falsos positivos (4)
  tk := gen_random_uuid();
  update public.djen_sync_cursors set scan_day = dia, target_day = dia, lease_id = tk, lease_until = now() + interval '1 minute' where attorney_id = isa;
  perform public.djen_commit(isa, tk, jsonb_build_array(
    jsonb_build_object('id', 990001, 'data_disponibilizacao', dia, 'siglaTribunal', 'TRT18', 'texto', 'Intimação de audiência.', 'destinatarios', dest_interesse),
    jsonb_build_object('id', 990002, 'data_disponibilizacao', dia, 'siglaTribunal', 'TJGO', 'texto', 'Despacho comum.', 'destinatarios', dest_comum),
    jsonb_build_object('id', 990003, 'data_disponibilizacao', dia, 'siglaTribunal', 'TST', 'texto', 'RECORRIDO: a.b.c.d. empreendimentos', 'destinatarios', dest_comum),
    jsonb_build_object('id', 990004, 'data_disponibilizacao', dia, 'siglaTribunal', 'TRT18', 'texto', 'ABCD LTDA, A.B.C.DTDA e SA.B.C.D não são a sigla.', 'destinatarios', dest_comum)
  ));

  -- Importação pela OAB RJ: a 990003 também é dela (vínculo nas duas OABs); 990005 comum
  tk := gen_random_uuid();
  update public.djen_sync_cursors set scan_day = dia, target_day = dia, lease_id = tk, lease_until = now() + interval '1 minute' where attorney_id = adv-b;
  perform public.djen_commit(adv-b, tk, jsonb_build_array(
    jsonb_build_object('id', 990003, 'data_disponibilizacao', dia, 'siglaTribunal', 'TST', 'texto', 'RECORRIDO: a.b.c.d. empreendimentos', 'destinatarios', dest_comum),
    jsonb_build_object('id', 990005, 'data_disponibilizacao', dia, 'siglaTribunal', 'TJRJ', 'texto', 'Intimação comum.', 'destinatarios', dest_comum)
  ));
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000e1', true);
set local role authenticated;
do $$
declare
  ids text;
  f jsonb := '{"limit":100}';
begin
  -- 1. A.B.C.D vinculada à adv-a aparece na aba A.B.C.D
  select string_agg(r->>'source_id', ',' order by r->>'source_id') into ids
    from jsonb_array_elements(public.djen_list(f || '{"attorney":"interesse"}')->'rows') r;
  if ids is distinct from '990001,990003' then raise exception 'FAIL 1 interesse: %', ids; end if;

  -- 2. Não aparece na aba da adv-a; as comuns e os falsos positivos continuam
  select string_agg(r->>'source_id', ',' order by r->>'source_id') into ids
    from jsonb_array_elements(public.djen_list(f || '{"attorney":"adv-a"}')->'rows') r;
  if ids is distinct from '990002,990004' then raise exception 'FAIL 2 adv-a: %', ids; end if;

  -- 3. Todos mostra tudo, uma linha por publicação
  select string_agg(r->>'source_id', ',' order by r->>'source_id') into ids
    from jsonb_array_elements(public.djen_list(f)->'rows') r;
  if ids is distinct from '990001,990002,990003,990004,990005' then raise exception 'FAIL 3 todos: %', ids; end if;

  -- 4. A.B.C.D vinculada também ao adv-b permanece na aba dele
  select string_agg(r->>'source_id', ',' order by r->>'source_id') into ids
    from jsonb_array_elements(public.djen_list(f || '{"attorney":"adv-b"}')->'rows') r;
  if ids is distinct from '990003,990005' then raise exception 'FAIL 4 adv-b: %', ids; end if;

  -- Vínculos reais preservados: a 990001 continua ligada à OAB GO e a 990003 às duas
  if (select count(*) from public.djen_publication_attorneys l join public.djen_publications p on p.id = l.publication_id where p.source_id = '990001') <> 1
     or (select count(*) from public.djen_publication_attorneys l join public.djen_publications p on p.id = l.publication_id where p.source_id = '990003') <> 2
  then raise exception 'FAIL vínculos alterados'; end if;

  -- 7. Contadores por aba = totais das listas, independentes da aba ativa
  if public.djen_list('{}')->'tab_stats' <> public.djen_list('{"attorney":"adv-a"}')->'tab_stats'
  then raise exception 'FAIL contadores dependem da aba ativa'; end if;
  if (public.djen_list('{}')->'tab_stats'->'todos'->>'total')::int <> 5
     or (public.djen_list('{}')->'tab_stats'->'adv-a'->>'total')::int <> 2
     or (public.djen_list('{}')->'tab_stats'->'adv-b'->>'total')::int <> 2
     or (public.djen_list('{}')->'tab_stats'->'interesse'->>'total')::int <> 2
  then raise exception 'FAIL tab_stats: %', public.djen_list('{}')->'tab_stats'; end if;

  -- 7. Filtros e paginação valem dentro da aba A.B.C.D
  if (public.djen_list('{"attorney":"interesse","tribunal":"TST"}')->>'total')::int <> 1 then raise exception 'FAIL tribunal'; end if;
  if (public.djen_list('{"attorney":"interesse","search":"recorrido"}')->>'total')::int <> 1 then raise exception 'FAIL busca'; end if;
  if (public.djen_list('{"attorney":"interesse","tribunal":"TST"}')->'tab_stats'->'interesse'->>'total')::int <> 1 then raise exception 'FAIL contador com filtro'; end if;
  if jsonb_array_length(public.djen_list('{"attorney":"interesse","limit":1,"offset":1}')->'rows') <> 1
     or (public.djen_list('{"attorney":"interesse","limit":1,"offset":1}')->>'total')::int <> 2
  then raise exception 'FAIL paginação'; end if;
  if (public.djen_list('{"attorney":"interesse","start":"1900-01-01","end":"1900-01-02"}')->>'total')::int <> 0 then raise exception 'FAIL período'; end if;

  -- Status, anotação e arquivamento seguem funcionando para A.B.C.D
  perform public.djen_mutate('status', array['990001'], 'em_analise', 'nota', 'providência');
  if (public.djen_list('{"attorney":"interesse","status":"em_analise"}')->>'total')::int <> 1 then raise exception 'FAIL status'; end if;
  perform public.djen_mutate('archive', array['990001']);
  if (public.djen_list('{"attorney":"interesse"}')->>'total')::int <> 1
     or (public.djen_list('{"attorney":"interesse","archived":true}')->>'total')::int <> 1
     or (public.djen_list('{"attorney":"adv-a","archived":true}')->>'total')::int <> 0
  then raise exception 'FAIL arquivo'; end if;
  perform public.djen_mutate('restore', array['990001']);
end $$;
reset role;

-- 6. Nova publicação A.B.C.D importada depois segue a regra sem nenhuma ação manual
do $$
declare o uuid := '00000000-0000-4000-8000-0000000000e1'; isa uuid; tk uuid := gen_random_uuid(); dia date := current_date;
begin
  select id into isa from public.djen_attorneys where owner_id = o and oab_number = '123456';
  update public.djen_sync_cursors set scan_day = dia, target_day = dia, lease_id = tk, lease_until = now() + interval '1 minute' where attorney_id = isa;
  perform public.djen_commit(isa, tk, jsonb_build_array(
    jsonb_build_object('id', 990006, 'data_disponibilizacao', dia, 'siglaTribunal', 'TRT18', 'texto', 'EXECUTADO: A. B. C. D.', 'destinatarios', '[]'::jsonb)));
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000e1', true);
set local role authenticated;
do $$ begin
  if (public.djen_list('{}')->'tab_stats'->'interesse'->>'total')::int <> 3
     or (public.djen_list('{}')->'tab_stats'->'adv-a'->>'total')::int <> 2
     or (public.djen_list('{}')->'tab_stats'->'todos'->>'total')::int <> 6
  then raise exception 'FAIL 6 importação futura: %', public.djen_list('{}')->'tab_stats'; end if;
  -- Tombstone sai de todas as abas
  perform public.djen_mutate('archive', array['990006']);
  perform public.djen_mutate('remove', array['990006']);
  if (public.djen_list('{}')->'tab_stats'->'interesse'->>'total')::int <> 2 then raise exception 'FAIL tombstone'; end if;
end $$;
reset role;

-- Isolamento: outra conta não vê nada da fixture em nenhuma aba
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ff', true);
set local role authenticated;
do $$ begin
  if exists (select 1 from jsonb_array_elements(public.djen_list('{"attorney":"interesse","limit":100}')->'rows') r where r->>'source_id' like '9900%')
  then raise exception 'FAIL isolamento'; end if;
end $$;
reset role;

select 'PASS: interesse, adv-a sem interesse, todos, adv-b, vínculos, contadores, filtros, paginação, status, arquivo, importação futura, tombstone, isolamento' as result;
rollback;
