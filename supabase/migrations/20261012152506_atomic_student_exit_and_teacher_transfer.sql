-- A decisão de sair/pausar silencia automações desde o início da operação,
-- inclusive enquanto a conciliação externa aguarda atendimento.
do $patch$ declare definition text; anchor text; begin
 definition:=pg_get_functiondef('public.is_student_notifiable(uuid)'::regprocedure);
 if position('student_offboarding_operations' in definition)=0 then
  anchor:='from public.profiles as profile';
  if position(anchor in definition)=0 then raise exception 'notifiable_operation_anchor_missing'; end if;
  execute replace(definition,anchor,$guard$
      and not exists (select 1 from public.student_offboarding_operations operation
        where operation.student_id=profile.id and operation.tenant_id=profile.tenant_id
          and operation.target_lifecycle_status in ('suspended','offboarded')
          and operation.status not in ('COMPLETED','ABORTED'))
    from public.profiles as profile
$guard$);
 end if;
end $patch$;

-- Categorias novas ou legadas destinadas ao aluno também falham fechadas.
-- Os avisos oficiais da própria saída e os destinados à equipe são exceções.
create or replace function private.student_notice_requires_active(p_kind text)
returns boolean language sql immutable set search_path='' as $$
 select upper(btrim(coalesce(p_kind,'LESSON_REMINDER'))) not like 'TEACHER_%'
 and upper(btrim(coalesce(p_kind,'LESSON_REMINDER'))) not like 'INTERVIEW_%'
 and upper(btrim(coalesce(p_kind,'LESSON_REMINDER'))) not like 'AFFILIATE_%'
 and upper(btrim(coalesce(p_kind,'LESSON_REMINDER'))) not in (
  'STUDENT_SUSPENDED','STUDENT_OFFBOARDED','ENROLLMENT_MANAGEMENT_CLOSED',
  'ENROLLMENT_TEACHER_CLOSED','SCHEDULE_CHANGE_GROUP','CONFLICT_TEACHER_ALERT',
  'SCHOOL_AI_BRIEFING','CRON_ALERT','ASAAS_HEALTH','TRIAL_MANAGEMENT_ACCEPTED','TRIAL_TEACHER_REQUESTED');
$$;
alter function private.student_notice_requires_active(text) owner to postgres;
revoke all on function private.student_notice_requires_active(text) from public,anon,authenticated,service_role;

do $patch$ declare definition text;anchor text;begin
 definition:=pg_get_functiondef('public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)'::regprocedure);
 if position('private.student_notice_requires_active' in definition)=0 then
  anchor:='  if v_kind=''ENROLLMENT_STUDENT_CONFIRMED'' then';
  if position(anchor in definition)=0 then raise exception 'all_student_submission_anchor_missing';end if;
  execute replace(definition,anchor,$guard$
  if v_notification.student_id is not null and private.student_notice_requires_active(v_kind)
    and not public.is_student_notifiable(v_notification.student_id) then
   return jsonb_build_object('ok',false,'action','REVIEW_REQUIRED','reason','student_notifications_suppressed');
  end if;
$guard$||anchor);
 end if;
end $patch$;

create or replace function private.silence_student_automation(p_student uuid)
returns void language plpgsql security definer set search_path='' as $$
declare tenant text; changed integer;
begin
 select tenant_id into tenant from public.profiles where id=p_student and role='STUDENT';
 if tenant is null or public.is_student_notifiable(p_student) then return; end if;
 -- Não toca comprovantes aceitos nem resultados incertos do provedor.
 update public.notification_queue set status='skipped',delivery_status='skipped',
   last_error='student_notifications_suppressed',updated_at=now()
 where tenant_id=tenant and student_id=p_student and status in ('pending','failed')
   and delivery_status in ('queued','failed','preparing')
   and accepted_at is null and provider_message_id is null
   and private.student_notice_requires_active(notification_kind);
 get diagnostics changed=row_count;
 update public.attendance_confirmations set delivery_status='CANCELLED',
   last_delivery_error='student_notifications_suppressed'
 where tenant_id=tenant and student_id=p_student and delivery_status='PENDING'
   and sent_at is null and provider_message_id is null;
 update public.care_touchpoints set status='CLOSED'
 where tenant_id=tenant and subject_role='STUDENT' and subject_id=p_student and status<>'CLOSED';
 update public.teacher_transfers set status='CANCELLED',decided_at=now(),decline_reason='Aluno inativo: transferência não aplicada.'
 where tenant_id=tenant and student_id=p_student and status in ('PENDING','ACCEPTED');
 if changed>0 then
  insert into public.audit_logs(tenant_id,user_id,user_role,action,resource_type,resource_id,new_values)
  values(tenant,auth.uid(),'SYSTEM','student_pending_automation_suppressed','profiles',p_student::text,jsonb_build_object('notifications',changed));
 end if;
