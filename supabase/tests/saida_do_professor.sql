\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create function pg_temp.as_user(u uuid) returns void language sql as $$select set_config('request.jwt.claim.sub',u::text,true),set_config('request.jwt.claims',json_build_object('role','authenticated','sub',u)::text,true)$$;
create function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'assertion: %',m;end if;end$$;

-- 1 diretor · 2 aluno que cabe · 3 professor que sai · 4 professor livre · 5 aluno sem candidato
insert into public.tenants(id,name) values('departure-fixture','Teacher departure fixture');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('f9250000-0000-4000-8000-00000000000'||n)::uuid,'authenticated','authenticated','departure-'||n||'@example.invalid','{"provider":"email"}'::jsonb,'{"test_fixture":true}'::jsonb,now(),now() from generate_series(1,5) n;
update public.profiles set tenant_id='departure-fixture',lifecycle_status='active',status='Ativo',status_financial='ACTIVE',is_test_account=true,
 full_name=case right(id::text,1) when '1' then 'Diretora Fixture' when '2' then 'Aluna Cabe Silva' when '3' then 'Teacher Sai Fixture' when '4' then 'Teacher Livre Fixture' else 'Aluno Sobra Souza' end,
 role=case right(id::text,1) when '1' then 'SCHOOL_ADMIN' when '2' then 'STUDENT' when '5' then 'STUDENT' else 'TEACHER' end,
 phone='550000000000'||right(id::text,1)
 where id::text like 'f9250000-0000-4000-8000-00000000000%';
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id='departure-fixture' on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE',is_primary=true;
insert into public.tenant_user_contexts(user_id,tenant_id) select id,tenant_id from public.profiles where tenant_id='departure-fixture' on conflict(user_id) do update set tenant_id=excluded.tenant_id;
update public.profiles set professor_id='f9250000-0000-4000-8000-000000000003' where id in ('f9250000-0000-4000-8000-000000000002','f9250000-0000-4000-8000-000000000005');
insert into public.teacher_availability(tenant_id,teacher_id,day_of_week,start_time) values('departure-fixture','f9250000-0000-4000-8000-000000000004',1,'18:30');
insert into public.bookings(tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date,status) values
 ('departure-fixture','f9250000-0000-4000-8000-000000000003','f9250000-0000-4000-8000-000000000002','Segunda','18:30',current_date-60,'SCHEDULED'),
 ('departure-fixture','f9250000-0000-4000-8000-000000000003','f9250000-0000-4000-8000-000000000005','Terça','19:00',current_date-60,'SCHEDULED');
-- Três fechamentos de R$ 300 antes do mês do aviso: base 300.
insert into public.teacher_closings(tenant_id,teacher_id,month_year,total_lessons,total_amount,status,paid_at)
 select 'departure-fixture','f9250000-0000-4000-8000-000000000003',to_char((now() at time zone 'America/Sao_Paulo')::date - (k||' months')::interval,'YYYY-MM'),30,300,'PAGO',now()
   from generate_series(1,3) k;

select pg_temp.as_user('f9250000-0000-4000-8000-000000000001');
do $$
declare
  v_notice timestamptz := now();
  v_last date := (now() at time zone 'America/Sao_Paulo')::date + 2;
  preview jsonb; opened jsonb; state jsonb; cabe jsonb; sobra jsonb;
begin
  preview := public.teacher_departure_preview('f9250000-0000-4000-8000-000000000003', v_notice, v_last);
  select value into cabe from jsonb_array_elements(preview->'students') where value->>'student_id'='f9250000-0000-4000-8000-000000000002';
  select value into sobra from jsonb_array_elements(preview->'students') where value->>'student_id'='f9250000-0000-4000-8000-000000000005';
  perform pg_temp.assert_true(jsonb_array_length(preview->'students')=2,'preview lists both students');
  perform pg_temp.assert_true(cabe->'candidates' @> '[{"id":"f9250000-0000-4000-8000-000000000004"}]','free teacher is a candidate');
  perform pg_temp.assert_true(jsonb_array_length(sobra->'candidates')=0,'nobody fits the other student');
  perform pg_temp.assert_true(cabe->'slots'='[{"day_of_week":"Segunda","time_slot":"18:30"}]'::jsonb,'slots in transfer format');
  -- 2 dias cumpridos, 28 sem cumprir: 300 × 28 ÷ 30 = 280.
  perform pg_temp.assert_true((preview->'penalty'->>'days_missing')::int=28,'missing days');
  perform pg_temp.assert_true((preview->'penalty'->>'general_penalty')::numeric=280,'general penalty proportional');
  perform pg_temp.assert_true((preview->'penalty'->>'total')::numeric=280,'total without individual terms');
  perform pg_temp.assert_true(not exists(select 1 from public.teacher_departures where tenant_id='departure-fixture'),'preview writes nothing');

  opened := public.open_teacher_departure('f9250000-0000-4000-8000-000000000003', v_notice, v_last, 'Proposta de emprego, aviso curto');
  perform pg_temp.assert_true((opened->>'offers')::int=2 and (opened->>'without_candidate')::int=1 and (opened->>'teachers_notified')::int=1,'open counts');
  perform pg_temp.assert_true((select count(*)=1 from public.notification_queue where tenant_id='departure-fixture'
     and idempotency_key like 'teacher-departure:%:invite:f9250000-0000-4000-8000-000000000004'),'invite queued once for the fitting teacher');
  begin
    perform public.open_teacher_departure('f9250000-0000-4000-8000-000000000003', v_notice, v_last, 'Proposta de emprego, aviso curto');
    raise exception 'second open accepted';
  exception when unique_violation then null; end;
  state := public.get_teacher_departure('f9250000-0000-4000-8000-000000000003');
  perform pg_temp.assert_true(state->'departure'->>'status'='OPEN' and jsonb_array_length(state->'students')=2,'state readable');
