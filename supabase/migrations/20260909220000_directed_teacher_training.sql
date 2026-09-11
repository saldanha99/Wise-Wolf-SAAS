begin;

create table public.teacher_training_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  trainer_id uuid not null references public.profiles(id),
  trainee_id uuid not null references public.profiles(id),
  trainer_name text not null,
  trainee_name text not null,
  trainee_phone text not null,
  meeting_link text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  agreed_rate numeric(10,2) not null default 16 check (agreed_rate = 16),
  status text not null default 'PENDING' check (status in ('PENDING','CONFIRMED','DECLINED','CANCELLED','COMPLETED')),
  appointment_id uuid unique references public.appointments(id),
  class_log_id uuid unique references public.class_logs(id),
  request_id text not null,
  created_by uuid references public.profiles(id),
  test_fixture boolean not null default false,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (trainer_id <> trainee_id),
  check (ends_at = starts_at + interval '30 minutes'),
  unique (tenant_id, request_id)
);
create index teacher_training_sessions_agenda on public.teacher_training_sessions(tenant_id, starts_at) where status in ('PENDING','CONFIRMED');
create table private.teacher_training_invite_tokens (
  token_hash text primary key,
  session_id uuid not null unique references public.teacher_training_sessions(id) on delete cascade,
  expires_at timestamptz not null
);
revoke all on private.teacher_training_invite_tokens from public,anon,authenticated,service_role;
alter table public.teacher_training_sessions enable row level security;
revoke all on public.teacher_training_sessions from public,anon,authenticated;
grant select on public.teacher_training_sessions to authenticated;
grant all on public.teacher_training_sessions to service_role;
create policy training_session_read on public.teacher_training_sessions for select to authenticated using (
  exists (select 1 from public.tenant_memberships m where m.user_id = (select auth.uid()) and m.tenant_id = teacher_training_sessions.tenant_id and m.status = 'ACTIVE' and
    (m.role in ('SCHOOL_ADMIN','COORDINATOR') or m.user_id in (trainer_id,trainee_id)))
);

create function private.training_manager(p_tenant text,p_actor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.tenant_memberships m join public.profiles p on p.id=m.user_id where m.tenant_id=p_tenant and m.user_id=p_actor and m.status='ACTIVE' and m.role in ('SCHOOL_ADMIN','COORDINATOR') and lower(coalesce(p.lifecycle_status,'active'))='active');
$$;
revoke all on function private.training_manager(text,uuid) from public,anon,authenticated;

create function private.validate_training_slot(p_tenant text,p_trainer uuid,p_trainee uuid,p_start timestamptz,p_exclude uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_date date := (p_start at time zone 'America/Sao_Paulo')::date; v_time text := to_char(p_start at time zone 'America/Sao_Paulo','HH24:MI'); v_day text; v_teacher uuid;
begin
  if p_start is null or p_start <= now() or p_start > now()+interval '90 days' or to_char(p_start at time zone 'America/Sao_Paulo','MI:SS') not in ('00:00','30:00') then
    raise exception 'Escolha um horário futuro, em intervalos de 30 minutos, nos próximos 90 dias.';
  end if;
  v_day := (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from v_date)::int+1];
  for v_teacher in select distinct unnest(array[p_trainer,p_trainee]) order by 1 loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:teacher:'||v_teacher::text||':'||public.fold_accents(v_day)||':'||v_time,0));
    if not exists(select 1 from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p_tenant and m.status='ACTIVE' and m.role='TEACHER' where p.id=v_teacher and p.tenant_id=p_tenant and p.role='TEACHER' and lower(coalesce(p.lifecycle_status,'active'))='active' and (p.id<>p_trainer or p.is_trainer=true)) then
      raise exception 'O treinador precisa estar habilitado e os dois teachers precisam estar ativos nesta escola.';
    end if;
    if exists(select 1 from public.bookings b where b.tenant_id=p_tenant and b.teacher_id=v_teacher and upper(coalesce(b.status,''))<>'CANCELLED' and left(b.time_slot,5)=v_time and (b.date=v_date or (b.date is null and public.fold_accents(b.day_of_week)=public.fold_accents(v_day) and (b.start_date is null or b.start_date<=v_date))))
      or exists(select 1 from public.reschedules r where r.tenant_id=p_tenant and r.teacher_id=v_teacher and public.parse_lesson_date(r.date)=v_date and left(r.time,5)=v_time and r.used_at is null)
      or exists(select 1 from public.appointments a where a.tenant_id=p_tenant and v_teacher in (a.teacher_id,a.professor_id) and lower(a.status) in ('scheduled','confirmed') and abs(extract(epoch from a.start_time-p_start))<1800)
      or exists(select 1 from public.class_coverages c where c.tenant_id=p_tenant and c.cover_teacher_id=v_teacher and c.class_date=v_date and left(c.class_time,5)=v_time and (c.status='confirmed' or (c.status='pending' and coalesce(c.invite_expires_at,p_start)>now())))
      or exists(select 1 from public.teacher_absences a where a.tenant_id=p_tenant and a.teacher_id=v_teacher and a.status='active' and a.starts_at::date<=v_date and a.ends_at::date>=v_date)
      or exists(select 1 from public.teacher_training_sessions t where t.tenant_id=p_tenant and v_teacher in (t.trainer_id,t.trainee_id) and t.status in ('PENDING','CONFIRMED') and t.starts_at < p_start+interval '30 minutes' and t.ends_at>p_start and t.id is distinct from p_exclude)
    then raise exception 'Um dos teachers já possui compromisso ou ausência nesse horário.'; end if;
  end loop;
