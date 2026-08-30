-- A reabertura por broadcast cancela atomicamente o appointment antigo e não
-- pode ser chamada por clientes públicos nem atravessar tenants.

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
values
  ('trial-broadcast-test', 'Trial Broadcast Test'),
  ('trial-broadcast-other', 'Trial Broadcast Other');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-4000-8000-000000000981',
  'authenticated',
  'authenticated',
  'trial-broadcast-teacher@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Teacher Broadcast"}',
  now(),
  now()
);

update public.profiles
   set tenant_id = 'trial-broadcast-test',
       role = 'TEACHER',
       full_name = 'Teacher Broadcast',
       phone = '5511999999981'
 where id = '00000000-0000-4000-8000-000000000981';

set local request.jwt.claims = '{"role":"service_role"}';

insert into public.appointments (
  id, tenant_id, teacher_id, professor_id,
  student_name, student_phone, start_time, status, type
)
values
  (
    '00000000-0000-4000-8000-000000000982',
    'trial-broadcast-test',
    '00000000-0000-4000-8000-000000000981',
    '00000000-0000-4000-8000-000000000981',
    'Aluno Broadcast', '5511999999982',
    date_trunc('day', now()) + interval '10 days 15 hours',
    'scheduled', 'experimental'
  ),
  (
    '00000000-0000-4000-8000-000000000983',
    'trial-broadcast-other',
    '00000000-0000-4000-8000-000000000981',
    '00000000-0000-4000-8000-000000000981',
    'Aluno Outro Tenant', '5511999999983',
    date_trunc('day', now()) + interval '11 days 15 hours',
    'scheduled', 'experimental'
  ),
  (
    '00000000-0000-4000-8000-000000000984',
    'trial-broadcast-test',
    '00000000-0000-4000-8000-000000000981',
    '00000000-0000-4000-8000-000000000981',
    'Aluno Concluído', '5511999999984',
    date_trunc('day', now()) + interval '12 days 15 hours',
    'completed', 'experimental'
  );

insert into public.opportunities (
  id, tenant_id, student_name, student_phone, slots_proposed,
  status, winner_teacher_id, professor_id, trial_appointment_id,
  trial_status, conversion_status, kind
)
values
  (
    '00000000-0000-4000-8000-000000000985',
    'trial-broadcast-test', 'Aluno Broadcast', '5511999999982', '[]'::jsonb,
    'CLAIMED',
    '00000000-0000-4000-8000-000000000981',
    '00000000-0000-4000-8000-000000000981',
    '00000000-0000-4000-8000-000000000982',
    'NO_SHOW_STUDENT', 'OPEN', 'TRIAL'
  ),
  (
    '00000000-0000-4000-8000-000000000986',
    'trial-broadcast-other', 'Aluno Outro Tenant', '5511999999983', '[]'::jsonb,
    'CLAIMED',
    '00000000-0000-4000-8000-000000000981',
    '00000000-0000-4000-8000-000000000981',
    '00000000-0000-4000-8000-000000000983',
    'NO_SHOW_TEACHER', 'OPEN', 'TRIAL'
  ),
  (
    '00000000-0000-4000-8000-000000000987',
    'trial-broadcast-test', 'Aluno Concluído', '5511999999984', '[]'::jsonb,
    'CLAIMED',
    '00000000-0000-4000-8000-000000000981',
    '00000000-0000-4000-8000-000000000981',
    '00000000-0000-4000-8000-000000000984',
    'NO_SHOW_TEACHER', 'OPEN', 'TRIAL'
  ),
  (
    '00000000-0000-4000-8000-000000000988',
    'trial-broadcast-test', 'Aluno Retry Direcionado', '5511999999988',
    jsonb_build_array(jsonb_build_object(
      'day', extract(dow from (
        (now() at time zone 'America/Sao_Paulo')::date + 31
      ))::integer,
      'date', to_char(
        (now() at time zone 'America/Sao_Paulo')::date + 31,
        'YYYY-MM-DD'
      ),
      'time', '19:00',
      'formatted', to_char(
        (now() at time zone 'America/Sao_Paulo')::date + 31,
        'DD/MM/YYYY'
      )
    )),
    'OPEN', null, null, null, null, 'OPEN', 'TRIAL'
  );

