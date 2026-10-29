-- Matrícula vai até o fim antes dos termos (migration 20261029200000).
-- Roda dentro da transação do release; nada sai da transação.
begin;

do $test$
declare
  v_tenant text;
  v_teacher uuid;
  v_student uuid;
  v_offer uuid := gen_random_uuid();
  v_term uuid;
  v_exp timestamptz;
  v_offer_exp timestamptz := now() + interval '20 days';
begin
  -- Professor e aluno reais só como chaves; tudo o que é criado aqui some no rollback.
  select p.tenant_id, p.id into v_tenant, v_teacher
    from public.profiles p where p.role = 'TEACHER' and p.tenant_id is not null
   order by p.created_at limit 1;
  select p.id into v_student from public.profiles p
   where p.role = 'STUDENT' and p.tenant_id = v_tenant
     and exists (select 1 from auth.users u where u.id = p.id)
   order by p.created_at limit 1;
  if v_teacher is null or v_student is null then
    raise notice 'matricula_ate_o_fim: sem professor e aluno; pulado';
    return;
  end if;

  insert into public.offers (id, kind, tenant_id, payload, expires_at, created_by,
    requires_enrollment, enrollment_fee, processing_by, processing_state, metadata, invite_security_version)
  values (v_offer, 'ENROLLMENT', v_tenant, jsonb_build_object('planDuration', 12, 'value', 100, 'classesPerWeek', 1),
    v_offer_exp, v_student, true, 0, v_student, 'PROFILE_READY', '{}'::jsonb, 1);

  -- Hora improvável de existir na agenda do professor.
  insert into private.enrollment_offer_schedule_slots (offer_id, tenant_id, slot_index, teacher_id,
    day_of_week, day_name, class_time, start_date, status, reserved_by, reserved_at, reservation_expires_at)
  values (v_offer, v_tenant, 1, v_teacher, 0, 'Domingo', '05:15', current_date + 7, 'RESERVED',
    v_student, now(), now() + interval '30 minutes');

  select reservation_expires_at into v_exp from private.enrollment_offer_schedule_slots where offer_id = v_offer;
  if v_exp > now() + interval '1 hour' then
    raise exception 'sem termo, a reserva continua de 30 min (veio %)', v_exp;
  end if;

  insert into private.teacher_student_terms (tenant_id, student_id, teacher_id, source_kind, source_id,
    source_key, source_hash, mode, starts_on, slots, unit_rate, school_snapshot, student_name, teacher_name)
  values (v_tenant, v_student, v_teacher, 'ENROLLMENT', v_offer,
    'ENROLLMENT:' || v_offer || ':' || v_teacher, 'teste', 'RECURRING', current_date + 7,
    '[{"day":0,"date":null,"time":"05:15"}]'::jsonb, 8, '{}'::jsonb, 'Aluno Teste', 'Professor Teste')
  returning id into v_term;

  select reservation_expires_at into v_exp from private.enrollment_offer_schedule_slots where offer_id = v_offer;
  if v_exp is distinct from v_offer_exp then
    raise exception 'termo em conferência segura o horário até o fim da oferta (veio %)', v_exp;
  end if;

  -- Uma renovação de 30 min (novo acesso ao link) não encurta a reserva.
  update private.enrollment_offer_schedule_slots
     set reservation_expires_at = now() + interval '30 minutes' where offer_id = v_offer;
  select reservation_expires_at into v_exp from private.enrollment_offer_schedule_slots where offer_id = v_offer;
  if v_exp is distinct from v_offer_exp then
    raise exception 'renovar o acesso não pode soltar o horário (veio %)', v_exp;
  end if;

  -- Professor recusou e não há outra versão: o horário volta a ser solto em 30 min.
  update private.teacher_student_terms set status = 'DECLINED' where id = v_term;
  select reservation_expires_at into v_exp from private.enrollment_offer_schedule_slots where offer_id = v_offer;
  if v_exp > now() + interval '1 hour' then
    raise exception 'termo recusado solta o horário (veio %)', v_exp;
  end if;

  if not exists (select 1 from cron.job where jobname = 'wisewolf-finish-enrollments-after-terms') then
    raise exception 'rotina de liberação não agendada';
  end if;
  if pg_catalog.has_function_privilege('authenticated', 'private.finish_enrollments_after_teacher_terms()', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.enrollment_awaiting_teacher_terms(uuid)', 'EXECUTE') then
    raise exception 'privilégios abertos demais';
  end if;
end;
$test$;

rollback;