end $$;
alter function private.silence_student_automation(uuid) owner to postgres;
revoke all on function private.silence_student_automation(uuid) from public,anon,authenticated,service_role;

create or replace function private.student_automation_state_changed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='profiles' then
  perform private.silence_student_automation(new.id);
 else
  perform private.silence_student_automation(new.student_id);
 end if;
 return new;
end $$;
alter function private.student_automation_state_changed() owner to postgres;
revoke all on function private.student_automation_state_changed() from public,anon,authenticated,service_role;
drop trigger if exists student_automation_state_changed on public.profiles;
create trigger student_automation_state_changed after update of status,status_financial,lifecycle_status on public.profiles
for each row when (old.status is distinct from new.status or old.status_financial is distinct from new.status_financial or old.lifecycle_status is distinct from new.lifecycle_status)
execute function private.student_automation_state_changed();

create or replace function private.guard_late_student_automation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.student_id is not null and new.status in ('pending','failed')
   and new.delivery_status in ('queued','failed','preparing')
   and new.provider_message_id is null and new.accepted_at is null
   and private.student_notice_requires_active(new.notification_kind)
   and not public.is_student_notifiable(new.student_id) then
  new.status:='skipped'; new.delivery_status:='skipped'; new.last_error:='student_notifications_suppressed';
 end if;
 return new;
end $$;
alter function private.guard_late_student_automation() owner to postgres;
revoke all on function private.guard_late_student_automation() from public,anon,authenticated,service_role;
drop trigger if exists guard_late_student_automation on public.notification_queue;
create trigger guard_late_student_automation before insert or update on public.notification_queue
for each row execute function private.guard_late_student_automation();
drop trigger if exists student_operation_automation_state_changed on public.student_offboarding_operations;
create trigger student_operation_automation_state_changed after insert or update of status on public.student_offboarding_operations
for each row execute function private.student_automation_state_changed();

create or replace function private.guard_late_student_attendance()
returns trigger language plpgsql security definer set search_path='' as $$ begin
 if new.delivery_status='PENDING' and new.sent_at is null and new.provider_message_id is null
  and not public.is_student_notifiable(new.student_id) then
  new.delivery_status:='CANCELLED';new.last_delivery_error:='student_notifications_suppressed';
 end if;return new;
end $$;
alter function private.guard_late_student_attendance() owner to postgres;
revoke all on function private.guard_late_student_attendance() from public,anon,authenticated,service_role;
drop trigger if exists guard_late_student_attendance on public.attendance_confirmations;
create trigger guard_late_student_attendance before insert or update on public.attendance_confirmations for each row execute function private.guard_late_student_attendance();