insert into private.vendor_trial_teacher_requests (
  id, tenant_id, opportunity_id, target_teacher_id,
  requested_by, slot_start, status
)
values (
  '00000000-0000-4000-8000-000000000989',
  'trial-broadcast-test',
  '00000000-0000-4000-8000-000000000988',
  '00000000-0000-4000-8000-000000000981',
  '00000000-0000-4000-8000-000000000981',
  (
    (
      (now() at time zone 'America/Sao_Paulo')::date + 31
    )::text || ' 19:00'
  )::timestamp at time zone 'America/Sao_Paulo',
  'AWAITING_TEACHER'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.reopen_trial_opportunity_for_broadcast(text,uuid,jsonb,text,jsonb)',
    'execute'
  ),
  'anon consegue reabrir experimental'
);
select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.reopen_trial_opportunity_for_broadcast(text,uuid,jsonb,text,jsonb)',
    'execute'
  ),
  'authenticated consegue reabrir experimental'
);
select pg_temp.assert_true(
  has_function_privilege(
    'service_role',
    'public.reopen_trial_opportunity_for_broadcast(text,uuid,jsonb,text,jsonb)',
    'execute'
  ),
  'service_role não consegue reabrir experimental'
);
select pg_temp.assert_true(
  (
    select procedure.prosecdef
       and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
       and exists (
         select 1
           from unnest(
             coalesce(procedure.proconfig, array[]::text[])
           ) setting
          where setting = 'search_path=""'
       )
      from pg_catalog.pg_proc as procedure
     where procedure.oid = to_regprocedure(
       'public.reopen_trial_opportunity_for_broadcast(text,uuid,jsonb,text,jsonb)'
     )
  ),
  'função de reabertura perdeu owner, SECURITY DEFINER ou search_path seguro'
);

set local role service_role;

do $test$
declare
  v_slot_date date := (now() at time zone 'America/Sao_Paulo')::date + 30;
  v_directed_slot_date date :=
    (now() at time zone 'America/Sao_Paulo')::date + 31;
  v_slots jsonb;
  v_directed_slots jsonb;
  v_result jsonb;
