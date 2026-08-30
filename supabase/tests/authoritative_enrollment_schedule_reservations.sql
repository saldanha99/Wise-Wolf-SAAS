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
grant execute on function pg_temp.assert_true(boolean,text) to public;

create or replace function pg_temp.enrollment_schedule(
  p_day_1 text,
  p_time_1 text,
  p_teacher_1 uuid,
  p_day_2 text,
  p_time_2 text,
  p_teacher_2 uuid
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(
    jsonb_build_object(
      'day', p_day_1,
      'time', p_time_1,
      'teacherId', p_teacher_1
    ),
    jsonb_build_object(
      'day', p_day_2,
      'time', p_time_2,
      'teacherId', p_teacher_2
    )
  )
$$;
grant execute on function pg_temp.enrollment_schedule(text,text,uuid,text,text,uuid)
  to public;

create or replace function pg_temp.enrollment_payload(
  p_schedule jsonb,
  p_start_date date default '2099-01-05'::date,
  p_billing_month text default '2099-02',
  p_enable_pro_rata boolean default true,
  p_forged_pro_rata numeric default 9999
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'unitId', 'enrollment-barrier-a',
    'value', 160,
    'dueDay', 10,
    'planDuration', 1,
    'classesPerWeek', 2,
    'requiresEnrollment', false,
    'enrollmentFee', 0,
    'startDate', to_char(p_start_date, 'YYYY-MM-DD'),
    'billingStartMonth', p_billing_month,
    'enableProRata', p_enable_pro_rata,
    'proRataValue', p_forged_pro_rata,
    'schedule', p_schedule,
    'testMode', true,
    'test_fixture', 'authoritative-enrollment-schedule'
  )
$$;
grant execute on function pg_temp.enrollment_payload(jsonb,date,text,boolean,numeric)
  to public;

create or replace function pg_temp.assert_schedule_reserved(
  p_offer_id uuid,
  p_student_id uuid
)
returns void
language plpgsql
as $$
begin
  perform private.lock_and_validate_enrollment_schedule(
    p_offer_id,
    p_student_id
  );
  raise exception 'assertion failed: aluno reservou o mesmo slot com outro professor';
exception when exclusion_violation then
  if sqlerrm <> 'enrollment_schedule_reserved' then raise; end if;
end;
$$;

insert into public.tenants (id, name, slug, saas_status, school_info)
values
  (
    'enrollment-barrier-a',
    'Enrollment Barrier A',
    'enrollment-barrier-a',
    'active',
    jsonb_build_object(
      'legalName', 'Enrollment Barrier A Ltda',
      'cnpj', '04252011000110',
      'address', 'Rua da Matricula, 100',
      'email', 'legal-a@example.invalid',
      'phone', '11999999999',
      'city', 'Sao Paulo',
      'state', 'SP',
      'legalRepresentativeName', 'Representante A',
      'legalRepresentativeSignaturePath',
        'enrollment-barrier-a/legal-representative-signature/00000000-0000-4000-8000-00000000e6a1.png'
    )
  ),
  (
    'enrollment-barrier-b',
    'Enrollment Barrier B',
    'enrollment-barrier-b',
    'active',
    jsonb_build_object(
      'legalName', 'Enrollment Barrier B Ltda',
      'cnpj', '11222333000181',
      'address', 'Rua da Matricula, 200',
      'email', 'legal-b@example.invalid',
      'phone', '21999999999',
      'city', 'Rio de Janeiro',
      'state', 'RJ',
      'legalRepresentativeName', 'Representante B',
      'legalRepresentativeSignaturePath',
        'enrollment-barrier-b/legal-representative-signature/00000000-0000-4000-8000-00000000e6b1.png'
    )
  );

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-00000000e601', 'authenticated', 'authenticated', 'enrollment-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Enrollment Admin"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e611', 'authenticated', 'authenticated', 'enrollment-teacher-1@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Enrollment Teacher 1"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e612', 'authenticated', 'authenticated', 'enrollment-teacher-2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Enrollment Teacher 2"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e613', 'authenticated', 'authenticated', 'enrollment-teacher-inactive@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Enrollment Teacher Inactive"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e614', 'authenticated', 'authenticated', 'enrollment-teacher-cross@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Enrollment Teacher Cross"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e621', 'authenticated', 'authenticated', 'enrollment-student-1@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Um"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e622', 'authenticated', 'authenticated', 'enrollment-student-2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Dois"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e623', 'authenticated', 'authenticated', 'enrollment-dependent@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Dependente"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e631', 'authenticated', 'authenticated', 'enrollment-guardian@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Responsavel Oficial"}', now(), now());

update public.profiles
set tenant_id = 'enrollment-barrier-a',
    role = 'SUPER_ADMIN',
    lifecycle_status = 'active'
where id = '00000000-0000-4000-8000-00000000e601';
update public.profiles
set tenant_id = 'enrollment-barrier-a',
    role = 'TEACHER',
    lifecycle_status = 'active',
    hourly_rate = 50
where id in (
  '00000000-0000-4000-8000-00000000e611',
  '00000000-0000-4000-8000-00000000e612'
);
update public.profiles
set tenant_id = 'enrollment-barrier-a',
    role = 'TEACHER',
    lifecycle_status = 'suspended',
    hourly_rate = 50
where id = '00000000-0000-4000-8000-00000000e613';
update public.profiles
set tenant_id = 'enrollment-barrier-b',
    role = 'TEACHER',
    lifecycle_status = 'active',
    hourly_rate = 50
where id = '00000000-0000-4000-8000-00000000e614';
update public.profiles
set tenant_id = 'enrollment-barrier-a',
    role = 'STUDENT',
    lifecycle_status = 'active',
    full_name = 'Responsavel Oficial',
    email = 'enrollment-guardian@example.invalid',
    cpf = '52998224725',
    phone = '11977777777',
    postal_code = '01001000',
    address = 'Rua do Responsavel',
    address_number = '10'
where id = '00000000-0000-4000-8000-00000000e631';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  ('00000000-0000-4000-8000-00000000e601', 'enrollment-barrier-a', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e611', 'enrollment-barrier-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e612', 'enrollment-barrier-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e613', 'enrollment-barrier-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e614', 'enrollment-barrier-b', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e631', 'enrollment-barrier-a', 'STUDENT', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values ('00000000-0000-4000-8000-00000000e601', 'enrollment-barrier-a')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = now();

insert into public.teacher_availability (
  teacher_id, tenant_id, day_of_week, start_time, end_time
)
values
  ('00000000-0000-4000-8000-00000000e611', 'enrollment-barrier-a', 0, '10:00', null),
  ('00000000-0000-4000-8000-00000000e611', 'enrollment-barrier-a', 1, '18:00', '21:00'),
  ('00000000-0000-4000-8000-00000000e611', 'enrollment-barrier-a', 2, '20:00', null),
  ('00000000-0000-4000-8000-00000000e611', 'enrollment-barrier-a', 2, '18:00', null),
  ('00000000-0000-4000-8000-00000000e611', 'enrollment-barrier-a', 4, '18:00', null),
  ('00000000-0000-4000-8000-00000000e611', 'enrollment-barrier-a', 5, '18:00', '21:00'),
  ('00000000-0000-4000-8000-00000000e612', 'enrollment-barrier-a', 0, '11:00', null),
  ('00000000-0000-4000-8000-00000000e612', 'enrollment-barrier-a', 1, '18:00', null),
  ('00000000-0000-4000-8000-00000000e612', 'enrollment-barrier-a', 2, '20:00', null),
  ('00000000-0000-4000-8000-00000000e612', 'enrollment-barrier-a', 3, '20:00', null),
  ('00000000-0000-4000-8000-00000000e612', 'enrollment-barrier-a', 4, '20:00', null),
  ('00000000-0000-4000-8000-00000000e612', 'enrollment-barrier-a', 5, '20:00', null);

select pg_temp.assert_true(
  not has_table_privilege(
    'authenticated',
    'private.enrollment_offer_schedule_slots',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'private.enrollment_offer_schedule_slots',
    'SELECT'
  )
  and has_function_privilege(
    'service_role',
    'public.materialize_enrollment_offer_schedule(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.materialize_enrollment_offer_schedule(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.create_enrollment_offer_pre_schedule_impl(jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.begin_enrollment_offer_pre_schedule_impl(uuid,jsonb)',
    'EXECUTE'
  ),
  'ACL da grade relacional ou dos wrappers internos esta insegura'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    where procedure.oid = any (array[
      'private.prepare_enrollment_offer_payload(jsonb,text)'::regprocedure,
      'private.lock_and_validate_enrollment_schedule(uuid,uuid)'::regprocedure,
      'private.reserve_enrollment_offer_schedule(uuid,uuid)'::regprocedure,
      'private.prepare_enrollment_finance_scope(uuid,uuid)'::regprocedure,
      'private.protect_enrollment_schedule_reservation()'::regprocedure,
      'private.release_enrollment_slot_after_booking_end()'::regprocedure,
      'public.materialize_enrollment_offer_schedule(uuid,uuid)'::regprocedure,
      'private.assert_materialized_enrollment_schedule(uuid,uuid)'::regprocedure,
      'public.create_enrollment_offer_pre_schedule_impl(jsonb)'::regprocedure,
      'public.create_enrollment_offer(jsonb)'::regprocedure,
      'public.begin_enrollment_offer_pre_schedule_impl(uuid,jsonb)'::regprocedure,
      'public.begin_enrollment_offer(uuid,jsonb)'::regprocedure,
      'public.complete_enrollment_offer_pre_schedule_impl(uuid,uuid)'::regprocedure,
      'public.complete_enrollment_offer(uuid,uuid)'::regprocedure
    ]::oid[])
      and (
        not procedure.prosecdef
        or pg_catalog.pg_get_userbyid(procedure.proowner) <> 'postgres'
        or not coalesce(
          procedure.proconfig @> array['search_path=""']::text[],
          false
        )
      )
  ),
  'funcoes autoritativas de matricula nao estao endurecidas'
);

select pg_temp.assert_true(
  pg_catalog.pg_get_userbyid(
    (
      select relation.relowner
      from pg_catalog.pg_class as relation
      where relation.oid =
        'private.enrollment_offer_schedule_slots'::regclass
    )
  ) = 'postgres',
  'tabela autoritativa da grade nao pertence ao owner das funcoes'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e601","role":"authenticated"}';

do $$
begin
  perform public.create_enrollment_offer(
    pg_temp.enrollment_payload(null)
  );
  raise exception 'assertion failed: oferta sem schedule foi aceita';
exception when invalid_parameter_value then
  if sqlerrm <> 'enrollment_schedule_required' then raise; end if;
end;
$$;

do $$
begin
  perform public.create_enrollment_offer(
    pg_temp.enrollment_payload(
      pg_temp.enrollment_schedule(
        'Monday', '19:00', '00000000-0000-4000-8000-00000000e611',
        'Wednesday', '20:00', '00000000-0000-4000-8000-00000000e612'
      ),
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date - 1,
      to_char(current_date + interval '1 month', 'YYYY-MM'),
      false,
      9999
    )
  );
  raise exception 'assertion failed: oferta com inicio no passado foi aceita';
exception when invalid_parameter_value then
  if sqlerrm <> 'invalid_enrollment_billing_period' then raise; end if;
end;
$$;

do $$
begin
  perform public.create_enrollment_offer(
    pg_temp.enrollment_payload(
      pg_temp.enrollment_schedule(
        'Monday', '19:00', '00000000-0000-4000-8000-00000000e611',
        'Wednesday', '20:00', '00000000-0000-4000-8000-00000000e612'
      )
    ) || jsonb_build_object(
      'planDuration', 0,
      'enableProRata', true
    )
  );
  raise exception 'assertion failed: aula avulsa com pro-rata foi aceita';
exception when invalid_parameter_value then
  if sqlerrm <> 'pro_rata_not_applicable' then raise; end if;
end;
$$;

do $$
begin
  perform public.create_enrollment_offer(
    pg_temp.enrollment_payload(
      jsonb_build_array(
        jsonb_build_object(
          'day', 'Monday',
          'time', '19:00',
          'teacherId', '00000000-0000-4000-8000-00000000e611'
        )
      )
    )
  );
  raise exception 'assertion failed: cardinalidade divergente foi aceita';
exception when invalid_parameter_value then
  if sqlerrm <> 'enrollment_schedule_cardinality_mismatch' then raise; end if;
end;
$$;

do $$
begin
  perform public.create_enrollment_offer(
    pg_temp.enrollment_payload(
      pg_temp.enrollment_schedule(
        'Monday', '19:00', '00000000-0000-4000-8000-00000000e611',
        'Wednesday', '20:00', '00000000-0000-4000-8000-00000000e614'
      )
    )
  );
  raise exception 'assertion failed: professor de outro tenant foi aceito';
exception when insufficient_privilege then
  if sqlerrm <> 'inactive_enrollment_teacher' then raise; end if;
end;
$$;

do $$
begin
  perform public.create_enrollment_offer(
    pg_temp.enrollment_payload(
      pg_temp.enrollment_schedule(
        'Monday', '19:00', '00000000-0000-4000-8000-00000000e611',
        'Saturday', '20:00', '00000000-0000-4000-8000-00000000e612'
      )
    )
  );
  raise exception 'assertion failed: slot sem disponibilidade foi aceito';
exception when exclusion_violation then
  if sqlerrm <> 'teacher_slot_unavailable' then raise; end if;
end;
$$;

reset role;
update public.profiles
set phone = '11000000000'
where id = '00000000-0000-4000-8000-00000000e631';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e601","role":"authenticated"}';

do $$
begin
  perform public.create_enrollment_offer(
    pg_temp.enrollment_payload(
      pg_temp.enrollment_schedule(
        'Thursday', '18:00', '00000000-0000-4000-8000-00000000e611',
        'Friday', '20:00', '00000000-0000-4000-8000-00000000e612'
      )
    ) || jsonb_build_object(
      'isDependent', true,
      'guardianId', '00000000-0000-4000-8000-00000000e631',
      'studentPhone', '11987654321'
    )
  );
  raise exception 'assertion failed: responsavel sem contato valido foi aceito';
exception when invalid_parameter_value then
  if sqlerrm <> 'dependent_guardian_contact_invalid' then raise; end if;
end;
$$;

reset role;
update public.profiles
set phone = '11977777777'
where id = '00000000-0000-4000-8000-00000000e631';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e601","role":"authenticated"}';

select public.create_enrollment_offer(
  pg_temp.enrollment_payload(
    pg_temp.enrollment_schedule(
      'Monday', '19:00', '00000000-0000-4000-8000-00000000e611',
      'Wednesday', '20:00', '00000000-0000-4000-8000-00000000e612'
    )
  )
) as main_offer_id \gset

select public.create_enrollment_offer(
  pg_temp.enrollment_payload(
    pg_temp.enrollment_schedule(
      'Monday', '19:00', '00000000-0000-4000-8000-00000000e611',
      'Wednesday', '20:00', '00000000-0000-4000-8000-00000000e612'
    )
  )
) as competing_offer_id \gset

select public.create_enrollment_offer(
  pg_temp.enrollment_payload(
    pg_temp.enrollment_schedule(
      'Friday', '18:00', '00000000-0000-4000-8000-00000000e611',
      'Tuesday', '20:00', '00000000-0000-4000-8000-00000000e612'
    )
  )
) as changed_offer_id \gset

select public.create_enrollment_offer(
  pg_temp.enrollment_payload(
    pg_temp.enrollment_schedule(
      'Friday', '19:00', '00000000-0000-4000-8000-00000000e611',
      'Tuesday', '20:00', '00000000-0000-4000-8000-00000000e612'
    ),
    current_date,
    to_char(current_date - interval '1 month', 'YYYY-MM'),
    false,
    8888
  )
) as rolled_billing_offer_id \gset

select public.create_enrollment_offer(
  pg_temp.enrollment_payload(
    pg_temp.enrollment_schedule(
      'Monday', '18:00', '00000000-0000-4000-8000-00000000e611',
      'Tuesday', '20:00', '00000000-0000-4000-8000-00000000e612'
    ),
    '2099-01-05',
    '2099-02',
    false,
    3333
  )
) as expired_student_lease_offer_id \gset

select public.create_enrollment_offer(
  pg_temp.enrollment_payload(
    pg_temp.enrollment_schedule(
      'Monday', '18:00', '00000000-0000-4000-8000-00000000e612',
      'Tuesday', '20:00', '00000000-0000-4000-8000-00000000e611'
    ),
    '2099-01-05',
    '2099-02',
    false,
    2222
  )
) as replacement_student_lease_offer_id \gset

reset role;

select pg_temp.assert_true(
  (
    select
      (normalized ->> 'pricePerClass')::numeric = 8.33
      and (normalized ->> 'proRataClassCount')::integer = 5
      and (normalized ->> 'proRataValue')::numeric = 41.65
    from (
      select private.prepare_enrollment_offer_payload(
        jsonb_build_object(
          'unitId', 'enrollment-barrier-a',
          'value', 100,
          'dueDay', 10,
          'planDuration', 1,
          'classesPerWeek', 3,
          'startDate', '2099-01-01',
          'billingStartMonth', '2099-01',
          'enableProRata', true,
          'proRataValue', 9999,
          'schedule', jsonb_build_array(
            jsonb_build_object(
              'day', 'Thursday',
              'time', '18:00',
              'teacherId', '00000000-0000-4000-8000-00000000e611'
            ),
            jsonb_build_object(
              'day', 'Friday',
              'time', '19:00',
              'teacherId', '00000000-0000-4000-8000-00000000e611'
            ),
            jsonb_build_object(
              'day', 'Monday',
              'time', '20:00',
              'teacherId', '00000000-0000-4000-8000-00000000e611'
            )
          )
        ),
        'enrollment-barrier-a'
      ) as normalized
    ) as authoritative_rounding
  ),
  'pro-rata nao multiplicou o valor por aula arredondado'
);

select pg_temp.assert_true(
  (
    select
      normalized ->> 'enableProRata' = 'false'
      and (normalized ->> 'proRataValue')::numeric = 0
      and (normalized ->> 'proRataClassCount')::integer = 5
      and (normalized ->> 'pricePerClass')::numeric = 8.33
    from (
      select private.prepare_enrollment_offer_payload(
        jsonb_build_object(
          'unitId', 'enrollment-barrier-a',
          'value', 100,
          'dueDay', 10,
          'planDuration', 1,
          'classesPerWeek', 3,
          'startDate', '2099-01-01',
          'billingStartMonth', '2099-01',
          'enableProRata', false,
          'proRataValue', 9999,
          'schedule', jsonb_build_array(
            jsonb_build_object(
              'day', 'Thursday',
              'time', '18:00',
              'teacherId', '00000000-0000-4000-8000-00000000e611'
            ),
            jsonb_build_object(
              'day', 'Friday',
              'time', '19:00',
              'teacherId', '00000000-0000-4000-8000-00000000e611'
            ),
            jsonb_build_object(
              'day', 'Monday',
              'time', '20:00',
              'teacherId', '00000000-0000-4000-8000-00000000e611'
            )
          )
        ),
        'enrollment-barrier-a'
      ) as normalized
    ) as disabled_prorata
  ),
  'opt-out de pro-rata foi ignorado ou preservou valor monetario forjado'
);

select pg_temp.assert_true(
  (
    select normalized ->> 'professorId'
             = '00000000-0000-4000-8000-00000000e611'
      and normalized ->> 'professorId2'
             = '00000000-0000-4000-8000-00000000e612'
      and normalized #>> '{schedule,0,teacherId}'
             = '00000000-0000-4000-8000-00000000e612'
    from (
      select private.prepare_enrollment_offer_payload(
        pg_temp.enrollment_payload(
          pg_temp.enrollment_schedule(
            'Wednesday', '20:00', '00000000-0000-4000-8000-00000000e612',
            'Monday', '19:00', '00000000-0000-4000-8000-00000000e611'
          )
        ) || jsonb_build_object(
          'professorId', '00000000-0000-4000-8000-00000000e611',
          'professorId2', '00000000-0000-4000-8000-00000000e612'
        ),
        'enrollment-barrier-a'
      ) as normalized
    ) as teacher_ordering
  ),
  'slot inicial secundario trocou professor principal e secundario'
);

update private.enrollment_offer_schedule_slots
set status = 'RESERVED',
    reserved_by = '00000000-0000-4000-8000-00000000e622',
    reserved_at = now() - interval '1 hour',
    reservation_expires_at = now() + interval '30 minutes'
where offer_id = :'expired_student_lease_offer_id'::uuid;

select pg_temp.assert_schedule_reserved(
  :'replacement_student_lease_offer_id'::uuid,
  '00000000-0000-4000-8000-00000000e622'
);

update private.enrollment_offer_schedule_slots
set reservation_expires_at = now() - interval '1 minute'
where offer_id = :'expired_student_lease_offer_id'::uuid;

select private.lock_and_validate_enrollment_schedule(
  :'replacement_student_lease_offer_id'::uuid,
  '00000000-0000-4000-8000-00000000e622'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from private.enrollment_offer_schedule_slots
    where offer_id = :'expired_student_lease_offer_id'::uuid
      and reservation_expires_at > now()
  ),
  'lease vencido do aluno com outro professor bloqueou uma nova grade'
);

select pg_temp.assert_true(
  (
    select
      (payload ->> 'proRataValue')::numeric = 220
      and (payload ->> 'proRataValue')::numeric <> 9999
      and (payload ->> 'proRataClassCount')::integer = 11
      and (payload ->> 'pricePerClass')::numeric = 20
      and payload ->> 'proRataFormulaVersion'
          = 'weekly-frequency-times-4-v1'
      and payload ->> 'proRataIntervalStartInclusive' = '2099-01-05'
      and payload ->> 'proRataIntervalEndExclusive' = '2099-02-10'
      and metadata ->> 'pro_rata_formula_version'
          = 'weekly-frequency-times-4-v1'
      and metadata -> 'pro_rata_value' = payload -> 'proRataValue'
      and payload ->> 'professorId'
          = '00000000-0000-4000-8000-00000000e611'
      and payload ->> 'professorId2'
          = '00000000-0000-4000-8000-00000000e612'
      and payload #>> '{schedule,0,day}' = 'Monday'
      and payload #>> '{schedule,0,time}' = '19:00'
    from public.offers
    where id = :'main_offer_id'::uuid
  ),
  'snapshot autoritativo de professores/pro-rata foi adulterado ou incompleto'
);

select pg_temp.assert_true(
  (
    select payload ->> 'enableProRata' = 'false'
      and (payload ->> 'proRataValue')::numeric = 0
      and (metadata ->> 'pro_rata_value')::numeric = 0
    from public.offers
    where id = :'expired_student_lease_offer_id'::uuid
  ),
  'oferta persistida ignorou opt-out de pro-rata ou manteve valor residual'
);

select pg_temp.assert_true(
  (
    select (payload ->> 'firstBillingDate')::date >= current_date
      and payload ->> 'billingStartMonth'
          = to_char((payload ->> 'firstBillingDate')::date, 'YYYY-MM')
    from public.offers
    where id = :'rolled_billing_offer_id'::uuid
  ),
  'mes de cobranca passado nao foi rolado como na previa do cliente'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
      and count(distinct teacher_id) = 2
      and min(day_name) is not null
    from private.enrollment_offer_schedule_slots
    where offer_id = :'main_offer_id'::uuid
      and status = 'OFFERED'
  ),
  'grade normalizada nao foi persistida relacionalmente'
);

