-- Payment split group alerts permit one provider submission and keep an
-- ambiguous outcome terminal, including cash entries without a student_id.

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
    'anon', 'public.asaas_payment_split_message_attempts', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.asaas_payment_split_message_attempts', 'SELECT'
  )
  and has_table_privilege(
    'service_role', 'public.asaas_payment_split_message_attempts', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'public.asaas_payment_split_message_attempts', 'INSERT'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_asaas_payment_split_message(text,uuid,uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.finish_asaas_payment_split_message(uuid,uuid,text,integer,text)',
    'EXECUTE'
  ),
  'retired payment split outbound fence remains executable by workers'
);

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values (
  'payment-split-fence-school',
  'Payment Split Fence School',
  'payment-split-fence-school',
  'active',
  true
);

-- Insert before activating split settings so the notification trigger remains
-- inert; this test exercises the durable state machine directly.
insert into public.student_payments (
  asaas_payment_id,
  tenant_id,
  student_id,
  value,
  status,
  due_date,
  payment_date,
  paid_at,
  credited_at
) values
  (
    'pay_split_fence_unknown',
    'payment-split-fence-school',
    null,
    25.00,
    'RECEIVED',
    current_date,
    current_date,
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    'pay_split_fence_suppressed',
    'payment-split-fence-school',
    null,
    30.00,
    'RECEIVED_IN_CASH',
    current_date,
    current_date,
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    'pay_split_fence_tenant_disabled',
    'payment-split-fence-school',
    null,
    35.00,
    'RECEIVED',
    current_date,
    current_date,
    pg_catalog.now(),
    pg_catalog.now()
  );

insert into public.payment_split_settings (
  tenant_id,
  dizimo_pct,
  investimento_pct,
  escola_pct,
  is_active
) values (
  'payment-split-fence-school',
  10,
  10,
  80,
  true
);

create temporary table split_fence_results (
  label text primary key,
  payload jsonb not null
);

insert into split_fence_results values (
  'first-claim',
  public.claim_asaas_payment_split_message(
    'payment-split-fence-school',
    (
      select id from public.student_payments
       where asaas_payment_id = 'pay_split_fence_unknown'
    ),
    '41000000-0000-4000-8000-000000000001',
    300
  )
);
insert into split_fence_results values (
  'concurrent-claim',
  public.claim_asaas_payment_split_message(
    'payment-split-fence-school',
    (
      select id from public.student_payments
       where asaas_payment_id = 'pay_split_fence_unknown'
    ),
    '41000000-0000-4000-8000-000000000002',
    300
  )
);
insert into split_fence_results values (
  'submitting',
  public.mark_asaas_payment_split_message_submitting(
    (
      select (payload ->> 'attempt_id')::uuid
        from split_fence_results where label = 'first-claim'
    ),
    '41000000-0000-4000-8000-000000000001'
  )
);
insert into split_fence_results values (
  'unknown',
  public.finish_asaas_payment_split_message(
    (
      select (payload ->> 'attempt_id')::uuid
        from split_fence_results where label = 'first-claim'
    ),
    '41000000-0000-4000-8000-000000000001',
    'UNKNOWN',
    504,
    'provider_timeout'
  )
);
insert into split_fence_results values (
  'after-unknown',
  public.claim_asaas_payment_split_message(
    'payment-split-fence-school',
    (
      select id from public.student_payments
       where asaas_payment_id = 'pay_split_fence_unknown'
    ),
    '41000000-0000-4000-8000-000000000003',
    300
  )
);
insert into split_fence_results values (
  'second-submit-rejected',
  public.mark_asaas_payment_split_message_submitting(
    (
      select (payload ->> 'attempt_id')::uuid
        from split_fence_results where label = 'after-unknown'
    ),
    '41000000-0000-4000-8000-000000000003'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' = 'SUBMIT_ONCE'
     from split_fence_results where label = 'first-claim')
  and (select payload ->> 'action' = 'IN_PROGRESS'
         from split_fence_results where label = 'concurrent-claim')
  and (select payload ->> 'status' = 'SUBMITTING'
         from split_fence_results where label = 'submitting')
  and (select payload ->> 'status' = 'UNKNOWN'
         from split_fence_results where label = 'unknown')
  and (select payload ->> 'action' = 'ALREADY_FINAL'
         and payload ->> 'status' = 'UNKNOWN'
         from split_fence_results where label = 'after-unknown')
  and (select payload ->> 'reason' = 'claim_lost'
         from split_fence_results where label = 'second-submit-rejected')
  and (
    select submit_attempt_count = 1 and status = 'UNKNOWN'
      from public.asaas_payment_split_message_attempts
     where tenant_id = 'payment-split-fence-school'
       and payment_id = (
         select id from public.student_payments
          where asaas_payment_id = 'pay_split_fence_unknown'
       )
  ),
  'ambiguous payment split alert was allowed a second provider submit'
);

