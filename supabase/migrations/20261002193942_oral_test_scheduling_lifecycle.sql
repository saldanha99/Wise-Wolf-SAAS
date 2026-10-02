-- Teste oral: reserva datada, avisos e lembretes pela fila oficial.
-- Não cria aula dada, pagamento, cobertura nem transferência de titularidade.
alter table public.oral_tests add column if not exists appointment_id uuid references public.appointments(id);
alter table public.oral_tests add column if not exists schedule_version integer not null default 0;
create unique index if not exists oral_tests_appointment_idx on public.oral_tests(appointment_id) where appointment_id is not null;

create or replace function private.oral_test_lock_slot(p_teacher uuid,p_start timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
declare slot timestamp; local_start timestamp:=p_start at time zone 'America/Sao_Paulo';
begin
  for slot in select date_trunc('hour',local_start)+(floor(extract(minute from local_start)/30)*30)*interval '1 minute'+i*interval '30 minutes' from generate_series(0,1) i order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('schedule:teacher:'||p_teacher||':'||public.fold_accents(case extract(dow from slot)::integer when 0 then 'Domingo' when 1 then 'Segunda' when 2 then 'Terça' when 3 then 'Quarta' when 4 then 'Quinta' when 5 then 'Sexta' when 6 then 'Sábado' end)||':'||to_char(slot,'HH24:MI'),0));
  end loop;
end; $$;
alter function private.oral_test_lock_slot(uuid,timestamptz) owner to postgres;
revoke all on function private.oral_test_lock_slot(uuid,timestamptz) from public,anon,authenticated,service_role;

