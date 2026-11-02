\set ON_ERROR_STOP on
begin;
-- Identidades e escola isoladas; nada sai deste rollback.
do $test$
declare
  tenant text := 'future-hold-fixture';
  t uuid := gen_random_uuid();        -- professor
  adm uuid := gen_random_uuid();      -- direção
  outsider uuid := gen_random_uuid(); -- direção de outra escola
  s1 uuid := gen_random_uuid();       -- outro aluno
  s2 uuid := gen_random_uuid();       -- aluno da reserva
  offer_a uuid := gen_random_uuid();
  offer_b uuid := gen_random_uuid();
  offer_c uuid := gen_random_uuid();
  slot_a0 uuid := gen_random_uuid();
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  start_on date;
  monday_gap integer;
  next_wednesday date;
  month text;
  result jsonb;
  hold_id uuid;
  failed boolean;
begin
  start_on := today + 20;
  month := to_char(today, 'YYYY-MM');
  monday_gap := (8 - extract(isodow from today)::int) % 7;
  next_wednesday := today + ((10 - extract(isodow from today)::int) % 7);
  if next_wednesday = today then next_wednesday := today + 7; end if;

  if has_function_privilege('anon', 'public.hold_offer_slots_until_start(uuid,numeric,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_enrollment_offer_with_future_hold(jsonb,numeric,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.future_start_hold_blocks(text,uuid,integer,text,uuid)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.teacher_future_start_holds', 'SELECT') then
    raise exception 'Reserva de agenda exposta além das RPCs';
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants(id, name) values (tenant, 'Future hold fixture'), ('future-hold-other', 'Other fixture');
  insert into auth.users(id, email, raw_app_meta_data, raw_user_meta_data) values
    (t, 'future-hold-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (adm, 'future-hold-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (outsider, 'future-hold-outsider@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (s1, 'future-hold-student1@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (s2, 'future-hold-student2@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles set tenant_id = tenant, role = 'TEACHER', lifecycle_status = 'active',
    is_test_account = true, full_name = 'Fixture Hold Teacher' where id = t;
  update public.profiles set tenant_id = tenant, role = 'SCHOOL_ADMIN', lifecycle_status = 'active',
    is_test_account = true, full_name = 'Fixture Hold Admin' where id = adm;
  update public.profiles set tenant_id = 'future-hold-other', role = 'SCHOOL_ADMIN', lifecycle_status = 'active',
    is_test_account = true, full_name = 'Fixture Outsider' where id = outsider;
  update public.profiles set tenant_id = tenant, role = 'STUDENT', lifecycle_status = 'active',
    is_test_account = true, full_name = 'Fixture Student One' where id = s1;
  update public.profiles set tenant_id = tenant, role = 'STUDENT', lifecycle_status = 'active',
    is_test_account = true, full_name = 'Fixture Student Two' where id = s2;
  insert into public.tenant_memberships(tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id in (t, adm, outsider, s1, s2)
    on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  insert into public.teacher_availability(tenant_id, teacher_id, day_of_week, start_time)
    values (tenant, t, 1, '20:30'), (tenant, t, 3, '20:30');

  insert into public.offers(id, kind, tenant_id, payload, expires_at, created_by, requires_enrollment, enrollment_fee, invite_security_version)
  values
    (offer_a, 'ENROLLMENT', tenant, jsonb_build_object(
       'startDate', to_char(start_on, 'YYYY-MM-DD'), 'classesPerWeek', 2, 'professorId', t,
       'studentName', 'Fixture Well',
       'schedule', jsonb_build_array(
         jsonb_build_object('day', 'Monday', 'weekday', 'Monday', 'time', '20:30', 'teacherId', t, 'professorId', t),
         jsonb_build_object('day', 'Wednesday', 'weekday', 'Wednesday', 'time', '20:30', 'teacherId', t, 'professorId', t))),
     now() + interval '30 days', adm, true, 0, 1),
    (offer_b, 'ENROLLMENT', tenant, jsonb_build_object(
       'startDate', to_char(start_on, 'YYYY-MM-DD'), 'classesPerWeek', 1, 'professorId', t,
       'schedule', jsonb_build_array(
         jsonb_build_object('day', 'Monday', 'weekday', 'Monday', 'time', '20:30', 'teacherId', t, 'professorId', t))),
     now() + interval '30 days', adm, true, 0, 1),
    (offer_c, 'ENROLLMENT', tenant, jsonb_build_object(
       'startDate', to_char(today, 'YYYY-MM-DD'), 'classesPerWeek', 1, 'professorId', t, 'studentName', 'Hoje'),
     now() + interval '30 days', adm, true, 0, 1);
  insert into private.enrollment_offer_schedule_slots(id, offer_id, tenant_id, slot_index, teacher_id, day_of_week, day_name, class_time, start_date)
  values
    (slot_a0, offer_a, tenant, 1, t, 1, 'Segunda', '20:30', start_on),
    (gen_random_uuid(), offer_a, tenant, 2, t, 3, 'Quarta', '20:30', start_on),
    (gen_random_uuid(), offer_b, tenant, 1, t, 1, 'Segunda', '20:30', start_on);

  -- Antes da reserva os horários aparecem para a atendente e para o matching.
  if not private.trial_closing_free_slots(tenant, t) @> '[{"day":"Segunda","time":"20:30"}]'::jsonb then
    raise exception 'Fixture: horário livre não apareceu antes da reserva';
  end if;
  if not public.match_teachers_for_plan(tenant, '[{"dow":1,"time":"20:30"},{"dow":3,"time":"20:30"}]')
       -> 'teachers' @> jsonb_build_array(jsonb_build_object('teacher_id', t, 'full', true)) then
    raise exception 'Fixture: professor não cobria o plano antes da reserva';
  end if;

  -- Direção de outra escola não reserva.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', outsider, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', outsider::text, true);
  failed := false;
  begin
    perform public.hold_offer_slots_until_start(offer_a, 30, null, null);
  exception when insufficient_privilege then failed := true;
  end;
  if not failed then raise exception 'Outra escola reservou a agenda'; end if;

  -- Direção da escola reserva: valor entra na folha do mês, uma vez só.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', adm::text, true);
  result := public.hold_offer_slots_until_start(offer_a, 30, null, null);
  if result ->> 'ok' <> 'true' or result ->> 'hold_until' <> to_char(start_on, 'YYYY-MM-DD')
     or jsonb_array_length(result -> 'holds') <> 1
     or (result -> 'holds' -> 0 ->> 'slots') <> 'seg 20:30, qua 20:30' then
    raise exception 'Reserva com resposta inesperada: %', result;
  end if;
  hold_id := (result -> 'holds' -> 0 ->> 'hold_id')::uuid;
  if (select count(*) from public.closing_adjustments
       where teacher_id = t and month_year = month and amount = 30
         and description like 'Reserva de agenda — Fixture Well (seg 20:30, qua 20:30, início %') <> 1 then
    raise exception 'Valor da reserva não entrou na folha do professor';
  end if;
  result := public.hold_offer_slots_until_start(offer_a, 30, null, null);
  if (result -> 'holds' -> 0 ->> 'duplicate') <> 'true'
     or (select count(*) from public.closing_adjustments where teacher_id = t and month_year = month) <> 1 then
    raise exception 'Reserva repetida pagou duas vezes';
  end if;
  failed := false;
  begin
    perform public.hold_offer_slots_until_start(offer_a, 45, null, null);
  exception when unique_violation then failed := true;
  end;
  if not failed then raise exception 'Reserva trocou de valor em silêncio'; end if;

  -- Só outra oferta é barrada.
  if not private.future_start_hold_blocks(tenant, t, 1, '20:30', offer_b)
     or private.future_start_hold_blocks(tenant, t, 1, '20:30', offer_a)
     or private.future_start_hold_blocks(tenant, t, 1, '21:00', offer_b) then
    raise exception 'Bloqueio da reserva no horário errado';
  end if;
  if private.trial_closing_free_slots(tenant, t) @> '[{"day":"Segunda","time":"20:30"}]'::jsonb then
    raise exception 'Atendente ainda oferece o horário reservado';
  end if;
  if public.match_teachers_for_plan(tenant, '[{"dow":1,"time":"20:30"},{"dow":3,"time":"20:30"}]')
       -> 'teachers' @> jsonb_build_array(jsonb_build_object('teacher_id', t, 'full', true)) then
    raise exception 'Matching ainda considera o professor livre no horário reservado';
  end if;
  failed := false;
  begin
    perform private.lock_and_validate_enrollment_schedule(offer_b, null);
  exception when sqlstate '23P01' then
    if sqlerrm <> 'teacher_slot_held' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'Outra matrícula passou pelo horário reservado'; end if;

  -- Gravação: recorrente de outro aluno é recusada; avulsa e a própria oferta passam.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  failed := false;
  begin
    insert into public.bookings(tenant_id, teacher_id, student_id, day_of_week, time_slot, start_date, status)
      values (tenant, t, s1, 'Segunda', '20:30', start_on + 7, 'SCHEDULED');
  exception when sqlstate '23P01' then
    if sqlerrm <> 'teacher_slot_held' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'Agendamento recorrente ocupou o horário reservado'; end if;

  insert into public.bookings(tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
    values (tenant, t, s1, 'Quarta', '20:30', next_wednesday, next_wednesday, 'SCHEDULED');

  update private.enrollment_offer_schedule_slots
     set status = 'RESERVED', reserved_by = s2, reserved_at = now(),
         reservation_expires_at = now() + interval '30 minutes'
   where id = slot_a0;
  insert into public.bookings(tenant_id, teacher_id, student_id, day_of_week, time_slot, start_date, status,
                              enrollment_offer_id, enrollment_offer_slot_id)
    values (tenant, t, s2, 'Segunda', '20:30', start_on, 'SCHEDULED', offer_a, slot_a0);

  -- Professor vê só as dele; outra escola não vê nada.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', t::text, true);
  if jsonb_array_length(public.list_future_start_holds(tenant, array[t], false)) <> 2 then
    raise exception 'Professor não enxerga a própria reserva';
  end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', outsider, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', outsider::text, true);
  if jsonb_array_length(public.list_future_start_holds(tenant, null, true)) <> 0 then
    raise exception 'Outra escola leu reservas';
  end if;

  -- Liberar devolve o horário e mantém o pagamento.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', adm::text, true);
  result := public.release_future_start_hold(hold_id, 'Fixture');
  if result ->> 'ok' <> 'true'
     or private.future_start_hold_blocks(tenant, t, 1, '20:30', offer_b)
     or jsonb_array_length(public.list_future_start_holds(tenant, null, false)) <> 0
     or jsonb_array_length(public.list_future_start_holds(tenant, null, true)) <> 2
     or (select count(*) from public.closing_adjustments where teacher_id = t and month_year = month) <> 1 then
    raise exception 'Liberação incorreta: %', result;
  end if;

  -- Reserva só existe para início futuro.
  failed := false;
  begin
    perform public.hold_offer_slots_until_start(offer_c, 30, null, null);
  exception when sqlstate '22023' then
    if sqlerrm <> 'future_start_hold_requires_future_start' then raise; end if;
    failed := true;
  end;
  if not failed then raise exception 'Reserva aceitou início para hoje'; end if;
end; $test$;
rollback;
