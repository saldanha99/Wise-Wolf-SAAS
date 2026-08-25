\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $function$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$function$;

create or replace function pg_temp.assert_sqlstate(
  statement text,
  expected_sqlstate text,
  message text
)
returns void
language plpgsql
as $function$
begin
  begin
    execute statement;
  exception
    when others then
      if sqlstate = expected_sqlstate then
        return;
      end if;
      raise exception 'assertion failed: % (expected %, received %)',
        message,
        expected_sqlstate,
        sqlstate;
  end;

  raise exception 'assertion failed: % (statement did not fail)', message;
end;
$function$;

update public.hub_settings
set metadata = coalesce(metadata, '{}'::jsonb)
      || '{"hubEnabled":true,"catalogReady":true}'::jsonb
where settings_key = 'default';

insert into public.hub_content_items (
  id, slug, title, content_type, preview_enabled, license_summary,
  rights_verified_at, rights_basis, catalog_scope, published_at,
  is_active, metadata
)
values (
  '7a300000-0000-4000-8000-000000000001',
  'hub-educator-planner-catalog-fixture',
  'Hub educator planner catalog fixture',
  'PDF',
  true,
  'Owned rollback-only test fixture',
  pg_catalog.now(),
  'OWNED',
  'COMMERCIAL_GLOBAL',
  pg_catalog.now(),
  true,
  '{"test_fixture":true}'::jsonb
);