create or replace function private.oral_test_notice_snapshot(p_test uuid,p_kind text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t public.oral_tests%rowtype; s public.profiles%rowtype; e public.profiles%rowtype;
  a public.appointments%rowtype; recipient public.profiles%rowtype; phone text; message text; label text;
begin
  select * into t from public.oral_tests where id=p_test;
  if not found or t.status<>'SCHEDULED' or t.scheduled_at<=now() or t.appointment_id is null then
    return jsonb_build_object('ok',false,'reason','oral_test_not_upcoming'); end if;
  select * into s from public.profiles where id=t.student_id and tenant_id=t.tenant_id and role='STUDENT';
  select * into e from public.profiles where id=t.examiner_id and tenant_id=t.tenant_id and role='TEACHER';
  select * into a from public.appointments where id=t.appointment_id and tenant_id=t.tenant_id and type='oral_test';
  if s.id is null or not public.is_student_notifiable(s.id) or e.id is null
    or not e.can_oral_test or e.id in(s.professor_id,s.professor_id2)
    or lower(coalesce(e.status,'')) in('inativo','inactive','arquivado','cancelado')
    or coalesce(s.lifecycle_status,'active')<>'active' or coalesce(e.lifecycle_status,'active')<>'active'
    or a.id is null or a.status<>'scheduled' or a.start_time is distinct from t.scheduled_at
    or a.teacher_id is distinct from e.id or a.professor_id is distinct from e.id then
    return jsonb_build_object('ok',false,'reason','oral_test_binding_changed'); end if;
  if coalesce(s.is_test_account,false) or coalesce(e.is_test_account,false)
    or exists(select 1 from auth.users u where u.id in(s.id,e.id) and
      (u.raw_user_meta_data @> '{"test_fixture":true}' or u.raw_user_meta_data @> '{"testMode":true}')) then
    return jsonb_build_object('ok',false,'reason','test_fixture_suppressed'); end if;
  if p_kind not in('ORAL_TEST_STUDENT','ORAL_TEST_TEACHER','ORAL_TEST_REMINDER_STUDENT','ORAL_TEST_REMINDER_TEACHER') then
    return jsonb_build_object('ok',false,'reason','oral_test_kind_invalid'); end if;
  recipient:=case when p_kind like '%TEACHER' then e else s end;
  phone:=private.normalize_notification_phone(coalesce(nullif(btrim(recipient.phone),''),nullif(btrim(recipient.attendance_phone),'')));
  if phone is null then return jsonb_build_object('ok',false,'reason','oral_test_phone_missing'); end if;
  label:=case when p_kind like 'ORAL_TEST_REMINDER_%' then 'Lembrete de teste oral' else 'Teste oral agendado' end;
  message:=format(E'🎓 *%s*\nAluno: *%s*\nExaminador: *%s*\nData: *%s* (horário de Brasília)\nDuração: 30 minutos.\n',label,
    regexp_replace(coalesce(s.full_name,'Aluno'),'[\n\r*]',' ','g'),
    regexp_replace(coalesce(e.full_name,'Professor'),'[\n\r*]',' ','g'),
    to_char(t.scheduled_at at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'));
  message:=message||case when p_kind like '%TEACHER' then
    E'Este horário está reservado na sua agenda. Aplique a avaliação e registre o resultado em Testes Orais.' else
    E'Você fará uma conversa em inglês para acompanhar seu progresso. Confira este compromisso na sua Agenda.' end;
  -- A mesma sala do examinador chega aos dois. Não inventa sala oficial do Meet.
  if a.meeting_link ~ '^https://' then message:=message||E'\nLink do teste: '||a.meeting_link;
  else message:=message||E'\nO link do teste será combinado com a escola.'; end if;
  return jsonb_build_object('ok',true,'tenant_id',t.tenant_id,'destination',phone,'message',message,
    'teacherId',case when p_kind like '%TEACHER' then e.id else null end,'version',t.schedule_version);
end; $$;
alter function private.oral_test_notice_snapshot(uuid,text) owner to postgres;
revoke all on function private.oral_test_notice_snapshot(uuid,text) from public,anon,authenticated,service_role;

create or replace function private.enqueue_oral_test_notices(p_test uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.oral_tests%rowtype; kind text; s jsonb; results jsonb:='{}';
begin
  select * into t from public.oral_tests where id=p_test;
  foreach kind in array array['ORAL_TEST_STUDENT','ORAL_TEST_TEACHER','ORAL_TEST_REMINDER_STUDENT','ORAL_TEST_REMINDER_TEACHER'] loop
    s:=private.oral_test_notice_snapshot(t.id,kind);
    if (s->>'ok')::boolean then
      insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,
        scheduled_for,source_type,source_id,notification_kind,idempotency_key)
      values(t.tenant_id,nullif(s->>'teacherId','')::uuid,case when kind like '%STUDENT' then t.student_id else null end,
        'Teste oral',s->>'destination',s->>'message',case when kind like 'ORAL_TEST_REMINDER_%' then greatest(now(),t.scheduled_at-interval '30 minutes') else now() end,
        'ORAL_TEST',t.id,kind,'oral-test:'||t.id||':'||t.schedule_version||':'||kind)
      on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
    end if;
    results:=results||jsonb_build_object(kind,case when (s->>'ok')::boolean then 'queued' else s->>'reason' end);
  end loop;
  return results;
end; $$;
alter function private.enqueue_oral_test_notices(uuid) owner to postgres;
revoke all on function private.enqueue_oral_test_notices(uuid) from public,anon,authenticated,service_role;

create or replace function public.get_oral_test_notice_snapshot(p_notification_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare q public.notification_queue%rowtype; s jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then return jsonb_build_object('ok',false,'reason','forbidden'); end if;
  select * into q from public.notification_queue where id=p_notification_id and source_type='ORAL_TEST';
  if not found then return jsonb_build_object('ok',false,'reason','oral_test_notice_invalid'); end if;
  s:=private.oral_test_notice_snapshot(q.source_id,q.notification_kind);
  if not coalesce((s->>'ok')::boolean,false) then return s; end if;
  if q.idempotency_key is distinct from 'oral-test:'||q.source_id||':'||(s->>'version')||':'||q.notification_kind
    or q.tenant_id is distinct from s->>'tenant_id' or q.student_phone is distinct from s->>'destination'
    or q.message_body is distinct from s->>'message' or q.teacher_id is distinct from nullif(s->>'teacherId','')::uuid then
    return jsonb_build_object('ok',false,'reason','oral_test_snapshot_changed'); end if;
  return s;
end; $$;
alter function public.get_oral_test_notice_snapshot(uuid) owner to postgres;
revoke all on function public.get_oral_test_notice_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.get_oral_test_notice_snapshot(uuid) to service_role;

create or replace function private.sync_oral_test_reservation()
returns trigger language plpgsql security definer set search_path='' as $$
declare student public.profiles%rowtype; examiner public.profiles%rowtype; a_id uuid;
begin
  if tg_op='UPDATE' and new.status is not distinct from old.status and new.examiner_id is not distinct from old.examiner_id
    and new.scheduled_at is not distinct from old.scheduled_at and new.appointment_id is not distinct from old.appointment_id
    and not (new.status='SCHEDULED' and new.examiner_id is not null and new.appointment_id is null) then return new; end if;
  if new.status='SCHEDULED' and new.scheduled_at is not null then
    if new.examiner_id is null then
      -- Diretoria sem examinador nomeado: continua no painel, sem agenda fictícia.
      if new.appointment_id is not null then update public.appointments set status='cancelled' where id=new.appointment_id; end if;
      new.appointment_id:=null; new.schedule_version:=new.schedule_version+1; return new;
    end if;
    select * into student from public.profiles where id=new.student_id and tenant_id=new.tenant_id and role='STUDENT';
    select * into examiner from public.profiles where id=new.examiner_id and tenant_id=new.tenant_id and role='TEACHER' and can_oral_test;
    if student.id is null or examiner.id is null or examiner.id=new.native_teacher_id
      or examiner.id in(student.professor_id,student.professor_id2)
      or not public.is_student_notifiable(student.id) or coalesce(student.lifecycle_status,'active')<>'active'
      or coalesce(examiner.lifecycle_status,'active')<>'active'
      or lower(coalesce(examiner.status,'')) in('inativo','inactive','arquivado','cancelado') then
      raise exception 'Examinador inválido: escolha um professor apto e ativo que não seja professor do aluno.'; end if;
    if new.scheduled_at<=now() then raise exception 'Escolha uma data e hora futuras.'; end if;
    if extract(minute from new.scheduled_at)::integer%30<>0 or extract(second from new.scheduled_at)<>0 then
      raise exception 'Use um horário de 30 minutos (ex.: 19:00 ou 19:30).'; end if;
    perform private.oral_test_lock_slot(examiner.id,new.scheduled_at);
    if exists(select 1 from public.upcoming_classes u where u.tenant_id=new.tenant_id and u.teacher_id=examiner.id
      and u.start_at>new.scheduled_at-interval '30 minutes' and u.start_at<new.scheduled_at+interval '30 minutes'
      and (u.source_type<>'appointment' or u.source_id is distinct from new.appointment_id))
      or exists(select 1 from public.appointments a where a.tenant_id=new.tenant_id and examiner.id in(a.teacher_id,a.professor_id)
        and a.id is distinct from new.appointment_id and lower(a.status) in('scheduled','confirmed')
        and abs(extract(epoch from a.start_time-new.scheduled_at))<1800)
      or exists(select 1 from public.class_coverages c where c.tenant_id=new.tenant_id and c.cover_teacher_id=examiner.id
        and lower(c.status) in('pending','confirmed') and c.class_date=(new.scheduled_at at time zone 'America/Sao_Paulo')::date
        and abs(extract(epoch from c.class_time::time-(new.scheduled_at at time zone 'America/Sao_Paulo')::time))<1800)
      or exists(select 1 from private.trial_closing_schedule_holds h where h.tenant_id=new.tenant_id and h.teacher_id=examiner.id
        and h.status='HELD' and h.expires_at>now() and h.day_of_week=extract(dow from new.scheduled_at at time zone 'America/Sao_Paulo')::integer
        and abs(extract(epoch from h.class_time-(new.scheduled_at at time zone 'America/Sao_Paulo')::time))<1800) then
      raise exception using errcode='23P01',message='O examinador já tem um compromisso nesse horário. Escolha outro horário.'; end if;
    a_id:=coalesce(new.appointment_id,new.id);
    insert into public.appointments(id,tenant_id,teacher_id,professor_id,student_name,start_time,type,status,meeting_link)
      values(a_id,new.tenant_id,examiner.id,examiner.id,student.full_name,new.scheduled_at,'oral_test','scheduled',examiner.meeting_link)
    on conflict(id) do update set teacher_id=excluded.teacher_id,professor_id=excluded.professor_id,
      start_time=excluded.start_time,status='scheduled',meeting_link=excluded.meeting_link,student_name=excluded.student_name;
    new.appointment_id:=a_id; new.schedule_version:=new.schedule_version+1;
  elsif new.appointment_id is not null then
    update public.appointments set status=case when new.status='DONE' then 'completed' else 'cancelled' end where id=new.appointment_id;
  end if;
  return new;
end; $$;
alter function private.sync_oral_test_reservation() owner to postgres;
revoke all on function private.sync_oral_test_reservation() from public,anon,authenticated,service_role;
drop trigger if exists oral_test_reservation on public.oral_tests;
create trigger oral_test_reservation before insert or update on public.oral_tests for each row execute function private.sync_oral_test_reservation();

create or replace function private.queue_oral_test_notices()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' or new.schedule_version is distinct from old.schedule_version or new.status is distinct from old.status then
    update public.notification_queue set status='skipped',delivery_status='skipped',last_error='oral_test_schedule_changed',updated_at=now()
      where source_type='ORAL_TEST' and source_id=new.id and status='pending';
    if new.status='SCHEDULED' then perform private.enqueue_oral_test_notices(new.id); end if;
  end if;
  return new;
end; $$;
alter function private.queue_oral_test_notices() owner to postgres;
revoke all on function private.queue_oral_test_notices() from public,anon,authenticated,service_role;
drop trigger if exists oral_test_notices on public.oral_tests;
create trigger oral_test_notices after insert or update on public.oral_tests for each row execute function private.queue_oral_test_notices();

create or replace function public.schedule_oral_test(p_test_id uuid,p_examiner_id uuid,p_scheduled_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles%rowtype; t public.oral_tests%rowtype;
begin
  select * into actor from public.profiles where id=auth.uid();
  if coalesce(public._my_role(),'') not in('SCHOOL_ADMIN','SUPER_ADMIN') then raise exception using errcode='42501',message='Administrator role required'; end if;
  select * into t from public.oral_tests where id=p_test_id and (public._my_role()='SUPER_ADMIN' or tenant_id=public._my_tenant_id()) for update;
  if not found then raise exception using errcode='42501',message='Oral test is outside the allowed tenant'; end if;
  if t.status in('DONE','SKIPPED') then raise exception 'Completed oral tests cannot be scheduled'; end if;
  if p_scheduled_at is null or p_scheduled_at<=now() then raise exception 'Escolha uma data e hora futuras.'; end if;
  if t.status='SCHEDULED' and t.examiner_id is not distinct from p_examiner_id and t.scheduled_at=p_scheduled_at and (t.appointment_id is not null or p_examiner_id is null) then
    return jsonb_build_object('test_id',t.id,'status',t.status,'unchanged',true); end if;
  update public.oral_tests set examiner_id=p_examiner_id,scheduled_at=p_scheduled_at,status='SCHEDULED' where id=t.id returning * into t;
  return jsonb_build_object('test_id',t.id,'status',t.status,'scheduled_at',t.scheduled_at,'examiner_id',t.examiner_id,'reserved',t.appointment_id is not null,'notices',private.enqueue_oral_test_notices(t.id));
end; $$;
alter function public.schedule_oral_test(uuid,uuid,timestamptz) owner to postgres;
revoke all on function public.schedule_oral_test(uuid,uuid,timestamptz) from public,anon;
grant execute on function public.schedule_oral_test(uuid,uuid,timestamptz) to authenticated;

create or replace function public.unschedule_oral_test(p_test_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if coalesce(public._my_role(),'') not in('SCHOOL_ADMIN','SUPER_ADMIN') then raise exception using errcode='42501',message='Administrator role required'; end if;
  update public.oral_tests set status='DUE',scheduled_at=null,examiner_id=null
    where id=p_test_id and status='SCHEDULED' and (public._my_role()='SUPER_ADMIN' or tenant_id=public._my_tenant_id());
  if not found then raise exception 'Teste indisponível para desmarcar.'; end if;
end; $$;
alter function public.unschedule_oral_test(uuid) owner to postgres;
revoke all on function public.unschedule_oral_test(uuid) from public,anon;
grant execute on function public.unschedule_oral_test(uuid) to authenticated;

create or replace function public.my_oral_test_agenda()
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'scheduled_at',t.scheduled_at,'student_name',s.full_name,
   'examiner_name',coalesce(e.full_name,'Diretoria'),'meeting_link',a.meeting_link) order by t.scheduled_at),'[]'::jsonb)
 from public.oral_tests t join public.profiles s on s.id=t.student_id and s.tenant_id=t.tenant_id
 left join public.profiles e on e.id=t.examiner_id and e.tenant_id=t.tenant_id
 left join public.appointments a on a.id=t.appointment_id and a.tenant_id=t.tenant_id and a.status='scheduled'
 where t.tenant_id=public._my_tenant_id() and t.status='SCHEDULED' and t.scheduled_at+interval '30 minutes'>now()
   and ((public._my_role()='STUDENT' and t.student_id=auth.uid()) or (public._my_role()='TEACHER' and t.examiner_id=auth.uid()));
$$;
alter function public.my_oral_test_agenda() owner to postgres;
revoke all on function public.my_oral_test_agenda() from public,anon;
grant execute on function public.my_oral_test_agenda() to authenticated;

-- Mantém todas as cercas anteriores; adiciona a prova antes de autorizar envio/replay.
do $patch$
declare definition text; anchor text:=E'  if v_kind not in (\n    ''TRIAL_TEACHER_REQUESTED'',';
begin
  select pg_get_functiondef('public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)'::regprocedure) into definition;
  if position('-- oral_test_submission_guard' in definition)=0 then
    if position(anchor in definition)=0 then raise exception 'oral_test_submission_anchor_missing'; end if;
    definition:=replace(definition,anchor,$guard$
  -- oral_test_submission_guard
  if v_kind in('ORAL_TEST_STUDENT','ORAL_TEST_TEACHER','ORAL_TEST_REMINDER_STUDENT','ORAL_TEST_REMINDER_TEACHER') then
    begin
      perform id from public.oral_tests where id=v_notification.source_id and tenant_id=v_notification.tenant_id for share nowait;
      perform id from public.profiles where id in(select student_id from public.oral_tests where id=v_notification.source_id
        union select examiner_id from public.oral_tests where id=v_notification.source_id) order by id for share nowait;
      perform id from public.appointments where id=(select appointment_id from public.oral_tests where id=v_notification.source_id) for share nowait;
    exception when lock_not_available then
      return jsonb_build_object('ok',false,'action','RETRY','reason','oral_test_source_busy');
    end;
    v_snapshot:=public.get_oral_test_notice_snapshot(p_notification_id);
    if not coalesce((v_snapshot->>'ok')::boolean,false)
      or v_snapshot->>'destination' is distinct from p_expected_destination
      or v_snapshot->>'message' is distinct from p_expected_message_body then
      return jsonb_build_object('ok',false,'action','REVIEW_REQUIRED','reason',coalesce(v_snapshot->>'reason','oral_test_snapshot_changed'));
    end if;
  end if;
$guard$||anchor);
    execute definition;
  end if;
end; $patch$;

create or replace function public.oral_test_panel_context()
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'student_name',s.full_name,'examiner_name',e.full_name,
   'notices',(select coalesce(jsonb_object_agg(q.notification_kind,q.delivery_status),'{}'::jsonb)
      from public.notification_queue q where q.source_type='ORAL_TEST' and q.source_id=t.id
      and q.idempotency_key='oral-test:'||t.id||':'||t.schedule_version||':'||q.notification_kind))), '[]'::jsonb)
 from public.oral_tests t join public.profiles s on s.id=t.student_id and s.tenant_id=t.tenant_id
 left join public.profiles e on e.id=t.examiner_id and e.tenant_id=t.tenant_id
 where public._my_role()='SUPER_ADMIN' or (t.tenant_id=public._my_tenant_id()
   and (public._my_role() in('SCHOOL_ADMIN','COORDINATOR') or (public._my_role()='TEACHER' and t.examiner_id=auth.uid())));