insert into public.bookings (
  tenant_id, teacher_id, student_id, day_of_week,
  time_slot, date, start_date, status
)
values (
  'enrollment-barrier-a',
  '00000000-0000-4000-8000-00000000e611',
  '00000000-0000-4000-8000-00000000e622',
  'Sexta',
  '18:00',
  '2098-01-03',
  '2098-01-03',
  'SCHEDULED'
)
returning id as blocking_booking_id \gset

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e621","role":"authenticated"}';

select pg_temp.assert_true(
  public.begin_enrollment_offer(
    :'changed_offer_id'::uuid,
    jsonb_build_object(
      'full_name', 'Aluno Um',
      'phone', '11999999999',
      'cpf', '11144477735',
      'billing_type', 'PIX',
      'typed_signature', 'Aluno Um'
    )
  ) ->> 'error' = 'SCHEDULE_UNAVAILABLE',
  'booking criado apos a oferta nao bloqueou begin'
);

reset role;

select pg_temp.assert_true(
  (
    select processing_by is null
    from public.offers
    where id = :'changed_offer_id'::uuid
  )
  and not exists (
    select 1
    from private.enrollment_offer_schedule_slots
    where offer_id = :'changed_offer_id'::uuid
      and status <> 'OFFERED'
  )
  and (
    select tenant_id is null
    from public.profiles
    where id = '00000000-0000-4000-8000-00000000e621'
  ),
  'begin rejeitado deixou reserva, lease ou perfil parcial'
);