begin
  v_slots := jsonb_build_array(jsonb_build_object(
    'day', extract(dow from v_slot_date)::integer,
    'date', to_char(v_slot_date, 'YYYY-MM-DD'),
    'time', '18:00',
    'formatted', to_char(v_slot_date, 'DD/MM/YYYY')
  ));
  v_directed_slots := jsonb_build_array(jsonb_build_object(
    'day', extract(dow from v_directed_slot_date)::integer,
    'date', to_char(v_directed_slot_date, 'YYYY-MM-DD'),
    'time', '19:00',
    'formatted', to_char(v_directed_slot_date, 'DD/MM/YYYY')
  ));

  v_result := public.reopen_trial_opportunity_for_broadcast(
    'trial-broadcast-test',
    '00000000-0000-4000-8000-000000000988',
    v_directed_slots,
    null,
    null
  );
  if not coalesce((v_result ->> 'ok')::boolean, false)
     or not coalesce((v_result ->> 'idempotent')::boolean, false) then
    raise exception
      'assertion failed: retry direcionado não foi idempotente: %',
      v_result;
  end if;

  v_result := public.reopen_trial_opportunity_for_broadcast(
    'trial-broadcast-test',
    '00000000-0000-4000-8000-000000000985',
    '[{"day":1,"date":"2099-09-01","time":"29:00"}]'::jsonb,
    null,
    null
  );
  if v_result ->> 'error' <> 'invalid_slots' then
    raise exception 'assertion failed: horario impossível foi aceito: %', v_result;
  end if;

  v_result := public.reopen_trial_opportunity_for_broadcast(
    'trial-broadcast-test',
    '00000000-0000-4000-8000-000000000985',
    jsonb_build_array(jsonb_build_object(
      'day', (extract(dow from v_slot_date)::integer + 1) % 7,
      'date', to_char(v_slot_date, 'YYYY-MM-DD'),
      'time', '18:00'
    )),
    null,
    null
  );
  if v_result ->> 'error' <> 'invalid_slots' then
    raise exception 'assertion failed: dia divergente da data foi aceito: %', v_result;
  end if;

  v_result := public.reopen_trial_opportunity_for_broadcast(
    'trial-broadcast-test',
    '00000000-0000-4000-8000-000000000985',
    jsonb_build_array(jsonb_build_object(
      'day', 1,
      'date', to_char(now() at time zone 'America/Sao_Paulo' - interval '1 day', 'YYYY-MM-DD'),
      'time', '18:00'
    )),
    null,
    null
  );
  if v_result ->> 'error' <> 'invalid_slots' then
    raise exception 'assertion failed: horario passado foi aceito: %', v_result;
  end if;
  if (select status from public.appointments where id = '00000000-0000-4000-8000-000000000982') <> 'scheduled' then
    raise exception 'assertion failed: validacao alterou appointment antes da reabertura';
  end if;

  v_result := public.reopen_trial_opportunity_for_broadcast(
    'trial-broadcast-test',
    '00000000-0000-4000-8000-000000000985',
    v_slots,
    'Conversação',
    null
  );
  if not coalesce((v_result ->> 'ok')::boolean, false) then
    raise exception 'assertion failed: reabertura recusada: %', v_result;
  end if;
  if (select status from public.appointments where id = '00000000-0000-4000-8000-000000000982') <> 'cancelled' then
    raise exception 'assertion failed: appointment antigo permaneceu agendado';
  end if;
  if exists (
    select 1
      from public.opportunities
     where id = '00000000-0000-4000-8000-000000000985'
       and (
         status <> 'OPEN'
         or slots_proposed <> v_slots
         or winner_teacher_id is not null
         or professor_id is not null
         or accepted_slot is not null
         or trial_appointment_id is not null
         or trial_status is not null
         or claim_generation <> 2
         or opened_at < now() - interval '1 minute'
       )
  ) then
    raise exception 'assertion failed: oportunidade não foi reiniciada por completo';
  end if;

  v_result := public.reopen_trial_opportunity_for_broadcast(
    'trial-broadcast-test',
    '00000000-0000-4000-8000-000000000985',
    v_slots,
    null,
    null
  );
  if not coalesce((v_result ->> 'ok')::boolean, false)
     or not coalesce((v_result ->> 'idempotent')::boolean, false)
     or (v_result ->> 'claim_generation')::integer <> 2 then
    raise exception 'assertion failed: retry da reabertura nao foi idempotente: %', v_result;
  end if;

  v_result := public.reopen_trial_opportunity_for_broadcast(
    'trial-broadcast-test',
    '00000000-0000-4000-8000-000000000986',
    v_slots,
    null,
    null
  );
  if v_result ->> 'error' <> 'opportunity_not_found' then
    raise exception 'assertion failed: acesso entre tenants não foi barrado: %', v_result;
  end if;
  if (select status from public.appointments where id = '00000000-0000-4000-8000-000000000983') <> 'scheduled' then
    raise exception 'assertion failed: acesso entre tenants alterou appointment';
  end if;

  v_result := public.reopen_trial_opportunity_for_broadcast(
    'trial-broadcast-test',
    '00000000-0000-4000-8000-000000000987',
    v_slots,
    null,
    null
  );
  if v_result ->> 'error' <> 'appointment_finalized' then
    raise exception 'assertion failed: appointment concluído foi reaberto: %', v_result;
  end if;
end;
$test$;

reset role;

select pg_temp.assert_true(
  (
    select request.status = 'CANCELED'
      from private.vendor_trial_teacher_requests as request
     where request.id = '00000000-0000-4000-8000-000000000989'
  ),
  'retry de oportunidade OPEN manteve solicitação direcionada pendente'
);

rollback;