-- Mesma verificação no seletor, no aceite e na aplicação futura.
create or replace function private.transfer_slot_available(p_tenant text,p_teacher uuid,p_day integer,p_time time,p_cutover date,p_student uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.teacher_availability a where a.tenant_id=p_tenant and a.teacher_id=p_teacher and a.day_of_week=p_day and a.start_time=p_time)
 and not exists(select 1 from public.bookings b where b.tenant_id=p_tenant and b.teacher_id=p_teacher and b.status='SCHEDULED'
  and (b.date is null or b.date>=p_cutover) and public.dow_name_to_int(b.day_of_week)=p_day
  and abs(extract(epoch from(left(b.time_slot,5)::time-p_time)))<1800)
 and not exists(select 1 from public.bookings b join public.booking_schedule_versions v on v.booking_id=b.id
  where b.tenant_id=p_tenant and b.teacher_id=p_teacher and b.status='SCHEDULED' and (v.valid_until is null or v.valid_until>=p_cutover)
  and public.dow_name_to_int(v.day_of_week)=p_day and abs(extract(epoch from(left(v.time_slot,5)::time-p_time)))<1800)
 and not exists(select 1 from public.upcoming_classes c where c.tenant_id=p_tenant and c.teacher_id=p_teacher and c.class_date>=p_cutover
  and extract(dow from c.class_date)::integer=p_day and abs(extract(epoch from(left(c.time_text,5)::time-p_time)))<1800)
 and not exists(select 1 from public.appointments a where a.tenant_id=p_tenant and (a.teacher_id=p_teacher or a.professor_id=p_teacher)
  and lower(a.status) in ('scheduled','confirmed') and (a.start_time at time zone 'America/Sao_Paulo')::date>=p_cutover
  and extract(dow from a.start_time at time zone 'America/Sao_Paulo')::integer=p_day
  and abs(extract(epoch from((a.start_time at time zone 'America/Sao_Paulo')::time-p_time)))<1800)
 and not exists(select 1 from public.class_coverages c where c.tenant_id=p_tenant and c.cover_teacher_id=p_teacher and c.class_date>=p_cutover
  and extract(dow from c.class_date)::integer=p_day and abs(extract(epoch from(left(c.class_time,5)::time-p_time)))<1800
  and (lower(c.status)='confirmed' or (lower(c.status)='pending' and coalesce(c.invite_expires_at,(c.class_date::text||' '||left(c.class_time,5)||':00-03')::timestamptz)>now())))
 and not exists(select 1 from private.trial_closing_schedule_holds h where h.tenant_id=p_tenant and h.teacher_id=p_teacher and h.status='HELD'
  and h.expires_at>now() and h.day_of_week=p_day and abs(extract(epoch from(h.class_time-p_time)))<1800)
 and not exists(select 1 from private.vendor_trial_teacher_requests r where r.tenant_id=p_tenant and r.target_teacher_id=p_teacher
  and r.status in ('AWAITING_STUDENT','AWAITING_TEACHER') and (r.slot_start at time zone 'America/Sao_Paulo')::date>=p_cutover
  and extract(dow from r.slot_start at time zone 'America/Sao_Paulo')::integer=p_day
  and abs(extract(epoch from((r.slot_start at time zone 'America/Sao_Paulo')::time-p_time)))<1800)
 and not exists(select 1 from private.enrollment_offer_schedule_slots r where r.tenant_id=p_tenant and r.teacher_id=p_teacher
  and r.day_of_week=p_day and abs(extract(epoch from(r.class_time-p_time)))<1800 and r.status='RESERVED' and r.reservation_expires_at>now())
 and not exists(select 1 from public.teacher_transfers t cross join lateral jsonb_array_elements(t.proposed_slots) s
  where t.tenant_id=p_tenant and t.to_teacher_id=p_teacher and t.student_id<>p_student and t.status in ('PENDING','ACCEPTED')
   and public.dow_name_to_int(s->>'day_of_week')=p_day and abs(extract(epoch from((s->>'time_slot')::time-p_time)))<1800);
$$;
alter function private.transfer_slot_available(text,uuid,integer,time,date,uuid) owner to postgres;
revoke all on function private.transfer_slot_available(text,uuid,integer,time,date,uuid) from public,anon,authenticated,service_role;

