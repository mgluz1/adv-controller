-- Teste transacional: fixtures nunca persistem; ROLLBACK obrigatório.
begin;
insert into auth.users(id) values ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
insert into public.djen_accounts(owner_id,enabled) values ('00000000-0000-4000-8000-000000000001',true),('00000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.djen_setup();
do $$ begin
 if (select count(*) from public.djen_attorneys)<>2 then raise exception 'FAIL setup'; end if;
 begin perform public.djen_claim(); raise exception 'FAIL worker permission'; exception when insufficient_privilege then null; end;
 begin update public.djen_accounts set enabled=false; raise exception 'FAIL account write'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ declare j jsonb; a uuid; b uuid; token uuid:=gen_random_uuid(); payload jsonb; owner uuid:='00000000-0000-4000-8000-000000000001'; n integer; begin
 j:=public.djen_claim(owner); a:=(j->>'attorney_id')::uuid;
 if j is null then raise exception 'FAIL claim'; end if;
 if public.djen_claim(owner) is not null then raise exception 'FAIL overlap lock'; end if;
 payload:=jsonb_build_array(jsonb_build_object('id',123456,'data_disponibilizacao',j->>'day','texto','FIXTURE ROLLBACK ONLY'));
 n:=public.djen_commit(a,(j->>'lease')::uuid,payload); if n<>1 then raise exception 'FAIL first insert'; end if;
 -- Retry/restart same day, same source: one publication and preserve annotations.
 update public.djen_publications set notes='manual',status='em_analise';
 update public.djen_sync_cursors set scan_day=(j->>'day')::date,lease_id=token,lease_until=now()+interval '1 minute' where attorney_id=a;
 n:=public.djen_commit(a,token,payload); if n<>0 then raise exception 'FAIL duplicate'; end if;
 if not exists(select 1 from public.djen_publications where notes='manual' and status='em_analise') then raise exception 'FAIL notes'; end if;
 -- Second attorney, same publication.
 select id into b from public.djen_attorneys where owner_id=owner and id<>a;
 update public.djen_sync_cursors set scan_day=(j->>'day')::date,target_day=current_date,lease_id=token,lease_until=now()+interval '1 minute' where attorney_id=b;
 perform public.djen_commit(b,token,payload);
 if (select count(*) from public.djen_publications)<>1 or (select count(*) from public.djen_publication_attorneys)<>2 then raise exception 'FAIL shared publication'; end if;
 -- Archive/reimport/restore/tombstone and atomic rollback.
 perform public.djen_mutate('archive',array['123456']);
 update public.djen_sync_cursors set scan_day=(j->>'day')::date,lease_id=token,lease_until=now()+interval '1 minute' where attorney_id=a;
 perform public.djen_commit(a,token,payload);
 if not exists(select 1 from public.djen_publications where archived_at is not null) then raise exception 'FAIL archive reimport'; end if;
 perform public.djen_mutate('restore',array['123456']);
 if exists(select 1 from public.djen_publications where archived_at is not null) then raise exception 'FAIL restore'; end if;
 perform public.djen_mutate('archive',array['123456']);perform public.djen_mutate('remove',array['123456']);
 update public.djen_sync_cursors set scan_day=(j->>'day')::date,lease_id=token,lease_until=now()+interval '1 minute' where attorney_id=a;
 perform public.djen_commit(a,token,payload);
 if not exists(select 1 from public.djen_publications where removed_at is not null and original_text is null and notes is null and raw_payload is null) or exists(select 1 from public.djen_publication_attorneys) then raise exception 'FAIL tombstone'; end if;
 update public.djen_sync_cursors set scan_day=(j->>'day')::date,lease_id=token,lease_until=now()+interval '1 minute' where attorney_id=a;
 begin
 perform public.djen_commit(a,token,jsonb_build_array(jsonb_build_object('id',222,'data_disponibilizacao',j->>'day'),jsonb_build_object('id',333,'data_disponibilizacao','1900-01-01')));
 raise exception 'FAIL invalid day accepted';
 exception when raise_exception then if SQLERRM='FAIL invalid day accepted' then raise; end if; end;
 if exists(select 1 from public.djen_publications where source_id='222') then raise exception 'FAIL atomic rollback'; end if;
 if (select scan_day from public.djen_sync_cursors where attorney_id=a)<>(j->>'day')::date then raise exception 'FAIL cursor moved'; end if;
 update public.djen_sync_cursors set lease_until=now()-interval '1 second' where attorney_id=a;
 begin perform public.djen_commit(a,token,payload);raise exception 'FAIL stale worker accepted';exception when raise_exception then if SQLERRM='FAIL stale worker accepted' then raise;end if;end;
end $$;
set local role authenticated;
do $$ begin
 if (select count(*) from public.djen_publications)<>1 then raise exception 'FAIL owner read';end if;
 if (public.djen_list()->>'total')::integer<>0 then raise exception 'FAIL removed in list';end if;
 if public.djen_mutate('restore',array['123456'])<>0 then raise exception 'FAIL tombstone restore';end if;
 perform public.djen_request_sync();
 begin perform public.djen_request_sync();raise exception 'FAIL rate limit';exception when raise_exception then if SQLERRM='FAIL rate limit' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$ begin
 if (select count(*) from public.djen_publications)<>0 then raise exception 'FAIL cross account read';end if;
 if public.djen_mutate('archive',array['123456'])<>0 then raise exception 'FAIL cross account update';end if;
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform count(*) from public.djen_publications;raise exception 'FAIL anon read';exception when insufficient_privilege then null;end;
 begin perform public.djen_list();raise exception 'FAIL anon rpc';exception when insufficient_privilege then null;end;
 begin perform public.djen_cron_authorized('wrong');raise exception 'FAIL anon cron';exception when insufficient_privilege then null;end;
end $$;
reset role;
select 'PASS: owner/anon/cross-account, leases, dedup, shared OAB, restart, archive, restore, tombstone, rollback, rate limit' as result;
rollback;