end;
$$;
revoke all on function private.validate_training_slot(text,uuid,uuid,timestamptz,uuid) from public,anon,authenticated;

create function private.schedule_teacher_training(p_tenant text,p_actor uuid,p_request text,p_trainer uuid,p_trainee uuid,p_start timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.profiles%rowtype; n public.profiles%rowtype; s public.teacher_training_sessions%rowtype; v_token text; v_phone text; v_link text;
begin
  if length(coalesce(p_request,'')) not between 8 and 200 or p_trainer=p_trainee then raise exception 'Pedido inválido: selecione dois teachers diferentes.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('training-request:'||p_tenant||':'||p_request,0));
  select * into s from public.teacher_training_sessions where tenant_id=p_tenant and request_id=p_request;
  if found then
    if s.trainer_id<>p_trainer or s.trainee_id<>p_trainee or s.starts_at<>p_start then raise exception 'Este pedido já foi utilizado para outro treinamento.'; end if;
    return jsonb_build_object('ok',true,'id',s.id,'status',s.status,'idempotent',true);
  end if;
  perform private.validate_training_slot(p_tenant,p_trainer,p_trainee,p_start);
  select * into t from public.profiles where id=p_trainer;
  select * into n from public.profiles where id=p_trainee;
  v_phone := regexp_replace(coalesce(nullif(n.attendance_phone,''),n.phone,''),'[^0-9]','','g');
  if length(v_phone) in (10,11) then v_phone:='55'||v_phone; end if;
  if length(v_phone) not between 12 and 15 then raise exception 'O teacher que receberá o treinamento precisa cadastrar seu WhatsApp.'; end if;
  if coalesce(t.meeting_link,'') !~ '^https://[^[:space:]]+$' then raise exception 'Cadastre o link da sala do treinador antes de enviar o convite.'; end if;
  insert into public.teacher_training_sessions(tenant_id,trainer_id,trainee_id,trainer_name,trainee_name,trainee_phone,meeting_link,starts_at,ends_at,request_id,created_by,test_fixture)
  values(p_tenant,p_trainer,p_trainee,t.full_name,n.full_name,v_phone,t.meeting_link,p_start,p_start+interval '30 minutes',p_request,p_actor,coalesce(t.is_test_account,false) or coalesce(n.is_test_account,false)) returning * into s;
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into private.teacher_training_invite_tokens values(encode(extensions.digest(v_token,'sha256'),'hex'),s.id,p_start);
  v_link:='https://api.wisewolflanguage.com.br/functions/v1/teacher-training-invite?token='||v_token;
  if not s.test_fixture then
    insert into public.notification_queue(tenant_id,student_name,student_phone,message_body,scheduled_for,source_type,source_id,notification_kind,idempotency_key)
    values(p_tenant,n.full_name,v_phone,'Olá, '||n.full_name||'! Você recebeu um convite para treinamento com '||t.full_name||' em '||to_char(p_start at time zone 'America/Sao_Paulo','DD/MM/YYYY "às" HH24:MI')||' (Brasília), duração de 30 minutos. Confira e aceite pelo link: '||v_link,now(),'teacher_training',s.id,'TEACHER_TRAINING_INVITE','teacher-training-invite:'||s.id);
  end if;
  return jsonb_build_object('ok',true,'id',s.id,'status',s.status,'invitation_queued',not s.test_fixture);
end;
$$;
revoke all on function private.schedule_teacher_training(text,uuid,text,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

create function public.schedule_teacher_training(p_tenant text,p_request_id text,p_trainer uuid,p_trainee uuid,p_start timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not private.training_manager(p_tenant,auth.uid()) then raise exception using errcode='42501',message='Apenas a gestão pode agendar treinamentos.'; end if;
 return private.schedule_teacher_training(p_tenant,auth.uid(),p_request_id,p_trainer,p_trainee,p_start);
end;
$$;
revoke all on function public.schedule_teacher_training(text,text,uuid,uuid,timestamptz) from public,anon;
grant execute on function public.schedule_teacher_training(text,text,uuid,uuid,timestamptz) to authenticated;

create function public.gestao_schedule_teacher_training(p_tenant text,p_actor_id uuid,p_request_id text,p_trainer uuid,p_trainee uuid,p_start timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.role(),'')<>'service_role' or not private.management_group_execution_authorized(p_tenant,p_actor_id,p_request_id,
   jsonb_build_object('tipo','agendar_treinamento','trainer_id',p_trainer,'trainee_id',p_trainee,'starts_at',to_char(p_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) then
   raise exception using errcode='42501',message='Confirmação do treinamento não encontrada.';
 end if;
 return private.schedule_teacher_training(p_tenant,p_actor_id,p_request_id,p_trainer,p_trainee,p_start);
end;
$$;
revoke all on function public.gestao_schedule_teacher_training(text,uuid,text,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.gestao_schedule_teacher_training(text,uuid,text,uuid,uuid,timestamptz) to service_role;

create function public.teacher_training_invite(p_token text,p_decision text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.teacher_training_sessions%rowtype; v_appointment uuid; v_phone text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='service_role_required'; end if;
 if p_token !~ '^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'error','Convite inválido.'); end if;
 select t.* into s from public.teacher_training_sessions t join private.teacher_training_invite_tokens k on k.session_id=t.id where k.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and k.expires_at>now() for update of t;
 if not found then return jsonb_build_object('ok',false,'error','Convite inválido ou expirado. Peça um novo agendamento à gestão.'); end if;
 if p_decision is not null and p_decision not in ('accept','decline') then return jsonb_build_object('ok',false,'error','Resposta inválida.'); end if;
 if s.status='PENDING' and p_decision is not null then
   if p_decision='accept' then
     perform private.validate_training_slot(s.tenant_id,s.trainer_id,s.trainee_id,s.starts_at,s.id);
     insert into public.appointments(tenant_id,teacher_id,professor_id,student_name,student_phone,start_time,status,type)
     values(s.tenant_id,s.trainer_id,s.trainer_id,s.trainee_name,s.trainee_phone,s.starts_at,'scheduled','training') returning id into v_appointment;
     update public.teacher_training_sessions set status='CONFIRMED',appointment_id=v_appointment,responded_at=now() where id=s.id returning * into s;
   else
     update public.teacher_training_sessions set status='DECLINED',responded_at=now() where id=s.id returning * into s;
   end if;
   select regexp_replace(coalesce(nullif(attendance_phone,''),phone,''),'[^0-9]','','g') into v_phone from public.profiles where id=s.trainer_id;
   if length(v_phone) in (10,11) then v_phone:='55'||v_phone; end if;
   if not s.test_fixture and length(v_phone) between 12 and 15 then
     insert into public.notification_queue(tenant_id,student_phone,message_body,scheduled_for,source_type,source_id,notification_kind,idempotency_key)
     values(s.tenant_id,v_phone,s.trainee_name||case when s.status='CONFIRMED' then ' aceitou' else ' recusou' end||' o treinamento de '||to_char(s.starts_at at time zone 'America/Sao_Paulo','DD/MM "às" HH24:MI')||'.'||case when s.status='CONFIRMED' then ' Após ministrar o treinamento, registre a conclusão no lançador de aulas para receber R$ 16,00.' else ' Nenhum valor foi lançado.' end,now(),'teacher_training',s.id,'TEACHER_TRAINING_RESPONSE','teacher-training-response:'||s.id);
   end if;
 end if;
 return jsonb_build_object('ok',true,'status',s.status,'trainer',s.trainer_name,'trainee',s.trainee_name,'starts_at',s.starts_at,'ends_at',s.ends_at,'meeting_link',case when s.status='CONFIRMED' then s.meeting_link else null end);
end;
$$;
revoke all on function public.teacher_training_invite(text,text) from public,anon,authenticated;
grant execute on function public.teacher_training_invite(text,text) to service_role;

create function public.cancel_teacher_training(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare s public.teacher_training_sessions%rowtype;
begin
 select * into s from public.teacher_training_sessions where id=p_id for update;
 if not found or not private.training_manager(s.tenant_id,auth.uid()) then raise exception using errcode='42501',message='Apenas a gestão pode cancelar este treinamento.'; end if;
 if s.status='COMPLETED' or s.class_log_id is not null then raise exception 'O treinamento já foi lançado no fechamento.'; end if;
 if s.status in ('CANCELLED','DECLINED') then return; end if;
 update public.teacher_training_sessions set status='CANCELLED' where id=p_id;
 update public.appointments set status='cancelled' where id=s.appointment_id;
end;
$$;
revoke all on function public.cancel_teacher_training(uuid) from public,anon;
grant execute on function public.cancel_teacher_training(uuid) to authenticated;

create function private.protect_training_class_log() returns trigger language plpgsql security definer set search_path='' as $$
declare s public.teacher_training_sessions%rowtype;
begin
 select * into s from public.teacher_training_sessions where appointment_id::text=new.appointment_id for update;
 if not found then return new; end if;
 if s.status not in ('CONFIRMED','COMPLETED') or s.trainer_id is distinct from new.teacher_id or s.tenant_id is distinct from new.tenant_id or s.ends_at>now() or new.class_date is distinct from (s.starts_at at time zone 'America/Sao_Paulo')::date or new.presence is distinct from 'COMPLETED' then
   raise exception 'O treinamento precisa ter aceite e estar concluído para entrar no fechamento.';
 end if;
 if s.class_log_id is not null and s.class_log_id<>new.id then raise exception using errcode='23505',message='Treinamento já lançado.',constraint='uq_class_logs_appointment'; end if;
 new.rate_override:=s.agreed_rate;
 new.subtype:='TREINAMENTO';
 return new;
end;
$$;
create trigger zz_protect_training_class_log before insert or update on public.class_logs for each row execute function private.protect_training_class_log();
create function private.complete_training_class_log() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.teacher_training_sessions set status='COMPLETED',class_log_id=new.id where appointment_id::text=new.appointment_id and trainer_id=new.teacher_id;
 return new;
end;
$$;
create trigger complete_training_class_log after insert on public.class_logs for each row execute function private.complete_training_class_log();
revoke all on function private.protect_training_class_log() from public,anon,authenticated;
revoke all on function private.complete_training_class_log() from public,anon,authenticated;
create function public.teacher_training_scheduler_data(p_tenant text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not private.training_manager(p_tenant,auth.uid()) then raise exception using errcode='42501',message='Acesso restrito à gestão.'; end if;
 return jsonb_build_object(
  'teachers',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,'is_trainer',p.is_trainer) order by p.full_name),'[]'::jsonb) from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p_tenant and m.status='ACTIVE' and m.role='TEACHER' where p.tenant_id=p_tenant and p.role='TEACHER' and lower(coalesce(p.lifecycle_status,'active'))='active'),
  'sessions',(select coalesce(jsonb_agg(to_jsonb(x) order by starts_at desc),'[]'::jsonb) from (
   select s.id,s.trainer_name,s.trainee_name,s.starts_at,s.status,s.agreed_rate,
    (select q.delivery_status from public.notification_queue q where q.source_id=s.id and q.notification_kind='TEACHER_TRAINING_INVITE' order by q.created_at desc limit 1) as invitation_status
   from public.teacher_training_sessions s where s.tenant_id=p_tenant and s.starts_at>now()-interval '60 days' and not s.test_fixture order by s.starts_at desc limit 100
  ) x));
end;
$$;
revoke all on function public.teacher_training_scheduler_data(text) from public,anon;
grant execute on function public.teacher_training_scheduler_data(text) to authenticated;

-- Reserve the trainee's agenda as well as the trainer's. Existing scheduling
-- paths use the same teacher/weekday/slot advisory lock.
create function private.protect_confirmed_training_slot() returns trigger language plpgsql security definer set search_path='' as $$
declare v_teacher uuid; v_teachers uuid[]; v_day text; v_time text; v_date date; v_start timestamptz; v_start_date date;
begin
 if tg_table_name='appointments' then
  if lower(coalesce(new.status,'')) not in ('scheduled','confirmed') then return new; end if;
  v_start:=new.start_time; v_date:=(v_start at time zone 'America/Sao_Paulo')::date;
  v_time:=to_char(v_start at time zone 'America/Sao_Paulo','HH24:MI');
  v_teachers:=array[new.teacher_id,new.professor_id];
 elsif tg_table_name='bookings' then
  if upper(coalesce(new.status,''))='CANCELLED' then return new; end if;
  v_date:=new.date; v_day:=new.day_of_week; v_time:=left(new.time_slot,5); v_start_date:=new.start_date; v_teachers:=array[new.teacher_id];
 else
  if new.used_at is not null then return new; end if;
  v_date:=public.parse_lesson_date(new.date); v_time:=left(new.time,5); v_teachers:=array[new.teacher_id];
 end if;
 if v_date is not null then v_day:=(array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from v_date)::int+1]; end if;
 for v_teacher in select distinct unnest(v_teachers) order by 1 loop
  if v_teacher is null then continue; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:teacher:'||v_teacher::text||':'||public.fold_accents(v_day)||':'||v_time,0));
  if exists(select 1 from public.teacher_training_sessions t where t.tenant_id=new.tenant_id and v_teacher in (t.trainer_id,t.trainee_id) and t.status='CONFIRMED' and t.ends_at>now()
    and (tg_table_name<>'appointments' or t.appointment_id is distinct from new.id)
    and ((v_start is not null and t.starts_at<v_start+interval '30 minutes' and t.ends_at>v_start)
      or (v_start is null and to_char(t.starts_at at time zone 'America/Sao_Paulo','HH24:MI')=v_time
        and ((v_date is not null and (t.starts_at at time zone 'America/Sao_Paulo')::date=v_date)
          or (v_date is null and public.fold_accents(v_day)=public.fold_accents((array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from t.starts_at at time zone 'America/Sao_Paulo')::int+1]) and (v_start_date is null or (t.starts_at at time zone 'America/Sao_Paulo')::date>=v_start_date))))))
  then raise exception 'Este teacher já tem um treinamento confirmado nesse horário.'; end if;
 end loop;
 return new;
end;
$$;
create trigger zz_protect_confirmed_training_slot before insert or update on public.appointments for each row execute function private.protect_confirmed_training_slot();
create trigger zz_protect_confirmed_training_slot before insert or update on public.bookings for each row execute function private.protect_confirmed_training_slot();
create trigger zz_protect_confirmed_training_slot before insert or update on public.reschedules for each row execute function private.protect_confirmed_training_slot();
revoke all on function private.protect_confirmed_training_slot() from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