insert into storage.objects (bucket_id, name, metadata)
values
  (
    'hub-library',
    'test-fixtures/hub-educator-planner/full.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  ),
  (
    'hub-library',
    'test-fixtures/hub-educator-planner/preview.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  );

insert into public.hub_content_assets (
  content_id, asset_kind, bucket_id, object_path, mime_type
)
values
  (
    '7a300000-0000-4000-8000-000000000001',
    'FULL',
    'hub-library',
    'test-fixtures/hub-educator-planner/full.pdf',
    'application/pdf'
  ),
  (
    '7a300000-0000-4000-8000-000000000001',
    'PREVIEW',
    'hub-library',
    'test-fixtures/hub-educator-planner/preview.pdf',
    'application/pdf'
  );

insert into auth.users (
  id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '79000000-0000-4000-8000-000000000101',
    'authenticated',
    'authenticated',
    'planner-owner-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Planner Owner A"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '79000000-0000-4000-8000-000000000102',
    'authenticated',
    'authenticated',
    'planner-member-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Planner Member A"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '79000000-0000-4000-8000-000000000103',
    'authenticated',
    'authenticated',
    'planner-member-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Planner Member B"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '79000000-0000-4000-8000-000000000104',
    'authenticated',
    'authenticated',
    'planner-owner-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Planner Owner B"}',
    pg_catalog.now(),
    pg_catalog.now()
  );

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
set tenant_id = null,
    lifecycle_status = 'active',
    role = 'NON_STUDENT'
where id in (
  '79000000-0000-4000-8000-000000000101',
  '79000000-0000-4000-8000-000000000102',
  '79000000-0000-4000-8000-000000000103',
  '79000000-0000-4000-8000-000000000104'
);
select pg_catalog.set_config('app.enrollment_claim', '', true);

insert into public.hub_plans (
  id,
  code,
  name,
  description,
  audience,
  price_monthly,
  price_yearly,
  currency,
  trial_days,
  display_order,
  is_public,
  is_active,
  features,
  metadata,
  product_family
)
values (
  '79000000-0000-4000-8000-000000000201',
  'HUB_PLANNER_SECURITY_FIXTURE',
  'Hub Planner Security Fixture',
  'Native planner isolation test.',
  'ALL',
  1,
  10,
  'BRL',
  0,
  999,
  false,
  true,
  '[]'::jsonb,
  '{"test_fixture":true,"product_family":"HUB_CORE"}'::jsonb,
  'HUB_CORE'
);

insert into public.hub_plan_entitlements (
  plan_id,
  feature_key,
  limit_value,
  reset_period,
  metadata
)
values (
  '79000000-0000-4000-8000-000000000201',
  'educator_ai.generate',
  100,
  'MONTH',
  '{"test_fixture":true}'::jsonb
);

insert into public.hub_accounts (
  id,
  account_type,
  audience,
  name,
  owner_user_id,
  status,
  metadata
)
values
  (
    '79000000-0000-4000-8000-000000000301',
    'ORGANIZATION',
    'INSTITUTION',
    'Planner Account A',
    '79000000-0000-4000-8000-000000000101',
    'ACTIVE',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '79000000-0000-4000-8000-000000000302',
    'ORGANIZATION',
    'INSTITUTION',
    'Planner Account B',
    '79000000-0000-4000-8000-000000000104',
    'ACTIVE',
    '{"test_fixture":true}'::jsonb
  );

insert into public.hub_memberships (
  account_id,
  user_id,
  membership_role,
  subject_role,
  status
)
values
  (
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000101',
    'OWNER',
    'EDUCATOR',
    'ACTIVE'
  ),
  (
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000102',
    'MEMBER',
    'EDUCATOR',
    'ACTIVE'
  ),
  (
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000103',
    'MEMBER',
    'EDUCATOR',
    'ACTIVE'
  ),
  (
    '79000000-0000-4000-8000-000000000302',
    '79000000-0000-4000-8000-000000000104',
    'OWNER',
    'EDUCATOR',
    'ACTIVE'
  );

insert into public.hub_subscriptions (
  id,
  account_id,
  plan_id,
  status,
  billing_cycle,
  current_period_starts_at,
  current_period_ends_at,
  provider,
  provider_subscription_id,
  product_family,
  metadata
)
values
  (
    '79000000-0000-4000-8000-000000000401',
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000201',
    'ACTIVE',
    'MONTHLY',
    pg_catalog.now() - interval '1 day',
    pg_catalog.now() + interval '1 month',
    'ASAAS',
    'sub_planner_security_a',
    'HUB_CORE',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '79000000-0000-4000-8000-000000000402',
    '79000000-0000-4000-8000-000000000302',
    '79000000-0000-4000-8000-000000000201',
    'ACTIVE',
    'MONTHLY',
    pg_catalog.now() - interval '1 day',
    pg_catalog.now() + interval '1 month',
    'ASAAS',
    'sub_planner_security_b',
    'HUB_CORE',
    '{"test_fixture":true}'::jsonb
  );

insert into public.hub_educator_learners (
  id,
  account_id,
  created_by,
  display_name,
  level_tag,
  objective,
  interests,
  notes
)
values
  (
    '79000000-0000-4000-8000-000000000501',
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000102',
    'Learner A1',
    'B1',
    'Apresentações profissionais',
    array['negócios'],
    'Prefere exemplos práticos.'
  ),
  (
    '79000000-0000-4000-8000-000000000502',
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000103',
    'Learner A2',
    'A2',
    'Viagens',
    array['turismo'],
    'Precisa de apoio visual.'
  ),
  (
    '79000000-0000-4000-8000-000000000503',
    '79000000-0000-4000-8000-000000000302',
    '79000000-0000-4000-8000-000000000104',
    'Learner B1',
    'C1',
    'Negociação',
    array['contratos'],
    'Dados da conta B.'
  );

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_plan_runs',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_plan_runs',
    'INSERT'
  )
  and pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_plans',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_plans',
    'INSERT'
  )
  and pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_memory',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_memory',
    'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_memory_proposals',
    'SELECT'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.hub_authorize_educator_planner_access(uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.save_hub_educator_plan_run(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.save_hub_educator_plan_run(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'Planner table and RPC privileges do not fail closed'
);

select pg_temp.assert_true(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    where relation.oid = 'public.hub_educator_learners'::regclass
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_learners',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_learners',
    'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_learners',
    'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_educator_learners',
    'DELETE'
  )
  and not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'hub_educator_learners'
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'public.hub_list_educator_learners(uuid)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'public.hub_create_educator_learner(uuid,text,text,text,text[],text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.hub_list_educator_learners(uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.hub_create_educator_learner(uuid,text,text,text,text[],text)',
    'EXECUTE'
  )
  and pg_catalog.has_table_privilege(
    'service_role',
    'public.hub_educator_learners',
    'SELECT'
  )
  and pg_catalog.has_table_privilege(
    'service_role',
    'public.hub_educator_learners',
    'INSERT'
  )
  and pg_catalog.has_table_privilege(
    'service_role',
    'public.hub_educator_learners',
    'UPDATE'
  )
  and pg_catalog.has_table_privilege(
    'service_role',
    'public.hub_educator_learners',
    'DELETE'
  ),
  'learner data is not restricted to the scoped RPC boundary'
);

select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_educator_plan_runs (
      id,
      account_id,
      learner_id,
      created_by,
      subscription_id,
      request_key,
      request_fingerprint,
      task_mode,
      model_id,
      prompt_version,
      plan
    ) values (
      '79000000-0000-4000-8000-000000000699',
      '79000000-0000-4000-8000-000000000301',
      '79000000-0000-4000-8000-000000000503',
      '79000000-0000-4000-8000-000000000102',
      '79000000-0000-4000-8000-000000000401',
      '79000000-0000-4000-8000-000000000799',
      repeat('f', 64),
      'lesson_plan',
      'test/model',
      'test-v1',
      '{}'::jsonb
    )
  $statement$,
  '23503',
  'a run accepted a learner from another account'
);

select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_educator_plan_runs (
      id,
      account_id,
      learner_id,
      created_by,
      subscription_id,
      request_key,
      request_fingerprint,
      task_mode,
      model_id,
      prompt_version,
      plan
    ) values (
      '79000000-0000-4000-8000-000000000698',
      '79000000-0000-4000-8000-000000000301',
      '79000000-0000-4000-8000-000000000501',
      '79000000-0000-4000-8000-000000000102',
      '79000000-0000-4000-8000-000000000402',
      '79000000-0000-4000-8000-000000000798',
      repeat('e', 64),
      'lesson_plan',
      'test/model',
      'test-v1',
      '{}'::jsonb
    )
  $statement$,
  '23503',
  'a run accepted a subscription from another account'
);