-- Uma consulta estreita da Gestão; não expõe contatos de outras escolas.
create or replace function public.get_student_transfer_options(p_student_id uuid,p_cutover date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare student public.profiles%rowtype; teachers jsonb;
begin
 select * into student from public.profiles where id=p_student_id and role='STUDENT';
 if auth.uid() is null or not coalesce(private.quality_school_manager(student.tenant_id),false) then
  raise exception 'Sem permissão para consultar a transferência.' using errcode='42501'; end if;
 if p_cutover is null or p_cutover<(now() at time zone 'America/Sao_Paulo')::date
   or p_cutover>(now() at time zone 'America/Sao_Paulo')::date+366 then
  raise exception 'Data de início inválida.' using errcode='22023'; end if;
 with options as (
  select teacher.id,teacher.full_name,
    coalesce((select jsonb_agg(jsonb_build_object('day_of_week',public.canonical_weekday_name(
       case availability.day_of_week when 0 then 'Domingo' when 1 then 'Segunda' when 2 then 'Terça' when 3 then 'Quarta' when 4 then 'Quinta' when 5 then 'Sexta' else 'Sábado' end),
       'time_slot',to_char(availability.start_time,'HH24:MI')) order by availability.day_of_week,availability.start_time)
     from public.teacher_availability availability
     where availability.teacher_id=teacher.id and availability.tenant_id=student.tenant_id
       and private.transfer_slot_available(student.tenant_id,teacher.id,availability.day_of_week,availability.start_time,p_cutover,student.id)
       and not exists(select 1 from public.bookings booking where booking.teacher_id=teacher.id and booking.tenant_id=student.tenant_id
         and booking.status='SCHEDULED' and (booking.date is null or booking.date>=p_cutover)
         and public.dow_name_to_int(booking.day_of_week)=availability.day_of_week and left(booking.time_slot,5)=to_char(availability.start_time,'HH24:MI'))
       and not exists(select 1 from public.upcoming_classes occurrence where occurrence.tenant_id=student.tenant_id
         and occurrence.teacher_id=teacher.id and occurrence.class_date>=p_cutover
         and extract(dow from occurrence.class_date)::integer=availability.day_of_week
         and abs(extract(epoch from(left(occurrence.time_text,5)::time-availability.start_time)))<1800)
       and not exists(select 1 from private.enrollment_offer_schedule_slots reserved where reserved.tenant_id=student.tenant_id
         and reserved.teacher_id=teacher.id and reserved.day_of_week=availability.day_of_week and reserved.class_time=availability.start_time
         and reserved.status='RESERVED' and reserved.reservation_expires_at>now())
       and not exists(select 1 from public.teacher_transfers pending cross join lateral jsonb_array_elements(pending.proposed_slots) slot
         where pending.tenant_id=student.tenant_id and pending.to_teacher_id=teacher.id and pending.student_id<>student.id
           and pending.status in ('PENDING','ACCEPTED') and public.dow_name_to_int(slot->>'day_of_week')=availability.day_of_week
           and slot->>'time_slot'=to_char(availability.start_time,'HH24:MI'))),'[]'::jsonb) slots
  from public.profiles teacher join public.tenant_memberships membership on membership.user_id=teacher.id
    and membership.tenant_id=student.tenant_id and membership.role='TEACHER' and membership.status='ACTIVE'
  where teacher.tenant_id=student.tenant_id and teacher.role='TEACHER' and teacher.lifecycle_status='active'
    and teacher.id is distinct from student.professor_id and teacher.is_test_account=student.is_test_account
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',full_name,'slots',slots) order by full_name),'[]'::jsonb) into teachers from options;
 return jsonb_build_object('ok',true,'teachers',teachers);
end $$;
alter function public.get_student_transfer_options(uuid,date) owner to postgres;
revoke all on function public.get_student_transfer_options(uuid,date) from public,anon,service_role;
grant execute on function public.get_student_transfer_options(uuid,date) to authenticated;

create or replace function public.admin_schedule_student_transfer(p_student_id uuid,p_to_teacher uuid,p_slots jsonb,p_cutover date,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare student public.profiles%rowtype; teacher_name text; options jsonb; slot jsonb; transfer_id uuid; existing public.teacher_transfers%rowtype; count_slots integer; pending_key text;
begin
 select * into student from public.profiles where id=p_student_id and role='STUDENT' for update;
 if auth.uid() is null or not coalesce(private.quality_school_manager(student.tenant_id),false) then
  raise exception 'Sem permissão para transferir o aluno.' using errcode='42501'; end if;
 if p_request_id is null or length(btrim(coalesce(p_reason,''))) not between 8 and 1000 then
  raise exception 'Informe o motivo da transferência (mínimo de 8 caracteres).' using errcode='22023'; end if;
 pending_key:='direct:'||p_request_id::text;
 select * into existing from public.teacher_transfers where tenant_id=student.tenant_id and token=pending_key;
 if found then
  if existing.student_id<>p_student_id or existing.to_teacher_id<>p_to_teacher or existing.proposed_slots<>p_slots or existing.cutover_date<>p_cutover or existing.reason<>btrim(p_reason) then
   raise exception 'A confirmação anterior possui outros dados.' using errcode='22023'; end if;
  if existing.status not in ('ACCEPTED','APPLIED') then raise exception 'A transferência anterior foi cancelada ou recusada.' using errcode='23514'; end if;
  return jsonb_build_object('ok',true,'transfer_id',existing.id,'status',existing.status,'cutover_date',existing.cutover_date,'idempotent',true);
 end if;
 if not public.is_student_notifiable(student.id) or p_to_teacher=student.professor_id then
  raise exception 'Escolha aluno ativo e professor diferente do atual.' using errcode='22023'; end if;
 if jsonb_typeof(p_slots) is distinct from 'array' or jsonb_array_length(p_slots) not between 1 and 14 then
  raise exception 'Selecione os horários para a transferência.' using errcode='22023'; end if;
 select count(*) into count_slots from public.bookings where tenant_id=student.tenant_id and student_id=student.id
  and teacher_id=student.professor_id and status='SCHEDULED' and date is null;
 if jsonb_array_length(p_slots)<>count_slots then
  raise exception 'Mantenha a quantidade de aulas contratada na transferência.' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_slots) value group by value->>'day_of_week',value->>'time_slot' having count(*)>1) then
  raise exception 'Horário repetido na transferência.' using errcode='22023'; end if;
 if exists(select 1 from public.bookings booking join public.offers offer on offer.id=booking.enrollment_offer_id
   where booking.student_id=student.id and booking.status='SCHEDULED' and offer.processing_state<>'COMPLETED') then
  raise exception 'Conclua a matrícula em andamento antes da transferência.' using errcode='23514'; end if;
 perform pg_advisory_xact_lock(hashtextextended(student.tenant_id||':teacher-transfer:'||p_to_teacher::text,0));
 for slot in select value from jsonb_array_elements(p_slots) order by value->>'day_of_week',value->>'time_slot' loop
  perform pg_advisory_xact_lock(hashtextextended('schedule:teacher:'||p_to_teacher::text||':'||public.fold_accents(slot->>'day_of_week')||':'||(slot->>'time_slot'),0));
 end loop;
 options:=public.get_student_transfer_options(p_student_id,p_cutover);
 select value->>'name',value->'slots' into teacher_name,options from jsonb_array_elements(options->'teachers') where value->>'id'=p_to_teacher::text;
 if teacher_name is null then raise exception 'O professor de destino não está ativo nesta escola.' using errcode='42501'; end if;
 for slot in select value from jsonb_array_elements(p_slots) loop
  if not coalesce(options @> jsonb_build_array(slot),false) then
   raise exception 'Um dos horários escolhidos não está mais disponível. Atualize a lista.' using errcode='23P01'; end if;
 end loop;
 insert into public.teacher_transfers(tenant_id,student_id,from_teacher_id,to_teacher_id,proposed_slots,cutover_date,reason,status,created_by,decided_at,token)
 values(student.tenant_id,student.id,student.professor_id,p_to_teacher,p_slots,p_cutover,btrim(p_reason),'ACCEPTED',auth.uid(),now(),pending_key) returning id into transfer_id;
 perform public.apply_teacher_transfer(transfer_id);
 select * into existing from public.teacher_transfers where id=transfer_id;
 insert into public.audit_logs(tenant_id,user_id,user_role,action,resource_type,resource_id,new_values)
 values(student.tenant_id,auth.uid(),public._my_role(),'direct_teacher_transfer_scheduled','teacher_transfers',transfer_id::text,
   jsonb_build_object('slots',p_slots,'cutover',p_cutover,'to_teacher',p_to_teacher,'reason',btrim(p_reason)));
 return jsonb_build_object('ok',true,'transfer_id',transfer_id,'status',existing.status,'cutover_date',p_cutover,'to_teacher_name',teacher_name);
end $$;
alter function public.admin_schedule_student_transfer(uuid,uuid,jsonb,date,text,uuid) owner to postgres;
revoke all on function public.admin_schedule_student_transfer(uuid,uuid,jsonb,date,text,uuid) from public,anon,service_role;
grant execute on function public.admin_schedule_student_transfer(uuid,uuid,jsonb,date,text,uuid) to authenticated;

-- A agenda antiga sobrevive para conferência; não deixa lançamentos órfãos.
do $patch$ declare definition text; anchor text; begin
 definition:=pg_get_functiondef('public.apply_teacher_transfer(uuid)'::regprocedure);
 definition:=replace(definition,'transfer_row.cutover_date > current_date',
   'transfer_row.cutover_date > (now() at time zone ''America/Sao_Paulo'')::date');
 definition:=replace(definition,'SET professor_id2 = transfer_row.to_teacher_id','SET professor_id2 = NULL');
 definition:=replace(definition,'AND student.professor_id2 = transfer_row.from_teacher_id;',
   'AND student.professor_id2 IN (transfer_row.from_teacher_id,transfer_row.to_teacher_id);');
 anchor:='DELETE FROM public.bookings AS booking';
 if position(anchor in definition)>0 then
  definition:=replace(definition,anchor,'UPDATE public.bookings AS booking SET status = ''CANCELLED''');
  definition:=replace(definition,'AND booking.day_of_week IS NOT NULL;','AND booking.day_of_week IS NOT NULL AND booking.date IS NULL;');
 end if;
 if position('private.transfer_slot_available' in definition)=0 then
  anchor:='  SELECT count(*)'||chr(10)||'  INTO conflict_count';
  if position(anchor in definition)=0 then raise exception 'transfer_validation_anchor_missing'; end if;
  definition:=replace(definition,anchor,$guard$
  -- Nenhuma mudança parcial de agenda se o cadastro mudou desde a programação.
  PERFORM 1 FROM public.profiles WHERE id=transfer_row.student_id FOR UPDATE;
  IF NOT public.is_student_notifiable(transfer_row.student_id) OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id=transfer_row.student_id AND professor_id IS NOT DISTINCT FROM transfer_row.from_teacher_id
  ) THEN RAISE EXCEPTION 'teacher_transfer_student_changed' USING ERRCODE='23514'; END IF;
  IF transfer_row.token LIKE 'direct:%' AND (SELECT count(*) FROM public.bookings WHERE tenant_id=transfer_row.tenant_id AND student_id=transfer_row.student_id AND teacher_id=transfer_row.from_teacher_id AND status='SCHEDULED' AND date IS NULL)<>jsonb_array_length(transfer_row.proposed_slots)
  THEN RAISE EXCEPTION 'teacher_transfer_frequency_changed' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('schedule:teacher:'||transfer_row.to_teacher_id::text||':'||public.fold_accents(slot->>'day_of_week')||':'||(slot->>'time_slot'),0))
    FROM jsonb_array_elements(transfer_row.proposed_slots) slot ORDER BY slot->>'day_of_week',slot->>'time_slot';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(transfer_row.proposed_slots) slot
   WHERE NOT private.transfer_slot_available(transfer_row.tenant_id,transfer_row.to_teacher_id,public.dow_name_to_int(slot->>'day_of_week'),(slot->>'time_slot')::time,transfer_row.cutover_date,transfer_row.student_id))
  THEN RAISE EXCEPTION 'teacher_transfer_schedule_conflict' USING ERRCODE='23P01'; END IF;
  SELECT count(*)
  INTO conflict_count
