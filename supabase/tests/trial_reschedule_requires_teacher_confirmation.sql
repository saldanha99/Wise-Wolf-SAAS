-- Remarcação de experimental só altera o appointment após o aceite explícito
-- do professor. Recusa e conflito preservam o horário anterior.

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

insert into public.tenants (id, name)
values ('trial-reschedule-test', 'Trial Reschedule Test');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-000000000971', 'authenticated', 'authenticated', 'trial-reschedule-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Confirmação"}', now(), now()),
  ('00000000-0000-4000-8000-000000000972', 'authenticated', 'authenticated', 'trial-reschedule-other@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Outro"}', now(), now());

update public.profiles
   set tenant_id = 'trial-reschedule-test', role = 'TEACHER',
       full_name = 'Teacher Confirmação', phone = '5511999999971'
 where id = '00000000-0000-4000-8000-000000000971';

update public.profiles
   set tenant_id = 'trial-reschedule-test', role = 'TEACHER',
       full_name = 'Teacher Outro', phone = '5511999999972'
 where id = '00000000-0000-4000-8000-000000000972';

set local request.jwt.claims = '{"role":"service_role"}';

insert into public.crm_leads (
  id, tenant_id, name, phone, status, created_at
)
values (
  '00000000-0000-4000-8000-000000000973',
  'trial-reschedule-test',
  'Lead Confirmação',
  '5511999999973',
  'CONTACTED',
  now()
);

insert into public.appointments (
  id, tenant_id, teacher_id, professor_id,
  student_name, student_phone, start_time, status, type
)
values (
  '00000000-0000-4000-8000-000000000974',
  'trial-reschedule-test',
  '00000000-0000-4000-8000-000000000971',
  '00000000-0000-4000-8000-000000000971',
  'Lead Confirmação',
  '5511999999973',
  date_trunc('day', now()) + interval '10 days 15 hours',
  'scheduled',
  'experimental'
);

insert into public.opportunities (
  id, tenant_id, student_name, student_phone, slots_proposed,
  status, winner_teacher_id, professor_id, trial_appointment_id, kind
)
values (
  '00000000-0000-4000-8000-000000000975',
  'trial-reschedule-test',
  'Lead Confirmação',
  '5511999999973',
  '[]'::jsonb,
  'CLAIMED',
  '00000000-0000-4000-8000-000000000971',
  '00000000-0000-4000-8000-000000000971',
  '00000000-0000-4000-8000-000000000974',
  'TRIAL'
);

select pg_temp.assert_true(
  not has_table_privilege('anon', 'public.trial_reschedule_requests', 'select'),
  'anon ganhou leitura direta dos pedidos'
);
select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.create_trial_reschedule_confirmation(text,uuid,uuid,uuid,uuid,timestamp with time zone)',
    'execute'
  ),
  'anon consegue abrir pedido de remarcacao'
);
select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.respond_trial_reschedule_confirmation(uuid,uuid,boolean,text)',
    'execute'
  ),
  'cliente autenticado consegue responder no lugar do webhook'
);

set local role service_role;

do $test$
declare
  v_appointment constant uuid := '00000000-0000-4000-8000-000000000974';
  v_opportunity constant uuid := '00000000-0000-4000-8000-000000000975';
  v_teacher constant uuid := '00000000-0000-4000-8000-000000000971';
  v_lead constant uuid := '00000000-0000-4000-8000-000000000973';
  v_original timestamptz;
  v_requested timestamptz := date_trunc('day', now()) + interval '11 days 18 hours';
  v_accepted timestamptz := date_trunc('day', now()) + interval '12 days 18 hours';
  v_conflict timestamptz := date_trunc('day', now()) + interval '13 days 18 hours';
  v_request uuid;
  v_result jsonb;
begin
  select start_time into v_original
    from public.appointments where id = v_appointment;

  v_result := public.create_trial_reschedule_confirmation(
    'trial-reschedule-test', v_opportunity, v_appointment,
    v_teacher, v_lead, v_requested
  );
  if not coalesce((v_result ->> 'ok')::boolean, false) then
    raise exception 'assertion failed: create recusado: %', v_result;
  end if;
  select id into v_request
    from public.trial_reschedule_requests
   where appointment_id = v_appointment and status = 'PENDING';
  if (select start_time from public.appointments where id = v_appointment)
     is distinct from v_original then
    raise exception 'assertion failed: pedido moveu a aula antes do aceite';
  end if;

  v_result := public.respond_trial_reschedule_confirmation(
    v_request, v_teacher, false, 'Bom dia, acredito que eu não consigo'
  );
  if v_result ->> 'status' <> 'DECLINED' then
    raise exception 'assertion failed: recusa nao foi persistida: %', v_result;
  end if;
  if (select start_time from public.appointments where id = v_appointment)
     is distinct from v_original then
    raise exception 'assertion failed: recusa alterou a agenda';
  end if;

  perform public.create_trial_reschedule_confirmation(
    'trial-reschedule-test', v_opportunity, v_appointment,
    v_teacher, v_lead, v_accepted
  );
  select id into v_request
    from public.trial_reschedule_requests
   where appointment_id = v_appointment and status = 'PENDING';
  v_result := public.respond_trial_reschedule_confirmation(
    v_request, v_teacher, true, 'Sim, consigo atender'
  );
  if v_result ->> 'status' <> 'ACCEPTED' then
    raise exception 'assertion failed: aceite nao foi persistido: %', v_result;
  end if;
  if (select start_time from public.appointments where id = v_appointment)
     is distinct from v_accepted then
    raise exception 'assertion failed: aceite nao moveu a agenda';
  end if;

  insert into public.appointments (
    id, tenant_id, teacher_id, professor_id,
    student_name, student_phone, start_time, status, type
  ) values (
    '00000000-0000-4000-8000-000000000976',
    'trial-reschedule-test', v_teacher, v_teacher,
    'Outro compromisso', '5511999999974', v_conflict, 'scheduled', 'experimental'
  );

  perform public.create_trial_reschedule_confirmation(
    'trial-reschedule-test', v_opportunity, v_appointment,
    v_teacher, v_lead, v_conflict
  );
  select id into v_request
    from public.trial_reschedule_requests
   where appointment_id = v_appointment and status = 'PENDING';
  v_result := public.respond_trial_reschedule_confirmation(
    v_request, v_teacher, true, 'Sim, consigo atender'
  );
  if v_result ->> 'error' <> 'teacher_conflict' then
    raise exception 'assertion failed: conflito foi aceito: %', v_result;
  end if;
  if (select start_time from public.appointments where id = v_appointment)
     is distinct from v_accepted then
    raise exception 'assertion failed: conflito alterou a agenda';
  end if;
end;
$test$;

reset role;
rollback;
