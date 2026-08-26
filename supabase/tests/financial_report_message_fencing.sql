-- Financial WhatsApp reports permit a single irreversible submission. A
-- timeout remains UNKNOWN and a tenant/configuration change suppresses a
-- not-yet-submitted report.

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
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

select pg_temp.assert_true(
  not has_table_privilege(
    'anon', 'public.financial_report_message_attempts', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.financial_report_message_attempts', 'SELECT'
  )
  and has_table_privilege(
    'service_role', 'public.financial_report_message_attempts', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'public.financial_report_message_attempts', 'INSERT'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_financial_report_message(text,text,text,date,uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finish_financial_report_message(uuid,uuid,text,integer,text)',
    'EXECUTE'
  ),
  'financial report outbound fence privileges are unsafe'
);

insert into public.tenants (
  id,
  name,
  slug,
  saas_status,
  whatsapp_enabled
) values (
  'financial-report-fence-school',
  'Financial Report Fence School',
  'financial-report-fence-school',
  'active',
  true
);

insert into public.dre_report_settings (
  tenant_id,
  destino,
  cadencia,
  dia_semana,
  is_active
) values (
  'financial-report-fence-school',
  '5511999999999',
  'diaria',
  1,
  true
);

insert into public.tenant_admin_settings (
  tenant_id,
  student_notifications_enabled,
  teacher_notifications_enabled
) values (
  'financial-report-fence-school',
  true,
  true
)
on conflict (tenant_id) do update
set teacher_notifications_enabled = excluded.teacher_notifications_enabled;

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '53000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'financial-report-teacher-one@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Financial Report Teacher One"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '53000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'financial-report-teacher-two@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Financial Report Teacher Two"}',
    pg_catalog.now(),
    pg_catalog.now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'financial-report-fence-school',
       role = 'TEACHER',
       lifecycle_status = 'active',
       is_test_account = false
 where id in (
   '53000000-0000-4000-8000-000000000001',
   '53000000-0000-4000-8000-000000000002'
 );
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id in (
   '53000000-0000-4000-8000-000000000001',
   '53000000-0000-4000-8000-000000000002'
 );
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values
  (
    '53000000-0000-4000-8000-000000000001',
    'financial-report-fence-school',
    'TEACHER',
    'ACTIVE',
    true
  ),
  (
    '53000000-0000-4000-8000-000000000002',
    'financial-report-fence-school',
    'TEACHER',
    'ACTIVE',
    true
  );

insert into public.teacher_closings (
  id, tenant_id, teacher_id, month_year, period_start, period_end,
  total_lessons, total_amount, status
) values
  (
    '53000000-0000-4000-8000-000000000011',
    'financial-report-fence-school',
    '53000000-0000-4000-8000-000000000001',
    '2026-08',
    '2026-08-01',
    '2026-08-31',
    12,
    99.90,
    'PENDENTE'
  ),
  (
    '53000000-0000-4000-8000-000000000012',
    'financial-report-fence-school',
    '53000000-0000-4000-8000-000000000002',
    '2026-08',
    '2026-08-01',
    '2026-08-31',
    8,
    64.00,
    'PENDENTE'
  );

create temporary table financial_report_fence_results (
  label text primary key,
  payload jsonb not null
);

insert into financial_report_fence_results values (
  'dre-first',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'DRE_REPORT',
    'financial-report-fence-school:manual',
    '2026-08-25',
    '51000000-0000-4000-8000-000000000001',
    300
  )
);
insert into financial_report_fence_results values (
  'dre-concurrent',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'DRE_REPORT',
    'financial-report-fence-school:manual',
    '2026-08-25',
    '51000000-0000-4000-8000-000000000002',
    300
  )
);
insert into financial_report_fence_results values (
  'dre-submitting',
  public.mark_financial_report_message_submitting(
    (
      select (payload ->> 'attempt_id')::uuid
        from financial_report_fence_results where label = 'dre-first'
    ),
    '51000000-0000-4000-8000-000000000001'
  )
);
insert into financial_report_fence_results values (
  'dre-unknown',
  public.finish_financial_report_message(
    (
      select (payload ->> 'attempt_id')::uuid
        from financial_report_fence_results where label = 'dre-first'
    ),
    '51000000-0000-4000-8000-000000000001',
    'UNKNOWN',
    504,
    'provider_timeout'
  )
);
insert into financial_report_fence_results values (
  'dre-after-unknown',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'DRE_REPORT',
    'financial-report-fence-school:manual',
    '2026-08-25',
    '51000000-0000-4000-8000-000000000003',
    300
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' = 'SUBMIT_ONCE'
     from financial_report_fence_results where label = 'dre-first')
  and (select payload ->> 'action' = 'IN_PROGRESS'
         from financial_report_fence_results where label = 'dre-concurrent')
  and (select payload ->> 'status' = 'SUBMITTING'
         from financial_report_fence_results where label = 'dre-submitting')
  and (select payload ->> 'status' = 'UNKNOWN'
         from financial_report_fence_results where label = 'dre-unknown')
  and (select payload ->> 'action' = 'ALREADY_FINAL'
         and payload ->> 'status' = 'UNKNOWN'
         from financial_report_fence_results where label = 'dre-after-unknown')
  and (
    select submit_attempt_count = 1 and status = 'UNKNOWN'
      from public.financial_report_message_attempts
     where tenant_id = 'financial-report-fence-school'
       and notification_kind = 'DRE_REPORT'
       and subject_id = 'financial-report-fence-school:manual'
       and ref_date = '2026-08-25'
  ),
  'ambiguous DRE report was allowed a second provider submit'
);