delete from public.bookings where id = :'blocking_booking_id'::uuid;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e621","role":"authenticated"}';

select pg_temp.assert_true(
  public.begin_enrollment_offer(
    :'main_offer_id'::uuid,
    jsonb_build_object(
      'full_name', 'Aluno Um',
      'phone', '11999999999',
      'cpf', '11144477735',
      'billing_type', 'PIX',
      'typed_signature', 'Aluno Um'
    )
  ) ->> 'success' = 'true',
  'begin valido nao reservou a grade'
);

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e622","role":"authenticated"}';

select pg_temp.assert_true(
  public.begin_enrollment_offer(
    :'competing_offer_id'::uuid,
    jsonb_build_object(
      'full_name', 'Aluno Dois',
      'phone', '11988888888',
      'cpf', '12345678909',
      'billing_type', 'PIX',
      'typed_signature', 'Aluno Dois'
    )
  ) ->> 'error' = 'SCHEDULE_UNAVAILABLE',
  'segunda oferta reservou slot ja reservado'
);

reset role;

do $$
begin
  insert into public.bookings (
    tenant_id, teacher_id, student_id, day_of_week,
    time_slot, start_date, status
  )
  values (
    'enrollment-barrier-a',
    '00000000-0000-4000-8000-00000000e611',
    '00000000-0000-4000-8000-00000000e622',
    'Segunda',
    '19:00',
    '2099-01-05',
    'SCHEDULED'
  );
  raise exception 'assertion failed: booking atravessou reserva de matricula';
