-- Troca de professor com os mesmos horários: família dispensada, só aviso.
begin;
do $$
declare base private.teacher_student_terms; t private.teacher_student_terms; v_student uuid; v_from uuid; v_to uuid;
  v_tenant text; v_slots jsonb; v_tr uuid := gen_random_uuid(); v_id uuid := gen_random_uuid(); v_body text;
begin
  if has_function_privilege('authenticated', 'private.student_term_same_schedule(private.teacher_student_terms)', 'EXECUTE') then
    raise exception 'regra da agenda igual é interna';
  end if;

  select * into base from private.teacher_student_terms order by created_at limit 1;
  if base.id is null then return; end if; -- cópia sem dados

  -- Aluno notificável com agenda fixa de um professor só, sem troca ativa.
  select b.student_id, b.teacher_id, b.tenant_id into v_student, v_from, v_tenant
    from public.bookings b
   where b.status = 'SCHEDULED' and b.student_id is not null and public.is_student_notifiable(b.student_id)
     and private.student_term_family_phone(b.student_id) is not null
     and not exists (select 1 from public.teacher_transfers tr where tr.student_id = b.student_id and tr.status in ('PENDING','ACCEPTED'))
   group by b.student_id, b.teacher_id, b.tenant_id
  having count(distinct b.teacher_id) = 1
   limit 1;
  if v_student is null then return; end if;
  select p.id into v_to from public.profiles p
   where p.role = 'TEACHER' and p.tenant_id = v_tenant and p.id <> v_from and coalesce(p.lifecycle_status, 'active') = 'active' limit 1;
  if v_to is null then return; end if;

  select jsonb_agg(jsonb_build_object('day', public.dow_name_to_int(b.day_of_week), 'date', null, 'time', left(b.time_slot, 5)))
    into v_slots from public.bookings b where b.student_id = v_student and b.teacher_id = v_from and b.status = 'SCHEDULED';

  insert into public.teacher_transfers(id, tenant_id, student_id, from_teacher_id, to_teacher_id, proposed_slots, cutover_date, reason)
  values (v_tr, v_tenant, v_student, v_from, v_to, v_slots, current_date + 30, 'Teste da troca com a mesma agenda');

  t := base;
  t.id := v_id; t.tenant_id := v_tenant; t.student_id := v_student; t.teacher_id := v_to;
  t.source_kind := 'TRANSFER'; t.source_id := v_tr; t.source_key := 'teste-mesma-agenda:' || v_id;
  t.mode := 'RECURRING'; t.slots := v_slots; t.starts_on := current_date + 30; t.ends_on := null; t.status := 'PROPOSED';
  t.school_signed_at := null; t.school_signed_by := null; t.school_typed_name := null;
  t.teacher_signed_at := null; t.teacher_signed_by := null; t.teacher_typed_name := null;
  t.family_confirmed_at := null; t.family_confirmation := null; t.retired_at := null; t.closed_reason := null;
  insert into private.teacher_student_terms select t.*;

  select * into t from private.teacher_student_terms where id = v_id;
  if t.family_confirmed_at is null or t.family_confirmation->>'kind' <> 'SAME_SCHEDULE_NOTICE' then
    raise exception 'mesma agenda deveria dispensar a família: %', t.family_confirmation;
  end if;
  if private.student_term_issue_link(v_id, 'FAMILY') then raise exception 'família dispensada não recebe link'; end if;

  -- Escola e professor assinam → executa e a família recebe só o aviso.
  update private.teacher_student_terms
     set school_signed_at = now(), school_signed_by = t.created_by, school_typed_name = 'Escola',
         teacher_signed_at = now(), teacher_signed_by = v_to, teacher_typed_name = 'Professor', status = 'EXECUTED'
   where id = v_id;
  select message_body into v_body from public.notification_queue where idempotency_key = format('student-term:%s:same-schedule-notice', v_id);
  if v_body is null or v_body not like '%mesmos dias e horários%' or v_body ~ 'R\$' or v_body like '%aceitar-termo%' then
    raise exception 'aviso da família errado: %', v_body;
  end if;
  if (select status from public.teacher_transfers where id = v_tr) <> 'ACCEPTED' then raise exception 'a troca deveria seguir sozinha'; end if;

  -- Agenda diferente continua pedindo a família.
  t.id := gen_random_uuid(); t.source_key := 'teste-outra-agenda:' || t.id; t.status := 'PROPOSED';
  t.school_signed_at := null; t.school_signed_by := null; t.school_typed_name := null;
  t.teacher_signed_at := null; t.teacher_signed_by := null; t.teacher_typed_name := null;
  t.family_confirmed_at := null; t.family_confirmation := null;
  t.slots := v_slots || jsonb_build_array(jsonb_build_object('day', 6, 'date', null, 'time', '07:00'));
  insert into private.teacher_student_terms select t.*;
  if (select family_confirmed_at from private.teacher_student_terms where id = t.id) is not null then
    raise exception 'agenda nova ainda pede a confirmação da família';
  end if;
end $$;
rollback;