$guard$);
 end if;
 if position('teacher_transfer_old_schedule_retired' in definition)=0 then
  anchor:='  UPDATE public.teacher_transfers';
  definition:=replace(definition,anchor,$retire$
  -- teacher_transfer_old_schedule_retired: só pendências sem aceite do provedor.
  UPDATE public.notification_queue SET status='skipped',delivery_status='skipped',last_error='teacher_transfer_old_schedule_retired',updated_at=now()
   WHERE tenant_id=transfer_row.tenant_id AND student_id=transfer_row.student_id AND teacher_id=transfer_row.from_teacher_id
    AND class_date>=transfer_row.cutover_date AND notification_kind='LESSON_REMINDER'
    AND status IN ('pending','failed') AND delivery_status IN ('queued','failed','preparing') AND provider_message_id IS NULL AND accepted_at IS NULL;
  UPDATE public.attendance_confirmations SET delivery_status='CANCELLED',last_delivery_error='teacher_transfer_old_schedule_retired'
   WHERE tenant_id=transfer_row.tenant_id AND student_id=transfer_row.student_id AND teacher_id=transfer_row.from_teacher_id
    AND class_date>=transfer_row.cutover_date AND delivery_status='PENDING' AND provider_message_id IS NULL AND sent_at IS NULL;
  UPDATE public.teacher_transfers
$retire$);
 end if;
 if position('direct_transfer_notice_owned_by_management' in definition)=0 then
  -- Como na transferência direta anterior, a Gestão é dona do anúncio à família.
  -- O dossiê ao novo titular continua pelo trigger auditável de APPLIED.
  definition:=replace(definition,'  PERFORM public._enqueue_school_whatsapp(',
    E'  -- direct_transfer_notice_owned_by_management\n  IF transfer_row.token NOT LIKE ''direct:%'' THEN\n  PERFORM public._enqueue_school_whatsapp(');
  definition:=replace(definition,E'  );\n\n  SELECT profile.phone',E'  );\n  END IF;\n\n  SELECT profile.phone');
  definition:=replace(definition,E'  );\nEND;',E'  );\n  END IF;\nEND;');
 end if;
 execute definition;