exception when exclusion_violation then
  if sqlerrm <> 'booking_conflicts_with_enrollment_reservation' then raise; end if;
end;
$$;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select public.materialize_enrollment_offer_schedule(
  :'main_offer_id'::uuid,
  '00000000-0000-4000-8000-00000000e621'
) as materialized_result \gset

select pg_temp.assert_true(
  (:'materialized_result'::jsonb ->> 'success')::boolean
  and (:'materialized_result'::jsonb ->> 'booking_count')::integer = 2
  and not (:'materialized_result'::jsonb ->> 'idempotent')::boolean,
  'materializacao inicial nao criou exatamente dois bookings'
);

select public.materialize_enrollment_offer_schedule(
  :'main_offer_id'::uuid,
  '00000000-0000-4000-8000-00000000e621'
) as materialized_retry_result \gset

select pg_temp.assert_true(
  (:'materialized_retry_result'::jsonb ->> 'success')::boolean
  and (:'materialized_retry_result'::jsonb ->> 'idempotent')::boolean
  and (
    select count(*) = 2
      and count(distinct teacher_id) = 2
    from public.bookings
    where enrollment_offer_id = :'main_offer_id'::uuid
      and student_id = '00000000-0000-4000-8000-00000000e621'
  ),
  'retry de materializacao duplicou ou perdeu professor por slot'
);