insert into public.hub_educator_plan_runs (
  id,
  account_id,
  learner_id,
  created_by,
  subscription_id,
  request_key,
  request_fingerprint,
  task_mode,
  duration_minutes,
  bilingual,
  teacher_request,
  model_id,
  prompt_version,
  knowledge,
  plan
)
values
  (
    '79000000-0000-4000-8000-000000000601',
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000501',
    '79000000-0000-4000-8000-000000000102',
    '79000000-0000-4000-8000-000000000401',
    '79000000-0000-4000-8000-000000000701',
    pg_catalog.repeat('a', 64),
    'lesson_plan',
    45,
    true,
    'Treinar apresentação.',
    'test/model',
    'test-v1',
    '{"mode":"HUB_PROFILE_ONLY"}'::jsonb,
    '{"objective":"Apresentar resultados","student_memory_update":{"lesson_objective":"Apresentar resultados","content_practiced":["opening a presentation"],"homework_assigned":"Gravar uma abertura","recommended_next_step":"Praticar transições"}}'::jsonb
  ),
  (
    '79000000-0000-4000-8000-000000000602',
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000502',
    '79000000-0000-4000-8000-000000000103',
    '79000000-0000-4000-8000-000000000401',
    '79000000-0000-4000-8000-000000000702',
    pg_catalog.repeat('b', 64),
    'homework',
    30,
    true,
    '',
    'test/model',
    'test-v1',
    '{}'::jsonb,
    '{"objective":"Vocabulário de viagem","student_memory_update":{"lesson_objective":"Vocabulário de viagem","content_practiced":["airport vocabulary"],"homework_assigned":"Completar atividade","recommended_next_step":"Simular check-in"}}'::jsonb
  ),
  (
    '79000000-0000-4000-8000-000000000603',
    '79000000-0000-4000-8000-000000000302',
    '79000000-0000-4000-8000-000000000503',
    '79000000-0000-4000-8000-000000000104',
    '79000000-0000-4000-8000-000000000402',
    '79000000-0000-4000-8000-000000000703',
    pg_catalog.repeat('c', 64),
    'class_script',
    60,
    false,
    '',
    'test/model',
    'test-v1',
    '{}'::jsonb,
    '{"objective":"Negociação","student_memory_update":{"lesson_objective":"Negociação","content_practiced":["counteroffers"],"homework_assigned":"Preparar proposta","recommended_next_step":"Praticar concessões"}}'::jsonb
  ),
  (
    '79000000-0000-4000-8000-000000000604',
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000501',
    '79000000-0000-4000-8000-000000000102',
    '79000000-0000-4000-8000-000000000401',
    '79000000-0000-4000-8000-000000000704',
    pg_catalog.repeat('d', 64),
    'lesson_plan',
    30,
    true,
    '',
    'test/model',
    'test-v1',
    '{}'::jsonb,
    '{"objective":"Sem consumo confirmado","student_memory_update":{}}'::jsonb
  );