insert into financial_report_fence_results values (
  'weekly-claim',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'WEEKLY_DIGEST',
    'financial-report-fence-school',
    '2026-08-25',
    '52000000-0000-4000-8000-000000000001',
    300
  )
);
update public.tenants
   set whatsapp_enabled = false
 where id = 'financial-report-fence-school';
insert into financial_report_fence_results values (
  'weekly-mark',
  public.mark_financial_report_message_submitting(
    (
      select (payload ->> 'attempt_id')::uuid
        from financial_report_fence_results where label = 'weekly-claim'
    ),
    '52000000-0000-4000-8000-000000000001'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' = 'SUBMIT_ONCE'
     from financial_report_fence_results where label = 'weekly-claim')
  and (select payload ->> 'status' = 'SUPPRESSED'
         from financial_report_fence_results where label = 'weekly-mark')
  and (
    select submit_attempt_count = 0 and status = 'SUPPRESSED'
      from public.financial_report_message_attempts
     where tenant_id = 'financial-report-fence-school'
       and notification_kind = 'WEEKLY_DIGEST'
       and subject_id = 'financial-report-fence-school'
       and ref_date = '2026-08-25'
  ),
  'disabled tenant crossed the weekly digest final pre-submit gate'
);

update public.tenants
   set whatsapp_enabled = true
 where id = 'financial-report-fence-school';

insert into financial_report_fence_results values (
  'monthly-wrong-date',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'MONTHLY_CLOSING',
    '53000000-0000-4000-8000-000000000001:2026-08:'
      || '53000000-0000-4000-8000-000000000011:12:9990',
    '2026-08-02',
    '53000000-0000-4000-8000-000000000101',
    300
  )
);
insert into financial_report_fence_results values (
  'monthly-wrong-subject',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'MONTHLY_CLOSING',
    '53000000-0000-4000-8000-000000000001:2026-08:'
      || '53000000-0000-4000-8000-000000000011:12:9991',
    '2026-08-01',
    '53000000-0000-4000-8000-000000000102',
    300
  )
);
insert into financial_report_fence_results values (
  'monthly-wrong-tenant',
  public.claim_financial_report_message(
    'another-school',
    'MONTHLY_CLOSING',
    '53000000-0000-4000-8000-000000000001:2026-08:'
      || '53000000-0000-4000-8000-000000000011:12:9990',
    '2026-08-01',
    '53000000-0000-4000-8000-000000000103',
    300
  )
);
insert into financial_report_fence_results values (
  'monthly-timeout-claim',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'MONTHLY_CLOSING',
    '53000000-0000-4000-8000-000000000001:2026-08:'
      || '53000000-0000-4000-8000-000000000011:12:9990',
    '2026-08-01',
    '53000000-0000-4000-8000-000000000104',
    300
  )
);
insert into financial_report_fence_results values (
  'monthly-timeout-mark',
  public.mark_financial_report_message_submitting(
    (
      select (payload ->> 'attempt_id')::uuid
        from financial_report_fence_results
       where label = 'monthly-timeout-claim'
    ),
    '53000000-0000-4000-8000-000000000104'
  )
);
insert into financial_report_fence_results values (
  'monthly-timeout-finish',
  public.finish_financial_report_message(
    (
      select (payload ->> 'attempt_id')::uuid
        from financial_report_fence_results
       where label = 'monthly-timeout-claim'
    ),
    '53000000-0000-4000-8000-000000000104',
    'UNKNOWN',
    504,
    'provider_timeout'
  )
);
insert into financial_report_fence_results values (
  'monthly-after-timeout',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'MONTHLY_CLOSING',
    '53000000-0000-4000-8000-000000000001:2026-08:'
      || '53000000-0000-4000-8000-000000000011:12:9990',
    '2026-08-01',
    '53000000-0000-4000-8000-000000000105',
    300
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' = 'REVIEW_REQUIRED'
     from financial_report_fence_results where label = 'monthly-wrong-date')
  and (select payload ->> 'action' = 'REVIEW_REQUIRED'
         from financial_report_fence_results
        where label = 'monthly-wrong-subject')
  and (select payload ->> 'action' = 'REVIEW_REQUIRED'
         from financial_report_fence_results
        where label = 'monthly-wrong-tenant')
  and (select payload ->> 'action' = 'SUBMIT_ONCE'
         from financial_report_fence_results
        where label = 'monthly-timeout-claim')
  and (select payload ->> 'status' = 'SUBMITTING'
         from financial_report_fence_results
        where label = 'monthly-timeout-mark')
  and (select payload ->> 'status' = 'UNKNOWN'
         from financial_report_fence_results
        where label = 'monthly-timeout-finish')
  and (select payload ->> 'action' = 'ALREADY_FINAL'
         and payload ->> 'status' = 'UNKNOWN'
         from financial_report_fence_results
        where label = 'monthly-after-timeout'),
  'monthly closing timeout or exact scope allowed an unsafe retry'
);