reset role;
update public.offers
set payload = pg_catalog.jsonb_set(payload, '{planDuration}', '0'::jsonb),
    metadata = (metadata - 'subscription_id' - 'enrollment_payment_id')
      || jsonb_build_object('asaas_customer_id', 'cus_scope_probe')
where id = :'main_offer_id'::uuid;
update public.profiles
set asaas_customer_id = 'cus_scope_probe',
    subscription_id = 'sub_foreign_offer',
    enrollment_payment_id = null
where id = '00000000-0000-4000-8000-00000000e621';

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  public.complete_enrollment_offer(
    :'main_offer_id'::uuid,
    '00000000-0000-4000-8000-00000000e621'
  ) ->> 'error' = 'SUBSCRIPTION_SCOPE_PENDING',
  'avulsa aceitou subscription_id divergente da oferta'
);

reset role;
update public.profiles
set subscription_id = null,
    enrollment_payment_id = 'pay_foreign_offer'
where id = '00000000-0000-4000-8000-00000000e621';

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  public.complete_enrollment_offer(
    :'main_offer_id'::uuid,
    '00000000-0000-4000-8000-00000000e621'
  ) ->> 'error' = 'ENROLLMENT_FEE_SCOPE_PENDING',
  'oferta sem taxa aceitou enrollment_payment_id divergente'
);

