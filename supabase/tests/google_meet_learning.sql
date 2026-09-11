-- Local/sandbox test only; all fictional fixtures are rolled back.
begin;
insert into public.tenants(id) values('meet-fixture-a'),('meet-fixture-b');
insert into public.profiles(id,tenant_id,role,lifecycle_status) values
 ('10000000-0000-4000-8000-000000000001','meet-fixture-a','TEACHER','active'),
 ('10000000-0000-4000-8000-000000000002','meet-fixture-a','STUDENT','active'),
 ('10000000-0000-4000-8000-000000000003','meet-fixture-b','TEACHER','active');
insert into public.bookings(id,tenant_id,teacher_id,student_id,status) values
 ('20000000-0000-4000-8000-000000000001','meet-fixture-a','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','SCHEDULED');
insert into public.meet_rooms(id,tenant_id,teacher_id,student_id,booking_id,google_sub,state,consent_confirmed_at) values
 ('30000000-0000-4000-8000-000000000001','meet-fixture-a','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','fictional-google-id','READY',now());
insert into public.meet_transcripts(id,room_id,tenant_id,student_id,transcript_name,occurred_at,entries,participants,state,proposal) values
 ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','meet-fixture-a','10000000-0000-4000-8000-000000000002','conferenceRecords/fixture/transcripts/one',now(),'[]','[]','REVIEW',
 '{"summary":"Aula fictícia de logística","practiced":["past tense"],"vocabulary":["shipment"],"difficulties":[],"strengths":[],"interests":["logistics"],"next_lesson":"Revisar passado","teacher_preparation":["Preparar exemplos"],"oral_test":["Perguntar sobre projeto"],"evidence":[]}');
do $$ declare lease uuid; begin
  if has_table_privilege('anon','public.meet_connections','SELECT') or has_table_privilege('authenticated','public.meet_connections','SELECT') then raise exception 'tokens_exposed'; end if;
  if has_table_privilege('authenticated','public.meet_transcripts','SELECT') then raise exception 'raw_transcript_exposed'; end if;
  if has_function_privilege('authenticated','public.review_meet_transcript(uuid,text,uuid,boolean)','EXECUTE') then raise exception 'service_function_exposed'; end if;
  if exists(select 1 from pg_class where oid in ('public.meet_connections'::regclass,'public.meet_oauth_states'::regclass,'public.meet_rooms'::regclass,'public.meet_transcripts'::regclass) and not relrowsecurity) then raise exception 'rls_missing'; end if;
  lease:=public.claim_meet_room('30000000-0000-4000-8000-000000000001');
  if lease is null then raise exception 'initial_claim_failed'; end if;
  if public.claim_meet_room('30000000-0000-4000-8000-000000000001') is not null then raise exception 'duplicate_worker_claim'; end if;
  begin
    perform public.review_meet_transcript('40000000-0000-4000-8000-000000000001','meet-fixture-b','10000000-0000-4000-8000-000000000003',true);
    raise exception 'cross_tenant_accepted';
  exception when others then if sqlerrm<>'review_unavailable' then raise; end if; end;
  begin
    perform public.review_meet_transcript('40000000-0000-4000-8000-000000000001','meet-fixture-a','10000000-0000-4000-8000-000000000003',true);
    raise exception 'other_teacher_accepted';
  exception when others then if sqlerrm<>'forbidden' then raise; end if; end;
  perform public.review_meet_transcript('40000000-0000-4000-8000-000000000001','meet-fixture-a','10000000-0000-4000-8000-000000000001',true);
  if (select count(*) from public.student_learning_memories where source_type='GOOGLE_MEET' and source_ref='conferenceRecords/fixture/transcripts/one' and verification_status='VERIFIED' and metadata->'interests'='["logistics"]'::jsonb)<>1 then raise exception 'approved_memory_missing'; end if;
  begin
    perform public.review_meet_transcript('40000000-0000-4000-8000-000000000001','meet-fixture-a','10000000-0000-4000-8000-000000000001',true);
    raise exception 'duplicate_review_accepted';
  exception when others then if sqlerrm<>'review_unavailable' then raise; end if; end;
  update public.meet_transcripts set state='REVIEW',transcript_name='conferenceRecords/fixture/transcripts/reject' where id='40000000-0000-4000-8000-000000000001';
  perform public.review_meet_transcript('40000000-0000-4000-8000-000000000001','meet-fixture-a','10000000-0000-4000-8000-000000000001',false);
  if exists(select 1 from public.student_learning_memories where source_ref='conferenceRecords/fixture/transcripts/reject') then raise exception 'rejected_memory_saved'; end if;
  raise notice 'PASS: RLS, privileges, lease, tenant, ownership, approval atomicity, metadata and rejection';
end $$;
rollback;
