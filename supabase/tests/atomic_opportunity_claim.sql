-- Claim atomico: isolamento por tenant, professor ativo, agenda e idempotencia.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

create or replace function pg_temp.claim_slot(days_from_today integer, slot_time text)
returns jsonb
language sql
as $$
  select jsonb_build_array(jsonb_build_object(
    'date', to_char(current_date + days_from_today, 'YYYY-MM-DD'),
    'time', slot_time,
    'day', extract(dow from current_date + days_from_today)::integer
  ));
$$;

select pg_temp.assert_true(
  to_regprocedure('public.claim_opportunity_atomic(uuid,uuid,integer)') is not null
  and to_regprocedure('public.claim_opportunity_atomic(uuid,uuid)') is null
  and to_regprocedure('public.claim_opportunity_atomic(uuid,uuid,jsonb)') is null
  and to_regprocedure('public.claim_opportunity_atomic(uuid,uuid,text)') is null,
  'RPC atomica manteve assinatura antiga ou insegura'
);
select pg_temp.assert_true(
  not has_function_privilege(
    'anon', 'public.claim_opportunity_atomic(uuid,uuid,integer)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.claim_opportunity_atomic(uuid,uuid,integer)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.claim_opportunity_atomic(uuid,uuid,integer)', 'EXECUTE'
  ),
  'RPC atomica nao ficou restrita ao service_role'
);

insert into public.tenants (id, name, saas_status)
values
  ('claim-school-a', 'Claim School A', 'active'),
  ('claim-school-b', 'Claim School B', 'trial');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-00000000d101', 'authenticated', 'authenticated', 'claim-teacher-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Claim Teacher A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d102', 'authenticated', 'authenticated', 'claim-other-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Claim Other A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d103', 'authenticated', 'authenticated', 'claim-teacher-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Claim Teacher B"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d104', 'authenticated', 'authenticated', 'claim-suspended@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Claim Suspended"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d105', 'authenticated', 'authenticated', 'claim-offboarded@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Claim Offboarded"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d106', 'authenticated', 'authenticated', 'claim-student-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Claim Student A"}', now(), now());

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'claim-school-a', role = 'TEACHER',
       lifecycle_status = 'active', full_name = 'Claim Teacher A'
 where id = '00000000-0000-4000-8000-00000000d101';
update public.profiles
   set tenant_id = 'claim-school-a', role = 'TEACHER',
       lifecycle_status = 'active', full_name = 'Claim Other A'
 where id = '00000000-0000-4000-8000-00000000d102';
update public.profiles
   set tenant_id = 'claim-school-b', role = 'TEACHER',
       lifecycle_status = 'active', full_name = 'Claim Teacher B'
 where id = '00000000-0000-4000-8000-00000000d103';
update public.profiles
   set tenant_id = 'claim-school-a', role = 'TEACHER',
       lifecycle_status = 'active', full_name = 'Claim Suspended'
 where id = '00000000-0000-4000-8000-00000000d104';
update public.profiles
   set tenant_id = 'claim-school-a', role = 'TEACHER',
       lifecycle_status = 'offboarded', full_name = 'Claim Offboarded'
 where id = '00000000-0000-4000-8000-00000000d105';
update public.profiles
   set tenant_id = 'claim-school-a', role = 'STUDENT',
       lifecycle_status = 'active', full_name = 'Claim Student A'
 where id = '00000000-0000-4000-8000-00000000d106';