reset role;
update public.profiles
set asaas_customer_id = null,
    subscription_id = null,
    enrollment_payment_id = null
where id = '00000000-0000-4000-8000-00000000e621';
update public.offers
set payload = pg_catalog.jsonb_set(payload, '{planDuration}', '1'::jsonb),
    metadata = metadata
      - 'asaas_customer_id'
      - 'subscription_id'
      - 'enrollment_payment_id'
where id = :'main_offer_id'::uuid;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  public.complete_enrollment_offer(
    :'main_offer_id'::uuid,
    '00000000-0000-4000-8000-00000000e621'
  ) ->> 'error' = 'CUSTOMER_SCOPE_PENDING',
  'complete aceitou tentativa sem customer vinculado a oferta'
);

reset role;

update public.profiles
set asaas_customer_id = 'cus_enrollment_main',
    subscription_id = 'sub_enrollment_main',
    status_financial = 'ACTIVE'
where id = '00000000-0000-4000-8000-00000000e621';
update public.offers
set metadata = metadata || jsonb_build_object(
  'asaas_customer_id', 'cus_enrollment_main',
  'subscription_id', 'sub_enrollment_main'
)
where id = :'main_offer_id'::uuid;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  public.complete_enrollment_offer(
    :'main_offer_id'::uuid,
    '00000000-0000-4000-8000-00000000e621'
  ) ->> 'error' = 'PRO_RATA_CHARGE_PENDING',
  'complete aceitou pro-rata sem charge da propria oferta'
);

reset role;

-- Quando a escola tambem cobra taxa de matricula, o pro-rata nao pode
-- substitui-la. Primeiro liquida o proporcional e prova que a oferta espera a
-- taxa; depois liquida a taxa e somente entao conclui.
update public.profiles
set enrollment_payment_id = 'pay_enrollment_main_fee',
    enrollment_fee_paid = false
where id = '00000000-0000-4000-8000-00000000e621';
update public.offers
set enrollment_fee = 30,
    metadata = metadata || jsonb_build_object(
      'enrollment_payment_id', 'pay_enrollment_main_fee'
    )
where id = :'main_offer_id'::uuid;