insert into public.hub_usage_events (
  account_id,
  subscription_id,
  user_id,
  feature_key,
  units,
  request_key,
  metadata
)
values
  (
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000401',
    '79000000-0000-4000-8000-000000000102',
    'educator_ai.generate',
    1,
    '79000000-0000-4000-8000-000000000701',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000401',
    '79000000-0000-4000-8000-000000000103',
    'educator_ai.generate',
    1,
    '79000000-0000-4000-8000-000000000702',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '79000000-0000-4000-8000-000000000302',
    '79000000-0000-4000-8000-000000000402',
    '79000000-0000-4000-8000-000000000104',
    'educator_ai.generate',
    1,
    '79000000-0000-4000-8000-000000000703',
    '{"test_fixture":true}'::jsonb
  );

create temporary table hub_planner_test_results (
  result_key text primary key,
  payload jsonb not null
) on commit drop;

grant select, insert, update, delete
  on table hub_planner_test_results
  to authenticated, service_role;

set local role service_role;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

insert into hub_planner_test_results (result_key, payload)
values
  (
    'save_a1_first',
    public.save_hub_educator_plan_run(
      '79000000-0000-4000-8000-000000000601',
      '79000000-0000-4000-8000-000000000102',
      '79000000-0000-4000-8000-000000000301'
    )
  ),
  (
    'save_a1_replay',
    public.save_hub_educator_plan_run(
      '79000000-0000-4000-8000-000000000601',
      '79000000-0000-4000-8000-000000000102',
      '79000000-0000-4000-8000-000000000301'
    )
  ),
  (
    'save_a2',
    public.save_hub_educator_plan_run(
      '79000000-0000-4000-8000-000000000602',
      '79000000-0000-4000-8000-000000000103',
      '79000000-0000-4000-8000-000000000301'
    )
  ),
  (
    'save_b1',
    public.save_hub_educator_plan_run(
      '79000000-0000-4000-8000-000000000603',
      '79000000-0000-4000-8000-000000000104',
      '79000000-0000-4000-8000-000000000302'
    )
  );

select pg_temp.assert_true(
  (
    select payload ->> 'lessonPlanId'
      = (select payload ->> 'lessonPlanId'
         from hub_planner_test_results
         where result_key = 'save_a1_replay')
    from hub_planner_test_results
    where result_key = 'save_a1_first'
  )
  and (
    select payload ->> 'idempotent' = 'false'
    from hub_planner_test_results
    where result_key = 'save_a1_first'
  )
  and (
    select payload ->> 'idempotent' = 'true'
    from hub_planner_test_results
    where result_key = 'save_a1_replay'
  )
  and (
    select pg_catalog.count(*) = 1
    from public.hub_educator_plans
    where run_id = '79000000-0000-4000-8000-000000000601'
  )
  and (
    select payload -> 'memory' = 'null'::jsonb
    from hub_planner_test_results
    where result_key = 'save_a1_first'
  )
  and (
    select pg_catalog.count(*) = 0
    from public.hub_educator_memory
    where account_id = '79000000-0000-4000-8000-000000000301'
      and learner_id = '79000000-0000-4000-8000-000000000501'
      and created_by = '79000000-0000-4000-8000-000000000102'
  )
  and (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(verification_status = 'PROPOSED')
      and pg_catalog.bool_and(
        proposal ->> 'recommended_next_step' = 'Praticar transições'
      )
    from public.hub_educator_memory_proposals
    where run_id = '79000000-0000-4000-8000-000000000601'
  ),
  'save must be exactly once and must not invent observed learner performance'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.save_hub_educator_plan_run(
      '79000000-0000-4000-8000-000000000601',
      '79000000-0000-4000-8000-000000000103',
      '79000000-0000-4000-8000-000000000301'
    )
  $statement$,
  '42501',
  'a different member saved another member run'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.save_hub_educator_plan_run(
      '79000000-0000-4000-8000-000000000604',
      '79000000-0000-4000-8000-000000000102',
      '79000000-0000-4000-8000-000000000301'
    )
  $statement$,
  '42501',
  'an uncommitted generation was saved'
);