end $$;

-- O professor que cabe enxerga só o aluno que cabe, sem o nome completo.
select pg_temp.as_user('f9250000-0000-4000-8000-000000000004');
do $$
declare mine jsonb; claimed jsonb; again jsonb; v_offer uuid;
begin
  mine := public.my_departure_offers();
  perform pg_temp.assert_true(jsonb_array_length(mine)=1,'only fitting student listed');
  perform pg_temp.assert_true(mine->0->>'student_label'='Aluna S.','first name + initial only');
  v_offer := (mine->0->>'offer_id')::uuid;
  claimed := public.claim_departure_offer(v_offer);
  perform pg_temp.assert_true(claimed->>'ok'='true','claim ok');
  perform pg_temp.assert_true(auth.uid()='f9250000-0000-4000-8000-000000000004','session identity restored after acting as the school');
  perform pg_temp.assert_true((select t.status in ('ACCEPTED','APPLIED') and t.to_teacher_id='f9250000-0000-4000-8000-000000000004' and t.token='direct:'||v_offer::text
     from public.teacher_transfers t where t.id=(claimed->>'transfer_id')::uuid),'official transfer scheduled');
  perform pg_temp.assert_true((select professor_id='f9250000-0000-4000-8000-000000000003' from public.profiles where id='f9250000-0000-4000-8000-000000000002'),'no early switch before cutover');
  perform pg_temp.assert_true((select count(*)=1 from public.notification_queue where idempotency_key='teacher-departure-offer:'||v_offer::text||':family'),'family told once (school without individual terms)');
  again := public.claim_departure_offer(v_offer);
  perform pg_temp.assert_true(again->>'ok'='false' and again->>'error'='aluno_ja_atribuido','second claim refused');
  perform pg_temp.assert_true(jsonb_array_length(public.my_departure_offers())=0,'claimed student leaves the board');
end $$;

-- Quem está saindo não vê os próprios alunos; aluno de fora da agenda não é atribuído.
select pg_temp.as_user('f9250000-0000-4000-8000-000000000003');
select pg_temp.assert_true(jsonb_array_length(public.my_departure_offers())=0,'leaving teacher sees nothing');
do $$begin perform public.get_teacher_departure('f9250000-0000-4000-8000-000000000003'); raise exception 'teacher read departure';
exception when insufficient_privilege then null; end $$;

select pg_temp.as_user('f9250000-0000-4000-8000-000000000001');
do $$
declare v_offer uuid; res jsonb; closed jsonb;
begin
  select id into v_offer from public.teacher_departure_offers where student_id='f9250000-0000-4000-8000-000000000005';
  res := public.assign_departure_offer(v_offer,'f9250000-0000-4000-8000-000000000004');
  perform pg_temp.assert_true(res->>'ok'='false' and res->>'error'='horario_indisponivel','assignment checks the schedule');
  closed := public.close_teacher_departure((select departure_id from public.teacher_departure_offers where id=v_offer),'Encerrada pela direção no teste');
  perform pg_temp.assert_true((closed->>'offers_cancelled')::int=1,'open offers cancelled on close');
end $$;

-- Aluno com troca já marcada saindo do professor não volta a ser oferecido.
select pg_temp.as_user('f9250000-0000-4000-8000-000000000001');
do $$begin
  perform pg_temp.assert_true(not exists(select 1 from jsonb_array_elements(public.teacher_departure_preview('f9250000-0000-4000-8000-000000000003', now(), (now() at time zone 'America/Sao_Paulo')::date + 2)->'students') x
    where x->>'student_id'='f9250000-0000-4000-8000-000000000002'),'student with a scheduled transfer is not offered again');
end $$;
select pg_temp.assert_true(not has_function_privilege('anon','public.claim_departure_offer(uuid)','execute'),'anon cannot claim');
select pg_temp.assert_true(not has_function_privilege('anon','public.open_teacher_departure(uuid,timestamptz,date,text)','execute'),'anon cannot open');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.teacher_departure_offers','select'),'offers only through RPC');
select pg_temp.assert_true(exists(select 1 from pg_trigger where tgname='zz_departure_apply_on_term_executed'),'term executed applies the transfer');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.claim_student_opportunity(uuid)','execute'),'legacy board closed');
rollback;