-- Reproduz localmente o evento liquidado do pro-rata. A mensalidade da oferta
-- vale R$ 160, enquanto o valor proporcional autoritativo vale R$ 220; assim o
-- teste prova que a matricula nao exige nem antecipa a mensalidade cheia.
insert into public.student_payments (
  student_id,
  tenant_id,
  asaas_payment_id,
  asaas_id,
  provider_customer_id,
  value,
  amount_cents,
  status,
  provider_status,
  due_date,
  billing_type,
  payment_method,
  payment_type,
  raw_payload
)
values (
  '00000000-0000-4000-8000-00000000e621',
  'enrollment-barrier-a',
  'pay_enrollment_main_prorata',
  'pay_enrollment_main_prorata',
  'cus_enrollment_main',
  220,
  22000,
  'RECEIVED',
  'RECEIVED',
  current_date,
  'PIX',
  'PIX',
  'PRO_RATA',
  jsonb_build_object(
    'testMode', true,
    'test_fixture', 'authoritative-enrollment-schedule',
    'payment', jsonb_build_object(
      'externalReference',
        'enrollment:' || :'main_offer_id' || ':pro-rata'
    )
  )
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select public.resolve_enrollment_payment_observation_binding(
  'enrollment-barrier-a',
  '00000000-0000-4000-8000-00000000e621',
  'pay_enrollment_main_prorata',
  'enrollment:' || :'main_offer_id' || ':pro-rata',
  'SETTLED'
) as pro_rata_binding_result \gset
select pg_temp.assert_true(
  :'pro_rata_binding_result'::jsonb ->> 'payment_kind'
    = 'PRO_RATA'
  and :'pro_rata_binding_result'::jsonb ->> 'external_reference'
    = 'enrollment:' || :'main_offer_id' || ':pro-rata',
  'resolver nao vinculou o primeiro pro-rata liquidado da propria oferta'
);

select public.apply_enrollment_payment_observation(
  'enrollment-barrier-a',
  '00000000-0000-4000-8000-00000000e621',
  :'main_offer_id'::uuid,
  'pay_enrollment_main_prorata',
  'cus_enrollment_main',
  null,
  'PRO_RATA',
  'SETTLED',
  220,
  'enrollment:' || :'main_offer_id' || ':pro-rata',
  'RECEIVED',
  current_date,
  'PIX',
  'Pro-rata de matricula'
) as pro_rata_observation_result \gset
select pg_temp.assert_true(
  :'pro_rata_observation_result'::jsonb ->> 'action' = 'BILLING_RECORDED'
  and :'pro_rata_observation_result'::jsonb ->> 'processing_state'
    = 'BILLING_READY'
  and :'pro_rata_observation_result'::jsonb ->> 'completion_error'
    = 'ENROLLMENT_FEE_SCOPE_PENDING',
  'pro-rata substituiu indevidamente a taxa de matricula: '
    || :'pro_rata_observation_result'
);

insert into public.student_payments (
  student_id,
  tenant_id,
  asaas_payment_id,
  asaas_id,
  provider_customer_id,
  value,
  amount_cents,
  status,
  provider_status,
  due_date,
  billing_type,
  payment_method,
  payment_type,
  raw_payload
)
values (
  '00000000-0000-4000-8000-00000000e621',
  'enrollment-barrier-a',
  'pay_enrollment_main_fee',
  'pay_enrollment_main_fee',
  'cus_enrollment_main',
  30,
  3000,
  'RECEIVED',
  'RECEIVED',
  current_date,
  'PIX',
  'PIX',
  'ENROLLMENT',
  jsonb_build_object(
    'testMode', true,
    'test_fixture', 'authoritative-enrollment-schedule',
    'payment', jsonb_build_object(
      'externalReference',
        'enrollment:' || :'main_offer_id' || ':fee'
    )
  )
);

select public.apply_enrollment_payment_observation(
  'enrollment-barrier-a',
  '00000000-0000-4000-8000-00000000e621',
  :'main_offer_id'::uuid,
  'pay_enrollment_main_fee',
  'cus_enrollment_main',
  null,
  'ENROLLMENT_FEE',
  'SETTLED',
  30,
  'enrollment:' || :'main_offer_id' || ':fee',
  'RECEIVED',
  current_date,
  'PIX',
  'Taxa de matricula'
) as completed_offer_result \gset
select pg_temp.assert_true(
  :'completed_offer_result'::jsonb ->> 'action' = 'COMPLETED'
  and :'completed_offer_result'::jsonb ->> 'processing_state' = 'COMPLETED',
  'taxa e pro-rata liquidados nao concluiram a oferta: '
    || :'completed_offer_result'
);

-- A mensalidade cheia posterior pertence apenas ao financeiro recorrente. Ela
-- nao pode ser reinterpretada como uma segunda ativacao nem gerar triagem.
select public.resolve_enrollment_payment_observation_binding(
  'enrollment-barrier-a',
  '00000000-0000-4000-8000-00000000e621',
  'pay_enrollment_main_future_month',
  'enrollment:' || :'main_offer_id' || ':subscription',
  'SETTLED'
) as future_installment_binding \gset
select pg_temp.assert_true(
  :'future_installment_binding'::jsonb ->> 'action' = 'NONE',
  'mensalidade futura foi confundida com ativacao da matricula'
);

-- Estorno integral do pro-rata reabre o requisito uma unica vez e preserva os
-- efeitos comerciais/auditoria ja produzidos pela conclusao.
update public.student_payments
set status = 'REFUNDED',
    provider_status = 'REFUNDED'
where asaas_payment_id = 'pay_enrollment_main_prorata';

select public.apply_enrollment_payment_observation(
  'enrollment-barrier-a',
  '00000000-0000-4000-8000-00000000e621',
  :'main_offer_id'::uuid,
  'pay_enrollment_main_prorata',
  'cus_enrollment_main',
  null,
  'PRO_RATA',
  'UNSETTLED',
  220,
  'enrollment:' || :'main_offer_id' || ':pro-rata',
  'REFUNDED',
  current_date,
  'PIX',
  'Pro-rata de matricula'
) as reopened_offer_result \gset
select pg_temp.assert_true(
  :'reopened_offer_result'::jsonb ->> 'action' = 'REOPENED'
  and :'reopened_offer_result'::jsonb ->> 'processing_state'
    = 'AWAITING_PAYMENT'
  and (
    select processing_state = 'AWAITING_PAYMENT'
      and not (metadata ? 'pro_rata_paid_at')
    from public.offers
    where id = :'main_offer_id'::uuid
  ),
  'estorno do pro-rata nao reabriu o requisito financeiro'
);

select public.apply_enrollment_payment_observation(
  'enrollment-barrier-a',
  '00000000-0000-4000-8000-00000000e621',
  :'main_offer_id'::uuid,
  'pay_enrollment_main_prorata',
  'cus_enrollment_main',
  null,
  'PRO_RATA',
  'UNSETTLED',
  220,
  'enrollment:' || :'main_offer_id' || ':pro-rata',
  'REFUNDED',
  current_date,
  'PIX',
  'Pro-rata de matricula'
) as replayed_refund_result \gset
select pg_temp.assert_true(
  :'replayed_refund_result'::jsonb ->> 'action' = 'REOPENED'
  and (
    select pg_catalog.count(*) = 1
    from public.asaas_reconciliation_issues
    where fingerprint = 'enrollment-unsettled:' || :'main_offer_id'
      || ':pay_enrollment_main_prorata'
  ),
  'replay do estorno duplicou a reconciliacao ou mudou o resultado'
);
reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e601","role":"authenticated"}';
select public.create_enrollment_offer(
  pg_temp.enrollment_payload(
    pg_temp.enrollment_schedule(
      'Tuesday', '18:00', '00000000-0000-4000-8000-00000000e611',
      'Thursday', '20:00', '00000000-0000-4000-8000-00000000e612'
    ),
    '2099-01-05',
    '2099-02',
    false,
    7777
  )
) as revalidation_offer_id \gset

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e622","role":"authenticated"}';
select pg_temp.assert_true(
  public.begin_enrollment_offer(
    :'revalidation_offer_id'::uuid,
    jsonb_build_object(
      'full_name', 'Aluno Dois',
      'phone', '11988888888',
      'cpf', '12345678909',
      'billing_type', 'PIX',
      'typed_signature', 'Aluno Dois'
    )
  ) ->> 'success' = 'true',
  'oferta de revalidacao nao iniciou'
);
reset role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  public.materialize_enrollment_offer_schedule(
    :'revalidation_offer_id'::uuid,
    '00000000-0000-4000-8000-00000000e622'
  ) ->> 'success' = 'true',
  'oferta de revalidacao nao materializou'
);
reset role;