set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  ('00000000-0000-4000-8000-00000000d101', 'claim-school-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d102', 'claim-school-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d103', 'claim-school-b', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d104', 'claim-school-a', 'TEACHER', 'SUSPENDED', false),
  ('00000000-0000-4000-8000-00000000d105', 'claim-school-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d106', 'claim-school-a', 'STUDENT', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.opportunities (
  id, tenant_id, student_name, student_phone, slots_proposed,
  status, kind, conversion_status
)
values
  ('10000000-0000-4000-8000-00000000d101', 'claim-school-a', 'Lead Canonico', '5511999990101', pg_temp.claim_slot(10, '09:00'), 'OPEN', 'TRIAL', 'OPEN'),
  ('10000000-0000-4000-8000-00000000d102', 'claim-school-b', 'Lead Outro Tenant', '5511999990102', pg_temp.claim_slot(11, '10:00'), 'OPEN', 'TRIAL', 'OPEN'),
  ('10000000-0000-4000-8000-00000000d103', 'claim-school-a', 'Lead Suspenso', '5511999990103', pg_temp.claim_slot(12, '11:00'), 'OPEN', 'TRIAL', 'OPEN'),
  ('10000000-0000-4000-8000-00000000d104', 'claim-school-a', 'Lead Offboarded', '5511999990104', pg_temp.claim_slot(13, '12:00'), 'OPEN', 'TRIAL', 'OPEN'),
  ('10000000-0000-4000-8000-00000000d105', 'claim-school-a', 'Lead Conflito Appointment', '5511999990105', pg_temp.claim_slot(10, '09:15'), 'OPEN', 'TRIAL', 'OPEN'),
  ('10000000-0000-4000-8000-00000000d106', 'claim-school-a', 'Lead Conflito Booking', '5511999990106', pg_temp.claim_slot(14, '14:00'), 'OPEN', 'TRAINING', 'OPEN'),
  ('10000000-0000-4000-8000-00000000d107', 'claim-school-a', 'Lead Expirado', '5511999990107', pg_temp.claim_slot(-1, '08:00'), 'OPEN', 'TRIAL', 'OPEN'),
  ('10000000-0000-4000-8000-00000000d108', 'claim-school-a', 'Lead Tenant Bloqueado', '5511999990108', pg_temp.claim_slot(15, '15:00'), 'OPEN', 'TRIAL', 'OPEN'),
  ('10000000-0000-4000-8000-00000000d109', 'claim-school-a', 'Lead Slot Invalido', '5511999990109', jsonb_build_array(jsonb_build_object('date', to_char(current_date + 16, 'YYYY-MM-DD'), 'time', '16:00'), jsonb_build_object('date', to_char(current_date + 17, 'YYYY-MM-DD'), 'time', '17:00')), 'OPEN', 'TRIAL', 'OPEN');

insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, date, status
)
values (
  '20000000-0000-4000-8000-00000000d106',
  'claim-school-a',
  '00000000-0000-4000-8000-00000000d101',
  '00000000-0000-4000-8000-00000000d106',
  case extract(dow from current_date + 14)::integer
    when 0 then 'Domingo'
    when 1 then 'Segunda'
    when 2 then 'Terça'
    when 3 then 'Quarta'
    when 4 then 'Quinta'
    when 5 then 'Sexta'
    else 'Sábado'
  end,
  '14:00', current_date + 14, 'SCHEDULED'
);

set local role service_role;

do $test$
declare
  teacher_a constant uuid := '00000000-0000-4000-8000-00000000d101';
  other_a constant uuid := '00000000-0000-4000-8000-00000000d102';
  teacher_b constant uuid := '00000000-0000-4000-8000-00000000d103';
  suspended constant uuid := '00000000-0000-4000-8000-00000000d104';
  offboarded constant uuid := '00000000-0000-4000-8000-00000000d105';
  claimed_opportunity constant uuid := '10000000-0000-4000-8000-00000000d101';
  result jsonb;
  retry_result jsonb;
  appointment_id uuid;
  appointments_before bigint;
begin
  select count(*) into appointments_before from public.appointments;

  result := public.claim_opportunity_atomic(claimed_opportunity, teacher_a, 2);
  if result ->> 'error' <> 'claim_link_expired'
     or (select count(*) from public.appointments) <> appointments_before then
    raise exception 'assertion failed: link de rodada anterior gravou appointment: %', result;
  end if;

  result := public.claim_opportunity_atomic(claimed_opportunity, teacher_a, 1);
  if not coalesce((result ->> 'ok')::boolean, false)
     or coalesce((result ->> 'idempotent')::boolean, true) then
    raise exception 'assertion failed: primeiro claim falhou: %', result;
  end if;
  appointment_id := (result ->> 'appointmentId')::uuid;

  if (select count(*) from public.appointments) <> appointments_before + 1 then
    raise exception 'assertion failed: claim nao criou exatamente um appointment';
  end if;
  if not exists (
    select 1
      from public.appointments as appointment
     where appointment.id = appointment_id
       and appointment.tenant_id = 'claim-school-a'
       and appointment.teacher_id = teacher_a
       and appointment.professor_id = teacher_a
       and appointment.student_name = 'Lead Canonico'
       and appointment.student_phone = '5511999990101'
       and appointment.type = 'experimental'
       and appointment.start_time =
         ((current_date + 10 + time '09:00') at time zone 'America/Sao_Paulo')
  ) then
    raise exception 'assertion failed: appointment nao foi derivado da opportunity';
  end if;
  if not exists (
    select 1
      from public.opportunities as opportunity
     where opportunity.id = claimed_opportunity
       and opportunity.status = 'CLAIMED'
       and opportunity.winner_teacher_id = teacher_a
       and opportunity.professor_id = teacher_a
       and opportunity.trial_appointment_id = appointment_id
  ) then
    raise exception 'assertion failed: opportunity nao foi vinculada atomicamente';
  end if;

  retry_result := public.claim_opportunity_atomic(claimed_opportunity, teacher_a, 1);
  if not coalesce((retry_result ->> 'ok')::boolean, false)
     or not coalesce((retry_result ->> 'idempotent')::boolean, false)
     or retry_result ->> 'appointmentId' <> appointment_id::text
     or (select count(*) from public.appointments) <> appointments_before + 1 then
    raise exception 'assertion failed: retry nao foi idempotente: %', retry_result;
  end if;

  result := public.claim_opportunity_atomic(claimed_opportunity, other_a, 1);
  if result ->> 'error' <> 'opportunity_already_claimed'
     or (select winner_teacher_id from public.opportunities where id = claimed_opportunity)
        is distinct from teacher_a
     or (select count(*) from public.appointments) <> appointments_before + 1 then
    raise exception 'assertion failed: segundo professor venceu a corrida: %', result;
  end if;

  result := public.claim_opportunity_atomic(
    '10000000-0000-4000-8000-00000000d102', teacher_a, 1
  );
  if result ->> 'error' <> 'teacher_not_active_for_tenant'
     or exists (
       select 1 from public.appointments
        where student_name = 'Lead Outro Tenant'
     ) then
    raise exception 'assertion failed: cross-tenant gravou appointment: %', result;
  end if;

  result := public.claim_opportunity_atomic(
    '10000000-0000-4000-8000-00000000d103', suspended, 1
  );
  if result ->> 'error' <> 'teacher_not_active_for_tenant'
     or exists (
       select 1 from public.appointments where student_name = 'Lead Suspenso'
     ) then
    raise exception 'assertion failed: membership suspensa conseguiu claim: %', result;
  end if;

  result := public.claim_opportunity_atomic(
    '10000000-0000-4000-8000-00000000d104', offboarded, 1
  );
  if result ->> 'error' <> 'teacher_not_active_for_tenant'
     or exists (
       select 1 from public.appointments where student_name = 'Lead Offboarded'
     ) then
    raise exception 'assertion failed: professor offboarded conseguiu claim: %', result;
  end if;

  result := public.claim_opportunity_atomic(
    '10000000-0000-4000-8000-00000000d105', teacher_a, 1
  );
  if result ->> 'error' <> 'teacher_schedule_conflict'
     or exists (
       select 1 from public.appointments
        where student_name = 'Lead Conflito Appointment'
     )
     or (select trial_appointment_id from public.opportunities
          where id = '10000000-0000-4000-8000-00000000d105') is not null then
    raise exception 'assertion failed: conflito de appointment deixou orfao: %', result;
  end if;

  result := public.claim_opportunity_atomic(
    '10000000-0000-4000-8000-00000000d106', teacher_a, 1
  );
  if result ->> 'error' <> 'teacher_schedule_conflict'
     or exists (
       select 1 from public.appointments
        where student_name = 'Lead Conflito Booking'
     )
     or (select trial_appointment_id from public.opportunities
          where id = '10000000-0000-4000-8000-00000000d106') is not null then
    raise exception 'assertion failed: conflito de booking deixou orfao: %', result;
  end if;

  result := public.claim_opportunity_atomic(
    '10000000-0000-4000-8000-00000000d107', teacher_a, 1
  );
  if result ->> 'error' <> 'opportunity_slot_expired'
     or exists (
       select 1 from public.appointments where student_name = 'Lead Expirado'
     ) then
    raise exception 'assertion failed: slot passado foi aceito: %', result;
  end if;

  result := public.claim_opportunity_atomic(
    '10000000-0000-4000-8000-00000000d109', teacher_a, 1
  );
  if result ->> 'error' <> 'invalid_opportunity_slot'
     or exists (
       select 1 from public.appointments where student_name = 'Lead Slot Invalido'
     ) then
    raise exception 'assertion failed: slot inconsistente foi aceito: %', result;
  end if;

  update public.tenants set saas_status = 'past_due'
   where id = 'claim-school-a';
  result := public.claim_opportunity_atomic(
    '10000000-0000-4000-8000-00000000d108', teacher_a, 1
  );
  if result ->> 'error' <> 'tenant_not_operational'
     or exists (
       select 1 from public.appointments where student_name = 'Lead Tenant Bloqueado'
     ) then
    raise exception 'assertion failed: tenant bloqueado conseguiu claim: %', result;
  end if;
  update public.tenants set saas_status = 'active'
   where id = 'claim-school-a';

  -- Controle positivo do tenant B prova que o isolamento nao bloqueia seu dono.
  result := public.claim_opportunity_atomic(
    '10000000-0000-4000-8000-00000000d102', teacher_b, 1
  );
  if not coalesce((result ->> 'ok')::boolean, false)
     or result ->> 'tenantId' <> 'claim-school-b' then
    raise exception 'assertion failed: professor legitimo do tenant B foi bloqueado: %', result;
  end if;
end;
$test$;

reset role;
rollback;