insert into split_fence_results values (
  'deactivate-claim',
  public.claim_asaas_payment_split_message(
    'payment-split-fence-school',
    (
      select id from public.student_payments
       where asaas_payment_id = 'pay_split_fence_suppressed'
    ),
    '42000000-0000-4000-8000-000000000001',
    300
  )
);
update public.payment_split_settings
   set is_active = false
 where tenant_id = 'payment-split-fence-school';
insert into split_fence_results values (
  'deactivate-mark',
  public.mark_asaas_payment_split_message_submitting(
    (
      select (payload ->> 'attempt_id')::uuid
        from split_fence_results where label = 'deactivate-claim'
    ),
    '42000000-0000-4000-8000-000000000001'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' = 'SUBMIT_ONCE'
     from split_fence_results where label = 'deactivate-claim')
  and (select payload ->> 'status' = 'SUPPRESSED'
         from split_fence_results where label = 'deactivate-mark')
  and (
    select status = 'SUPPRESSED' and submit_attempt_count = 0
      from public.asaas_payment_split_message_attempts
     where tenant_id = 'payment-split-fence-school'
       and payment_id = (
         select id from public.student_payments
          where asaas_payment_id = 'pay_split_fence_suppressed'
       )
  ),
  'split configuration change crossed the final pre-submit gate'
);

update public.payment_split_settings
   set is_active = true
 where tenant_id = 'payment-split-fence-school';
insert into split_fence_results values (
  'tenant-disable-claim',
  public.claim_asaas_payment_split_message(
    'payment-split-fence-school',
    (
      select id from public.student_payments
       where asaas_payment_id = 'pay_split_fence_tenant_disabled'
    ),
    '42500000-0000-4000-8000-000000000001',
    300
  )
);
update public.tenants
   set whatsapp_enabled = false
 where id = 'payment-split-fence-school';
insert into split_fence_results values (
  'tenant-disable-mark',
  public.mark_asaas_payment_split_message_submitting(
    (
      select (payload ->> 'attempt_id')::uuid
        from split_fence_results where label = 'tenant-disable-claim'
    ),
    '42500000-0000-4000-8000-000000000001'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' = 'SUBMIT_ONCE'
     from split_fence_results where label = 'tenant-disable-claim')
  and (select payload ->> 'status' = 'SUPPRESSED'
         from split_fence_results where label = 'tenant-disable-mark')
  and (
    select status = 'SUPPRESSED' and submit_attempt_count = 0
      from public.asaas_payment_split_message_attempts
     where tenant_id = 'payment-split-fence-school'
       and payment_id = (
         select id from public.student_payments
          where asaas_payment_id = 'pay_split_fence_tenant_disabled'
       )
  ),
  'disabled tenant crossed the split final pre-submit gate'
);

select pg_temp.assert_true(
  (
    public.claim_asaas_payment_split_message(
      'another-school',
      (
        select id from public.student_payments
         where asaas_payment_id = 'pay_split_fence_unknown'
      ),
      '43000000-0000-4000-8000-000000000001',
      300
    ) ->> 'action'
  ) = 'REVIEW_REQUIRED',
  'cross-tenant payment split claim did not fail closed'
);

rollback;