$$;
alter function public.oral_test_panel_context() owner to postgres;
revoke all on function public.oral_test_panel_context() from public,anon;
grant execute on function public.oral_test_panel_context() to authenticated;

-- Os escritores de agenda compartilham a trava de slot. Nenhum deles pode
-- ocupar uma reserva oral viva; recorrência continua sendo recorrência.
create or replace function private.protect_oral_test_slot()
returns trigger language plpgsql security definer set search_path='' as $$
declare teacher uuid; starts timestamptz; reserved public.oral_tests%rowtype; local_start timestamp;
  row_data jsonb:=to_jsonb(new); candidate_date date;
begin
  if tg_table_name='appointments' then
    if lower(coalesce(new.status,'')) not in('scheduled','confirmed') then return new; end if;
    teacher:=coalesce(new.teacher_id,new.professor_id); starts:=new.start_time;
  elsif tg_table_name='reschedules' then
    if new.used_at is not null or row_data->>'closed_reason' is not null or coalesce(new.date,'') !~ '^\d{4}-\d{2}-\d{2}$' or new.time is null then return new; end if;
    teacher:=new.teacher_id; starts:=(new.date||' '||new.time)::timestamp at time zone 'America/Sao_Paulo';
  elsif tg_table_name='class_coverages' then
    if lower(coalesce(new.status,'')) not in('pending','confirmed') then return new; end if;
    teacher:=new.cover_teacher_id; starts:=(new.class_date||' '||new.class_time)::timestamp at time zone 'America/Sao_Paulo';
  elsif tg_table_name='lesson_advances' then
    if new.status<>'SCHEDULED' or new.advance_time is null then return new; end if;
    teacher:=new.teacher_id; starts:=(new.advance_date+new.advance_time) at time zone 'America/Sao_Paulo';
  else
    if lower(coalesce(new.status,''))<>'scheduled' then return new; end if;
    teacher:=new.teacher_id;
    -- Grade fixa: trava o mesmo par dia/horário, independente da semana.
    starts:=((now() at time zone 'America/Sao_Paulo')::date+new.time_slot::time) at time zone 'America/Sao_Paulo';
    starts:=starts+((public.dow_name_to_int(new.day_of_week)-extract(dow from starts at time zone 'America/Sao_Paulo')::integer+7)%7)*interval '1 day';
  end if;
  if teacher is null or starts is null then return new; end if;
  perform private.oral_test_lock_slot(teacher,starts);
  for reserved in select * from public.oral_tests t where t.tenant_id=new.tenant_id and t.examiner_id=teacher
    and t.status='SCHEDULED' and t.scheduled_at+interval '30 minutes'>now() loop
    if tg_table_name='appointments' and (reserved.appointment_id=new.id or (new.type='oral_test' and reserved.id=new.id)) then continue; end if;
    local_start:=reserved.scheduled_at at time zone 'America/Sao_Paulo';
    candidate_date:=local_start::date;
    if tg_table_name='bookings' then
      if public.dow_name_to_int(new.day_of_week)<>extract(dow from local_start)::integer
        or (new.date is not null and new.date<>candidate_date)
        or (new.start_date is not null and new.start_date>candidate_date)
        or abs(extract(epoch from new.time_slot::time-local_start::time))>=1800 then continue; end if;
    elsif abs(extract(epoch from starts-reserved.scheduled_at))>=1800 then continue;
    end if;
    raise exception using errcode='23P01',message='O horário está reservado para um teste oral.';
  end loop;
  return new;