insert into financial_report_fence_results values (
  'monthly-stale-claim',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'MONTHLY_CLOSING',
    '53000000-0000-4000-8000-000000000002:2026-08:'
      || '53000000-0000-4000-8000-000000000012:8:6400',
    '2026-08-01',
    '53000000-0000-4000-8000-000000000201',
    300
  )
);
update public.teacher_closings
   set total_amount = 65.00
 where id = '53000000-0000-4000-8000-000000000012';
insert into financial_report_fence_results values (
  'monthly-stale-mark',
  public.mark_financial_report_message_submitting(
    (
      select (payload ->> 'attempt_id')::uuid
        from financial_report_fence_results
       where label = 'monthly-stale-claim'
    ),
    '53000000-0000-4000-8000-000000000201'
  )
);
insert into financial_report_fence_results values (
  'monthly-crash-claim',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'MONTHLY_CLOSING',
    '53000000-0000-4000-8000-000000000002:2026-08:'
      || '53000000-0000-4000-8000-000000000012:8:6500',
    '2026-08-01',
    '53000000-0000-4000-8000-000000000202',
    300
  )
);
insert into financial_report_fence_results values (
  'monthly-crash-mark',
  public.mark_financial_report_message_submitting(
    (
      select (payload ->> 'attempt_id')::uuid
        from financial_report_fence_results
       where label = 'monthly-crash-claim'
    ),
    '53000000-0000-4000-8000-000000000202'
  )
);
insert into financial_report_fence_results values (
  'monthly-after-crash',
  public.claim_financial_report_message(
    'financial-report-fence-school',
    'MONTHLY_CLOSING',
    '53000000-0000-4000-8000-000000000002:2026-08:'
      || '53000000-0000-4000-8000-000000000012:8:6500',
    '2026-08-01',
    '53000000-0000-4000-8000-000000000203',
    300
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' = 'SUBMIT_ONCE'
     from financial_report_fence_results where label = 'monthly-stale-claim')
  and (select payload ->> 'status' = 'SUPPRESSED'
         from financial_report_fence_results where label = 'monthly-stale-mark')
  and
  (select payload ->> 'action' = 'SUBMIT_ONCE'
     from financial_report_fence_results where label = 'monthly-crash-claim')
  and (select payload ->> 'status' = 'SUBMITTING'
         from financial_report_fence_results where label = 'monthly-crash-mark')
  and (select payload ->> 'action' = 'ALREADY_FINAL'
         and payload ->> 'status' = 'SUBMITTING'
         from financial_report_fence_results where label = 'monthly-after-crash')
  and (
    select submit_attempt_count = 1 and status = 'SUBMITTING'
      from public.financial_report_message_attempts
     where tenant_id = 'financial-report-fence-school'
       and notification_kind = 'MONTHLY_CLOSING'
       and subject_id = '53000000-0000-4000-8000-000000000002:2026-08:'
         || '53000000-0000-4000-8000-000000000012:8:6500'
       and ref_date = '2026-08-01'
  ),
  'monthly closing source race or crash allowed an unsafe provider POST'
);

rollback;