end $patch$;

-- Pendência histórica do substituto não impede retirar somente a agenda futura.
-- Uma cobertura futura ainda pendente/confirmada continua exigindo conciliação.
do $patch$ declare definition text;anchor text;begin
 definition:=pg_get_functiondef('public.protect_booking_source_coverage()'::regprocedure);
 if position('audited_transfer_retired_schedule' in definition)=0 then
  anchor:='  if tg_op = ''UPDATE'' and not (';
  if position(anchor in definition)=0 then raise exception 'transfer_history_coverage_anchor_missing';end if;
  definition:=replace(definition,anchor,$guard$
  -- audited_transfer_retired_schedule: não apaga cobertura ou lançamento antigo.
  if tg_op='UPDATE' and old.status='SCHEDULED' and new.status='CANCELLED'
   and new.tenant_id is not distinct from old.tenant_id and new.teacher_id is not distinct from old.teacher_id
   and new.student_id is not distinct from old.student_id and new.date is not distinct from old.date
   and new.start_date is not distinct from old.start_date and new.day_of_week is not distinct from old.day_of_week
   and new.time_slot is not distinct from old.time_slot and exists(
    select 1 from public.teacher_transfers t where t.tenant_id=old.tenant_id and t.student_id=old.student_id
     and t.from_teacher_id=old.teacher_id and t.status='ACCEPTED' and t.cutover_date<=(now() at time zone 'America/Sao_Paulo')::date
     and not exists(select 1 from public.class_coverages c where c.booking_id=old.id and c.tenant_id=old.tenant_id
      and c.class_date>=t.cutover_date and (lower(c.status)='confirmed' and c.class_log_id is null
       or lower(c.status)='pending' and coalesce(c.invite_expires_at,(c.class_date::text||' '||left(c.class_time,5)||':00-03')::timestamptz)>now()))
   ) then return new;end if;
  if tg_op = 'UPDATE' and not (
$guard$);execute definition;
 end if;
end $patch$;

-- Um conflito individual não impede as outras transferências do dia.
create or replace function public.apply_due_teacher_transfers()
returns integer language plpgsql security definer set search_path='' as $$
declare r record;n integer:=0;error_message text;begin
 for r in select id,tenant_id from public.teacher_transfers where status='ACCEPTED' and cutover_date<=(now() at time zone 'America/Sao_Paulo')::date order by cutover_date,id loop
  begin
   perform public.apply_teacher_transfer(r.id);
   if exists(select 1 from public.teacher_transfers where id=r.id and status='APPLIED') then n:=n+1;end if;
  exception when others then
   error_message:=sqlerrm;
   if not exists(select 1 from public.audit_logs where action='teacher_transfer_apply_failed' and resource_id=r.id::text and new_values->>'error'=error_message) then
    insert into public.audit_logs(tenant_id,user_role,action,resource_type,resource_id,new_values)
     values(r.tenant_id,'SYSTEM','teacher_transfer_apply_failed','teacher_transfers',r.id::text,jsonb_build_object('error',error_message));
   end if;
  end;
 end loop;return n;
end $$;
alter function public.apply_due_teacher_transfers() owner to postgres;
revoke all on function public.apply_due_teacher_transfers() from public,anon,authenticated;
grant execute on function public.apply_due_teacher_transfers() to service_role;

-- Reservas futuras protegem escritores distintos com o mesmo lock de agenda.
create or replace function private.assert_no_transfer_reservation(p_tenant text,p_teacher uuid,p_student uuid,p_day text,p_time text,p_date date)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_teacher is null or public.dow_name_to_int(p_day) is null or p_time is null then return; end if;
 -- A trava do teacher também cobre overlaps (18h15 versus 18h30).
 perform pg_advisory_xact_lock(hashtextextended(p_tenant||':teacher-transfer:'||p_teacher::text,0));
 perform pg_advisory_xact_lock(hashtextextended('schedule:teacher:'||p_teacher::text||':'||public.fold_accents(public.canonical_weekday_name(p_day))||':'||left(p_time,5),0));
 if exists(select 1 from public.teacher_transfers t cross join lateral jsonb_array_elements(t.proposed_slots) s
  where t.tenant_id=p_tenant and t.to_teacher_id=p_teacher and t.student_id is distinct from p_student
   and t.status in ('PENDING','ACCEPTED') and (p_date is null or p_date>=t.cutover_date)
   and public.dow_name_to_int(s->>'day_of_week')=public.dow_name_to_int(p_day)
   and abs(extract(epoch from((s->>'time_slot')::time-left(p_time,5)::time)))<1800) then
  raise exception 'Horário reservado para uma transferência de aluno.' using errcode='23P01';
 end if;
end $$;
alter function private.assert_no_transfer_reservation(text,uuid,uuid,text,text,date) owner to postgres;
revoke all on function private.assert_no_transfer_reservation(text,uuid,uuid,text,text,date) from public,anon,authenticated,service_role;

create or replace function private.guard_transfer_reserved_schedule()
returns trigger language plpgsql security definer set search_path='' as $$
declare item jsonb:=to_jsonb(new); d date;teacher uuid;student uuid;day text;tm text;
begin
 if tg_table_name='bookings' then
  if item->>'status'<>'SCHEDULED' then return new; end if;
  d:=(item->>'date')::date; day:=item->>'day_of_week';tm:=item->>'time_slot';
 elsif tg_table_name='booking_schedule_versions' then
  select b.teacher_id,b.student_id,b.tenant_id into teacher,student,day from public.bookings b where b.id=new.booking_id;
  perform private.assert_no_transfer_reservation(day,teacher,student,new.day_of_week,new.time_slot,null);return new;
 elsif tg_table_name='reschedules' then
  if item->>'used_at' is not null then return new; end if;
  d:=public.parse_lesson_date(item->>'date');tm:=left(item->>'time',5);
  if d is null or tm is null then return new; end if;
 elsif tg_table_name='appointments' then
  if lower(item->>'status') not in ('scheduled','confirmed') then return new; end if;
  d:=((item->>'start_time')::timestamptz at time zone 'America/Sao_Paulo')::date;
  tm:=to_char((item->>'start_time')::timestamptz at time zone 'America/Sao_Paulo','HH24:MI');
 elsif tg_table_name='class_coverages' then
  if lower(item->>'status') not in ('confirmed','pending') then return new;end if;
  d:=(item->>'class_date')::date;tm:=left(item->>'class_time',5);item:=item||jsonb_build_object('teacher_id',item->>'cover_teacher_id');
 elsif tg_table_name='enrollment_offer_schedule_slots' then
  if item->>'status' not in ('RESERVED','MATERIALIZED') then return new; end if;
  day:=(array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[(item->>'day_of_week')::int+1];tm:=left(item->>'class_time',5);
 elsif tg_table_name='trial_closing_schedule_holds' then
  if item->>'status'<>'HELD' then return new; end if;
  day:=(array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[(item->>'day_of_week')::int+1];tm:=left(item->>'class_time',5);
 end if;
 if day is null and d is not null then day:=(array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from d)::int+1];end if;
 perform private.assert_no_transfer_reservation(item->>'tenant_id',coalesce(item->>'teacher_id',item->>'professor_id')::uuid,(item->>'student_id')::uuid,day,tm,d);
 return new;
end $$;
alter function private.guard_transfer_reserved_schedule() owner to postgres;
revoke all on function private.guard_transfer_reserved_schedule() from public,anon,authenticated,service_role;
do $$ declare table_name text; begin
 foreach table_name in array array['public.bookings','public.booking_schedule_versions','public.reschedules','public.appointments','public.class_coverages','private.enrollment_offer_schedule_slots','private.trial_closing_schedule_holds'] loop
  execute format('drop trigger if exists zz_transfer_reserved_schedule on %s',table_name);
  execute format('create trigger zz_transfer_reserved_schedule before insert or update on %s for each row execute function private.guard_transfer_reserved_schedule()',table_name);
 end loop;
end $$;

-- A proposta com aceite continua existindo, mas usa a mesma disponibilidade real.
do $patch$ declare definition text;anchor text;begin
 definition:=pg_get_functiondef('public.create_teacher_transfer(uuid,uuid,jsonb,date,text)'::regprocedure);
 if position('private.transfer_slot_available' in definition)=0 then
  anchor:='  RETURN public.create_teacher_transfer_unchecked(';
  if position(anchor in definition)=0 then raise exception 'proposal_validation_anchor_missing';end if;
  definition:=replace(definition,anchor,$guard$
  IF NOT public.is_student_notifiable(p_student_id) THEN RAISE EXCEPTION 'Aluno inativo não pode ser transferido.' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended((SELECT tenant_id FROM public.profiles WHERE id=p_student_id)||':teacher-transfer:'||p_to_teacher::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('schedule:teacher:'||p_to_teacher::text||':'||public.fold_accents(slot->>'day_of_week')||':'||(slot->>'time_slot'),0)) FROM jsonb_array_elements(p_slots) slot ORDER BY slot->>'day_of_week',slot->>'time_slot';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_slots) slot WHERE NOT private.transfer_slot_available((SELECT tenant_id FROM public.profiles WHERE id=p_student_id),p_to_teacher,public.dow_name_to_int(slot->>'day_of_week'),(slot->>'time_slot')::time,p_cutover,p_student_id)) THEN RAISE EXCEPTION 'Um dos horários escolhidos não está mais disponível. Atualize a lista.' USING ERRCODE='23P01'; END IF;
  RETURN public.create_teacher_transfer_unchecked(
$guard$);execute definition;
 end if;
end $patch$;

-- Compatibilidade: a antiga rota imediata também respeita a suspensão canônica.
do $patch$ declare definition text;anchor text;begin
 definition:=pg_get_functiondef('public.admin_transfer_student_teacher(uuid,uuid,text)'::regprocedure);
 if position('public.is_student_notifiable' in definition)=0 then
  anchor:='  if v_from_teacher is null then';
  if position(anchor in definition)=0 then raise exception 'legacy_transfer_state_anchor_missing';end if;
  execute replace(definition,anchor,$guard$
  if not public.is_student_notifiable(p_student_id) then
    raise exception 'Aluno inativo não pode ser transferido.' using errcode='23514';
  end if;
  if v_from_teacher is null then
$guard$);
 end if;
end $patch$;

create index if not exists teacher_transfers_active_target_idx on public.teacher_transfers(tenant_id,to_teacher_id)
where status in ('PENDING','ACCEPTED');

-- Reparação única de pendências sem tentativa aceita. Reexecutar o release não reenvia.
do $$ declare r record; begin
 if not exists(select 1 from public.schema_one_shots where key='student_automation_exit_20261012') then
  for r in select id from public.profiles where role='STUDENT' and not public.is_student_notifiable(id) loop
   perform private.silence_student_automation(r.id);
  end loop;
  insert into public.schema_one_shots(key,nota) values('student_automation_exit_20261012','Silencia somente pendências seguras; preserva aceitos e incertos.');
 end if;
end $$;
notify pgrst,'reload schema';