end; $$;
alter function private.protect_oral_test_slot() owner to postgres;
revoke all on function private.protect_oral_test_slot() from public,anon,authenticated,service_role;
drop trigger if exists zz_protect_oral_test_slot on public.appointments;
create trigger zz_protect_oral_test_slot before insert or update on public.appointments for each row execute function private.protect_oral_test_slot();
drop trigger if exists zz_protect_oral_test_slot on public.bookings;
create trigger zz_protect_oral_test_slot before insert or update on public.bookings for each row execute function private.protect_oral_test_slot();
drop trigger if exists zz_protect_oral_test_slot on public.reschedules;
create trigger zz_protect_oral_test_slot before insert or update on public.reschedules for each row execute function private.protect_oral_test_slot();
drop trigger if exists zz_protect_oral_test_slot on public.class_coverages;
create trigger zz_protect_oral_test_slot before insert or update on public.class_coverages for each row execute function private.protect_oral_test_slot();
drop trigger if exists zz_protect_oral_test_slot on public.lesson_advances;
create trigger zz_protect_oral_test_slot before insert or update on public.lesson_advances for each row execute function private.protect_oral_test_slot();

create or replace function private.remove_oral_test_reservation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  update public.appointments set status='cancelled' where id=old.appointment_id and type='oral_test';
  update public.notification_queue set status='skipped',delivery_status='skipped',last_error='oral_test_deleted',updated_at=now()
    where source_type='ORAL_TEST' and source_id=old.id and status='pending';
  return old;
end; $$;
alter function private.remove_oral_test_reservation() owner to postgres;
revoke all on function private.remove_oral_test_reservation() from public,anon,authenticated,service_role;
drop trigger if exists oral_test_deleted on public.oral_tests;
create trigger oral_test_deleted after delete on public.oral_tests for each row execute function private.remove_oral_test_reservation();