insert into public.hub_educator_memory (
  account_id,
  learner_id,
  created_by,
  accumulated_context,
  strong_points,
  weak_points,
  recommended_approach,
  total_classes_analyzed,
  metadata
)
values
  (
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000501',
    '79000000-0000-4000-8000-000000000102',
    'Contexto verificado A1',
    array['clareza'],
    array['transições'],
    'Praticar apresentações curtas.',
    3,
    '{"verification_status":"VERIFIED"}'::jsonb
  ),
  (
    '79000000-0000-4000-8000-000000000301',
    '79000000-0000-4000-8000-000000000502',
    '79000000-0000-4000-8000-000000000103',
    'Contexto verificado A2',
    array['compreensão'],
    array['vocabulário'],
    'Usar apoio visual.',
    2,
    '{"verification_status":"VERIFIED"}'::jsonb
  ),
  (
    '79000000-0000-4000-8000-000000000302',
    '79000000-0000-4000-8000-000000000503',
    '79000000-0000-4000-8000-000000000104',
    'Contexto verificado B1',
    array['negociação'],
    array['concessões'],
    'Praticar contrapropostas.',
    4,
    '{"verification_status":"VERIFIED"}'::jsonb
  );

reset role;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"79000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);

select pg_temp.assert_true(
  (
    select pg_catalog.jsonb_array_length(scoped.learners) = 1
      and scoped.learners->0->>'id'
        = '79000000-0000-4000-8000-000000000501'
    from (
      select public.hub_list_educator_learners(
        '79000000-0000-4000-8000-000000000301'
      ) as learners
    ) as scoped
  )
  and (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(created_by = '79000000-0000-4000-8000-000000000102')
    from public.hub_educator_plans
  )
  and (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(created_by = '79000000-0000-4000-8000-000000000102')
    from public.hub_educator_memory
  ),
  'MEMBER lost own Planner data or read another creator or account'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_list_educator_learners(
      '79000000-0000-4000-8000-000000000302'
    )
  $statement$,
  '42501',
  'MEMBER listed learners from another Hub account'
);

select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_educator_learners (
      account_id,
      created_by,
      display_name
    ) values (
      '79000000-0000-4000-8000-000000000301',
      '79000000-0000-4000-8000-000000000103',
      'Spoofed learner'
    )
  $statement$,
  '42501',
  'MEMBER spoofed learner ownership'
);

select pg_temp.assert_sqlstate(
  $statement$
    update public.hub_educator_learners
    set created_by = '79000000-0000-4000-8000-000000000103'
    where id = '79000000-0000-4000-8000-000000000501'
  $statement$,
  '42501',
  'MEMBER changed immutable learner ownership'
);

reset role;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"79000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);

select pg_temp.assert_true(
  (
    select pg_catalog.jsonb_array_length(scoped.learners) = 2
      and scoped.learners @> '[{"id":"79000000-0000-4000-8000-000000000501"}]'::jsonb
      and scoped.learners @> '[{"id":"79000000-0000-4000-8000-000000000502"}]'::jsonb
      and not scoped.learners @> '[{"id":"79000000-0000-4000-8000-000000000503"}]'::jsonb
    from (
      select public.hub_list_educator_learners(
        '79000000-0000-4000-8000-000000000301'
      ) as learners
    ) as scoped
  )
  and (
    select pg_catalog.count(*) = 2
    from public.hub_educator_plans
  )
  and (
    select pg_catalog.count(*) = 2
    from public.hub_educator_memory
  ),
  'OWNER lost account-wide access or crossed into another Hub account'
);

select pg_temp.assert_sqlstate(
  $statement$
    update public.hub_educator_learners
    set notes = 'Atualização direta do gestor'
    where id = '79000000-0000-4000-8000-000000000502'
  $statement$,
  '42501',
  'OWNER bypassed the learner RPC boundary through direct UPDATE'
);

select pg_temp.assert_sqlstate(
  $statement$
    delete from public.hub_educator_learners
    where id = '79000000-0000-4000-8000-000000000502'
  $statement$,
  '42501',
  'OWNER bypassed the learner RPC boundary through direct DELETE'
);

reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

update public.hub_educator_learners
set notes = 'Atualização do backend confiável'
where id = '79000000-0000-4000-8000-000000000502';

select pg_temp.assert_true(
  (
    select notes = 'Atualização do backend confiável'
    from public.hub_educator_learners
    where id = '79000000-0000-4000-8000-000000000502'
  ),
  'trusted backend cannot manage a learner inside the account'
);

delete from public.hub_educator_learners
where id = '79000000-0000-4000-8000-000000000502';
set constraints hub_educator_plans_run_fkey immediate;

select pg_temp.assert_true(
  not exists (
    select 1
    from public.hub_educator_learners
    where id = '79000000-0000-4000-8000-000000000502'
  )
  and not exists (
    select 1
    from public.hub_educator_plans
    where learner_id = '79000000-0000-4000-8000-000000000502'
  ),
  'trusted backend cannot delete a learner with a saved plan safely'
);

reset role;

rollback;