update public.profiles
set lifecycle_status = 'suspended'
where id = '00000000-0000-4000-8000-00000000e612';

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  public.complete_enrollment_offer(
    :'revalidation_offer_id'::uuid,
    '00000000-0000-4000-8000-00000000e622'
  ) ->> 'error' = 'SCHEDULE_UNAVAILABLE',
  'complete nao revalidou lifecycle do professor'
);
reset role;
update public.profiles
set lifecycle_status = 'active'
where id = '00000000-0000-4000-8000-00000000e612';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e601","role":"authenticated"}';

do $$
begin
  perform public.create_enrollment_offer(
    pg_temp.enrollment_payload(
      pg_temp.enrollment_schedule(
        'Thursday', '18:00', '00000000-0000-4000-8000-00000000e611',
        'Friday', '20:00', '00000000-0000-4000-8000-00000000e612'
      )
    ) || jsonb_build_object(
      'isDependent', true,
      'guardianId', '00000000-0000-4000-8000-00000000e631',
      'studentPhone', null
    )
  );
  raise exception 'assertion failed: dependente sem telefone foi aceito';
exception when invalid_parameter_value then
  if sqlerrm <> 'dependent_student_phone_invalid' then raise; end if;
end;
$$;

select public.create_enrollment_offer(
  pg_temp.enrollment_payload(
    pg_temp.enrollment_schedule(
      'Thursday', '18:00', '00000000-0000-4000-8000-00000000e611',
      'Friday', '20:00', '00000000-0000-4000-8000-00000000e612'
    ),
    '2099-01-05',
    '2099-02',
    false,
    5555
  ) || jsonb_build_object(
    'isDependent', true,
    'guardianId', '00000000-0000-4000-8000-00000000e631',
    'studentPhone', '+55 (11) 98765-4321',
    'guardianName', 'Responsavel Falsificado',
    'guardianCpf', '00000000000',
    'guardianEmail', 'fraude@example.invalid',
    'guardianPhone', '11000000000',
    'guardianPostalCode', '99999999',
    'guardianAddress', 'Endereco falsificado',
    'guardianAddressNumber', '999',
    'guardianInjectedFutureField', 'nao deve sobreviver'
  )
) as dependent_offer_id \gset

reset role;

select pg_temp.assert_true(
  (
    select payload ->> 'guardianName' = 'Responsavel Oficial'
      and payload ->> 'guardianCpf' = '52998224725'
      and payload ->> 'guardianEmail'
          = 'enrollment-guardian@example.invalid'
      and payload ->> 'guardianPhone' = '11977777777'
      and payload ->> 'guardianPostalCode' = '01001000'
      and payload ->> 'guardianAddress' = 'Rua do Responsavel'
      and payload ->> 'guardianAddressNumber' = '10'
      and not payload ? 'guardianInjectedFutureField'
      and payload ->> 'studentPhone' = '11987654321'
      and payload -> '_schoolInfo' ->> 'legalName'
          = 'Enrollment Barrier A Ltda'
    from public.offers
    where id = :'dependent_offer_id'::uuid
  ),
  'snapshot do responsavel/escola aceitou dados do navegador'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e623","role":"authenticated"}';
select pg_temp.assert_true(
  public.begin_enrollment_offer(
    :'dependent_offer_id'::uuid,
    jsonb_build_object(
      'full_name', 'Aluno Dependente',
      'phone', '21999999999',
      'postal_code', '99999999',
      'address', 'Endereco do navegador',
      'address_number', '999',
      'billing_type', 'PIX',
      'typed_signature', 'Responsavel Oficial'
    )
  ) ->> 'success' = 'true',
  'matricula de dependente valida nao iniciou'
);
reset role;

select pg_temp.assert_true(
  (
    select phone = '11987654321'
      and attendance_phone = '11987654321'
      and postal_code = '01001000'
      and address = 'Rua do Responsavel'
      and address_number = '10'
      and guardian_name = 'Responsavel Oficial'
      and guardian_phone = '11977777777'
    from public.profiles
    where id = '00000000-0000-4000-8000-00000000e623'
  ),
  'begin nao forcou telefone do aluno ou perdeu snapshot do responsavel'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e601","role":"authenticated"}';
select public.create_enrollment_offer(
  pg_temp.enrollment_payload(
    pg_temp.enrollment_schedule(
      'Sunday', '10:00', '00000000-0000-4000-8000-00000000e611',
      'Sunday', '11:00', '00000000-0000-4000-8000-00000000e612'
    ),
    '2099-01-05',
    '2099-02',
    false,
    4444
  )
) as financial_conflict_offer_id \gset

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e621","role":"authenticated"}';
select pg_temp.assert_true(
  public.begin_enrollment_offer(
    :'financial_conflict_offer_id'::uuid,
    jsonb_build_object(
      'full_name', 'Aluno Um',
      'phone', '11999999999',
      'cpf', '11144477735',
      'billing_type', 'PIX',
      'typed_signature', 'Aluno Um'
    )
  ) ->> 'error' = 'FINANCIAL_SCOPE_CONFLICT',
  'nova oferta reutilizou IDs financeiros de tentativa anterior'
);
reset role;

select pg_temp.assert_true(
  (
    select processing_by is null
    from public.offers
    where id = :'financial_conflict_offer_id'::uuid
  )
  and not exists (
    select 1
    from private.enrollment_offer_schedule_slots
    where offer_id = :'financial_conflict_offer_id'::uuid
      and status <> 'OFFERED'
  )
  and (
    select asaas_customer_id = 'cus_enrollment_main'
      and subscription_id = 'sub_enrollment_main'
    from public.profiles
    where id = '00000000-0000-4000-8000-00000000e621'
  ),
  'conflito financeiro apagou IDs ou deixou reserva parcial'
);

rollback;
