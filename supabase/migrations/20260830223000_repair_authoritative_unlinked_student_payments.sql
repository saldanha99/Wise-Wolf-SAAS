begin;

-- Legacy imports occasionally persisted an Asaas charge before the old sync
-- knew which student owned it.  A name or matching amount is not enough to
-- repair that gap.  This service-only operation requires a fresh provider
-- snapshot plus two independent identity factors (CPF and phone/e-mail), then
-- repairs only an exact, still-unlinked local row.
create or replace function public.repair_authoritative_unlinked_student_payment(
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_authoritative_payment jsonb,
  p_authoritative_subscription jsonb,
  p_authoritative_customer jsonb,
  p_sync_contract_due_day boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text := nullif(pg_catalog.btrim(coalesce(p_expected_tenant_id, '')), '');
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_cpf_hash text;
  v_email_hash text;
  v_phone_hash text;
  v_payment public.student_payments%rowtype;
  v_profile public.profiles%rowtype;
  v_provider_payment_id text;
  v_provider_customer_id text;
  v_customer_id text;
  v_provider_subscription_id text;
  v_provider_status text;
  v_provider_billing_type text;
  v_provider_value numeric;
  v_provider_due_date date;
  v_provider_payment_date date;
  v_provider_estimated_credit_date date;
  v_parent_id text;
  v_parent_customer_id text;
  v_parent_status text;
  v_parent_next_due_date date;
  v_identity_matches integer := 0;
  v_cpf_matches boolean := false;
  v_profile_cpf_hash text;
  v_guardian_cpf_hash text;
  v_profile_email_hash text;
  v_guardian_email_hash text;
  v_profile_phone_hash text;
  v_guardian_phone_hash text;
  v_payment_count integer;
  v_identity_candidate_count integer;
  v_gross_count integer;
  v_gross_amount numeric;
  v_refund_count integer;
  v_financial_status jsonb;
  v_already_bound boolean := false;
begin
  if p_expected_local_payment_id is null
     or p_expected_student_id is null
     or v_tenant_id is null
     or p_authoritative_payment is null
     or pg_catalog.jsonb_typeof(p_authoritative_payment) <> 'object'
     or p_authoritative_customer is null
     or pg_catalog.jsonb_typeof(p_authoritative_customer) <> 'object'
     or v_reason is null
     or pg_catalog.length(v_reason) not between 12 and 500
     or p_sync_contract_due_day is null
  then
    raise exception using
      errcode = '22023',
      message = 'authoritative_unlinked_payment_repair_arguments_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || v_tenant_id || ':' ||
        p_expected_student_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'authoritative-unlinked-payment:' || p_expected_local_payment_id::text,
      0
    )
  );

  v_provider_payment_id := nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'id'),
    ''
  );
  v_provider_customer_id := nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'customer'),
    ''
  );
  v_customer_id := nullif(
    pg_catalog.btrim(p_authoritative_customer ->> 'id'),
    ''
  );
  v_cpf_hash := case
    when nullif(
      pg_catalog.regexp_replace(
        coalesce(p_authoritative_customer ->> 'cpfCnpj', ''),
        '\D', '', 'g'
      ),
      ''
    ) is null then null
    else pg_catalog.encode(
      extensions.digest(
        pg_catalog.regexp_replace(
          p_authoritative_customer ->> 'cpfCnpj', '\D', '', 'g'
        ),
        'sha256'
      ),
      'hex'
    )
  end;
  v_email_hash := case
    when nullif(
      lower(pg_catalog.btrim(coalesce(p_authoritative_customer ->> 'email', ''))),
      ''
    ) is null then null
    else pg_catalog.encode(
      extensions.digest(
        lower(pg_catalog.btrim(p_authoritative_customer ->> 'email')),
        'sha256'
      ),
      'hex'
    )
  end;
  v_phone_hash := case
    when nullif(
      pg_catalog.regexp_replace(
        coalesce(
          nullif(pg_catalog.btrim(p_authoritative_customer ->> 'mobilePhone'), ''),
          nullif(pg_catalog.btrim(p_authoritative_customer ->> 'phone'), ''),
          ''
        ),
        '\D', '', 'g'
      ),
      ''
    ) is null then null
    else pg_catalog.encode(
      extensions.digest(
        pg_catalog.regexp_replace(
          coalesce(
            nullif(pg_catalog.btrim(p_authoritative_customer ->> 'mobilePhone'), ''),
            nullif(pg_catalog.btrim(p_authoritative_customer ->> 'phone'), '')
          ),
          '\D', '', 'g'
        ),
        'sha256'
      ),
      'hex'
    )
  end;
  v_provider_subscription_id := nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'subscription'),
    ''
  );
  v_provider_status := upper(nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'status'),
    ''
  ));
  v_provider_billing_type := upper(nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'billingType'),
    ''
  ));

  begin
    v_provider_value := (p_authoritative_payment ->> 'value')::numeric;
    v_provider_due_date := (p_authoritative_payment ->> 'dueDate')::date;
    v_provider_payment_date := nullif(
      pg_catalog.btrim(p_authoritative_payment ->> 'paymentDate'),
      ''
    )::date;
    v_provider_estimated_credit_date := nullif(
      pg_catalog.btrim(p_authoritative_payment ->> 'estimatedCreditDate'),
      ''
    )::date;
  exception
    when invalid_text_representation or numeric_value_out_of_range
      or datetime_field_overflow then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'authoritative_payment_snapshot_invalid'
      );
  end;

  if v_provider_payment_id is null
     or v_provider_customer_id is null
     or v_customer_id is distinct from v_provider_customer_id
     or v_cpf_hash is null
     or (v_email_hash is null and v_phone_hash is null)
     or v_provider_status not in (
       'PENDING', 'OVERDUE', 'CONFIRMED', 'RECEIVED'
     )
     or v_provider_value is null
     or v_provider_value::text in ('NaN', 'Infinity', '-Infinity')
     or v_provider_value <= 0
     or v_provider_due_date is null
     or coalesce((p_authoritative_payment ->> 'deleted')::boolean, false)
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'authoritative_payment_not_repairable'
    );
  end if;

  if v_provider_status = 'RECEIVED'
     and v_provider_payment_date is null
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'settled_provider_dates_incomplete'
    );
  end if;

  if v_provider_subscription_id is null then
    if p_authoritative_subscription is not null
       and pg_catalog.jsonb_typeof(p_authoritative_subscription) <> 'null'
    then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'unexpected_parent_subscription_snapshot'
      );
    end if;
  else
    if p_authoritative_subscription is null
       or pg_catalog.jsonb_typeof(p_authoritative_subscription) <> 'object'
    then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'parent_subscription_snapshot_missing'
      );
    end if;
    v_parent_id := nullif(
      pg_catalog.btrim(p_authoritative_subscription ->> 'id'),
      ''
    );
    v_parent_customer_id := nullif(
      pg_catalog.btrim(p_authoritative_subscription ->> 'customer'),
      ''
    );
    v_parent_status := upper(nullif(
      pg_catalog.btrim(p_authoritative_subscription ->> 'status'),
      ''
    ));
    begin
      v_parent_next_due_date := nullif(
        pg_catalog.btrim(p_authoritative_subscription ->> 'nextDueDate'),
        ''
      )::date;
    exception
      when invalid_text_representation or datetime_field_overflow then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'reason', 'parent_subscription_snapshot_invalid'
        );
    end;

    if v_parent_id is distinct from v_provider_subscription_id
       or v_parent_customer_id is distinct from v_provider_customer_id
       or v_parent_status <> 'ACTIVE'
       or coalesce((p_authoritative_subscription ->> 'deleted')::boolean, false)
    then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'parent_subscription_identity_mismatch'
      );
    end if;
  end if;

  select pg_catalog.count(*)::integer
    into v_payment_count
    from public.student_payments as candidate
   where nullif(pg_catalog.btrim(coalesce(candidate.asaas_payment_id, '')), '') =
           v_provider_payment_id
      or nullif(pg_catalog.btrim(coalesce(candidate.asaas_id, '')), '') =
           v_provider_payment_id;

  if v_payment_count <> 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'local_provider_payment_not_unique'
    );
  end if;

  select payment.*
    into v_payment
    from public.student_payments as payment
   where payment.id = p_expected_local_payment_id
     and (
       nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') =
         v_provider_payment_id
       or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') =
         v_provider_payment_id
     )
   for update;

  if not found
     or v_payment.tenant_id is distinct from v_tenant_id
     or pg_catalog.round(coalesce(v_payment.value, 0), 2) is distinct from
          pg_catalog.round(v_provider_value, 2)
     or (
       v_payment.amount_cents is not null
       and v_payment.amount_cents is distinct from
             pg_catalog.round(v_provider_value * 100)::integer
     )
     or v_payment.due_date is distinct from v_provider_due_date
     or upper(pg_catalog.btrim(coalesce(v_payment.status, ''))) is distinct from
          v_provider_status
     or (
       v_payment.provider_status is not null
       and upper(pg_catalog.btrim(v_payment.provider_status)) is distinct from
             v_provider_status
     )
     or (
       v_payment.provider_customer_id is not null
       and pg_catalog.btrim(v_payment.provider_customer_id) is distinct from
             v_provider_customer_id
     )
     or (
       v_payment.student_id is not null
       and v_payment.student_id is distinct from p_expected_student_id
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'local_payment_snapshot_mismatch'
    );
  end if;

  select pg_catalog.count(*)::integer, pg_catalog.max(transaction.amount)
    into v_gross_count, v_gross_amount
    from public.financial_transactions as transaction
   where transaction.student_payment_id = p_expected_local_payment_id
     and transaction.tenant_id = v_tenant_id
     and transaction.type = 'ENTRADA';
  select pg_catalog.count(*)::integer
    into v_refund_count
    from public.financial_transactions as transaction
   where transaction.refund_student_payment_id = p_expected_local_payment_id;

  if v_provider_status = 'RECEIVED' then
    if v_payment.payment_date is distinct from v_provider_payment_date
       or coalesce(v_payment.refunded_amount, 0) <> 0
       or v_gross_count <> 1
       or pg_catalog.round(coalesce(v_gross_amount, 0), 2) is distinct from
            pg_catalog.round(v_provider_value, 2)
       or v_refund_count <> 0
    then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'settled_local_payment_ledger_not_corroborated'
      );
    end if;
  elsif v_payment.payment_date is not null
     or v_payment.paid_at is not null
     or v_payment.credited_at is not null
     or coalesce(v_payment.refunded_amount, 0) <> 0
     or coalesce(v_payment.ledger_entry_created, false)
     or v_gross_count <> 0
     or v_refund_count <> 0
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'open_local_payment_has_cash_evidence'
    );
  end if;

  v_already_bound := v_payment.student_id = p_expected_student_id
    and v_payment.provider_customer_id = v_provider_customer_id;

  select profile.*
    into v_profile
    from public.profiles as profile
   where profile.id = p_expected_student_id
     and profile.tenant_id = v_tenant_id
     and profile.role = 'STUDENT'
     and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) =
           'active'
     and coalesce(profile.is_test_account, false) is false
   for update;

  if not found
     or (
       nullif(pg_catalog.btrim(coalesce(v_profile.asaas_customer_id, '')), '')
         is not null
       and pg_catalog.btrim(v_profile.asaas_customer_id) is distinct from
             v_provider_customer_id
     )
     or (
       v_provider_subscription_id is not null
       and nullif(pg_catalog.btrim(coalesce(v_profile.subscription_id, '')), '')
             is not null
       and pg_catalog.btrim(v_profile.subscription_id) is distinct from
             v_provider_subscription_id
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'student_profile_binding_mismatch'
    );
  end if;

  if (
    select pg_catalog.count(*)
      from public.tenant_memberships as membership
     where membership.user_id = p_expected_student_id
  ) <> 1
     or not exists (
       select 1
         from public.tenant_memberships as membership
        where membership.user_id = p_expected_student_id
          and membership.tenant_id = v_tenant_id
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'student_membership_not_corroborated'
    );
  end if;

  if exists (
       select 1
         from public.profiles as other_profile
        where other_profile.id <> p_expected_student_id
          and nullif(
                pg_catalog.btrim(coalesce(other_profile.asaas_customer_id, '')),
                ''
              ) = v_provider_customer_id
     )
     or (
       v_provider_subscription_id is not null
       and exists (
         select 1
           from public.profiles as other_profile
          where other_profile.id <> p_expected_student_id
            and nullif(
                  pg_catalog.btrim(coalesce(other_profile.subscription_id, '')),
                  ''
                ) = v_provider_subscription_id
       )
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'provider_identity_already_claimed'
    );
  end if;

  v_profile_cpf_hash := case
    when nullif(pg_catalog.regexp_replace(coalesce(v_profile.cpf, ''), '\D', '', 'g'), '') is null
      then null
    else pg_catalog.encode(
      extensions.digest(
        pg_catalog.regexp_replace(v_profile.cpf, '\D', '', 'g'),
        'sha256'
      ),
      'hex'
    )
  end;
  v_guardian_cpf_hash := case
    when nullif(pg_catalog.regexp_replace(coalesce(v_profile.guardian_cpf, ''), '\D', '', 'g'), '') is null
      then null
    else pg_catalog.encode(
      extensions.digest(
        pg_catalog.regexp_replace(v_profile.guardian_cpf, '\D', '', 'g'),
        'sha256'
      ),
      'hex'
    )
  end;
  v_profile_email_hash := case
    when nullif(lower(pg_catalog.btrim(coalesce(v_profile.email, ''))), '') is null
      then null
    else pg_catalog.encode(
      extensions.digest(lower(pg_catalog.btrim(v_profile.email)), 'sha256'),
      'hex'
    )
  end;
  v_guardian_email_hash := case
    when nullif(lower(pg_catalog.btrim(coalesce(v_profile.guardian_email, ''))), '') is null
      then null
    else pg_catalog.encode(
      extensions.digest(
        lower(pg_catalog.btrim(v_profile.guardian_email)),
        'sha256'
      ),
      'hex'
    )
  end;
  v_profile_phone_hash := case
    when nullif(pg_catalog.regexp_replace(coalesce(v_profile.phone, ''), '\D', '', 'g'), '') is null
      then null
    else pg_catalog.encode(
      extensions.digest(
        pg_catalog.regexp_replace(v_profile.phone, '\D', '', 'g'),
        'sha256'
      ),
      'hex'
    )
  end;
  v_guardian_phone_hash := case
    when nullif(pg_catalog.regexp_replace(coalesce(v_profile.guardian_phone, ''), '\D', '', 'g'), '') is null
      then null
    else pg_catalog.encode(
      extensions.digest(
        pg_catalog.regexp_replace(v_profile.guardian_phone, '\D', '', 'g'),
        'sha256'
      ),
      'hex'
    )
  end;

  v_cpf_matches :=
    coalesce(v_cpf_hash = v_profile_cpf_hash, false)
    or coalesce(v_cpf_hash = v_guardian_cpf_hash, false);
  if v_cpf_matches then
    v_identity_matches := v_identity_matches + 1;
  end if;
  if v_email_hash is not null and (
       coalesce(v_email_hash = v_profile_email_hash, false)
       or coalesce(v_email_hash = v_guardian_email_hash, false)
     )
  then
    v_identity_matches := v_identity_matches + 1;
  end if;
  if v_phone_hash is not null and (
       coalesce(v_phone_hash = v_profile_phone_hash, false)
       or coalesce(v_phone_hash = v_guardian_phone_hash, false)
     )
  then
    v_identity_matches := v_identity_matches + 1;
  end if;

  if v_cpf_matches is not true or v_identity_matches < 2 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'provider_customer_identity_not_corroborated',
      'matched_factors', v_identity_matches
    );
  end if;

  -- A guardian can legitimately be shared by siblings. In that case the
  -- identity tuple is ambiguous and this repair must stop instead of letting
  -- the caller choose a student id. Require CPF + contact to identify exactly
  -- one active student in the tenant.
  select pg_catalog.count(*)::integer
    into v_identity_candidate_count
    from public.profiles as candidate
    cross join lateral (
      select
        case when nullif(pg_catalog.regexp_replace(coalesce(candidate.cpf, ''), '\D', '', 'g'), '') is null
          then null else pg_catalog.encode(extensions.digest(pg_catalog.regexp_replace(candidate.cpf, '\D', '', 'g'), 'sha256'), 'hex') end as cpf_hash,
        case when nullif(pg_catalog.regexp_replace(coalesce(candidate.guardian_cpf, ''), '\D', '', 'g'), '') is null
          then null else pg_catalog.encode(extensions.digest(pg_catalog.regexp_replace(candidate.guardian_cpf, '\D', '', 'g'), 'sha256'), 'hex') end as guardian_cpf_hash,
        case when nullif(lower(pg_catalog.btrim(coalesce(candidate.email, ''))), '') is null
          then null else pg_catalog.encode(extensions.digest(lower(pg_catalog.btrim(candidate.email)), 'sha256'), 'hex') end as email_hash,
        case when nullif(lower(pg_catalog.btrim(coalesce(candidate.guardian_email, ''))), '') is null
          then null else pg_catalog.encode(extensions.digest(lower(pg_catalog.btrim(candidate.guardian_email)), 'sha256'), 'hex') end as guardian_email_hash,
        case when nullif(pg_catalog.regexp_replace(coalesce(candidate.phone, ''), '\D', '', 'g'), '') is null
          then null else pg_catalog.encode(extensions.digest(pg_catalog.regexp_replace(candidate.phone, '\D', '', 'g'), 'sha256'), 'hex') end as phone_hash,
        case when nullif(pg_catalog.regexp_replace(coalesce(candidate.guardian_phone, ''), '\D', '', 'g'), '') is null
          then null else pg_catalog.encode(extensions.digest(pg_catalog.regexp_replace(candidate.guardian_phone, '\D', '', 'g'), 'sha256'), 'hex') end as guardian_phone_hash
    ) as identity
   where candidate.tenant_id = v_tenant_id
     and candidate.role = 'STUDENT'
     and lower(pg_catalog.btrim(coalesce(candidate.lifecycle_status, ''))) = 'active'
     and coalesce(candidate.is_test_account, false) is false
     and (
       coalesce(v_cpf_hash = identity.cpf_hash, false)
       or coalesce(v_cpf_hash = identity.guardian_cpf_hash, false)
     )
     and (
       (
         v_email_hash is not null
         and (
           coalesce(v_email_hash = identity.email_hash, false)
           or coalesce(v_email_hash = identity.guardian_email_hash, false)
         )
       )
       or (
         v_phone_hash is not null
         and (
           coalesce(v_phone_hash = identity.phone_hash, false)
           or coalesce(v_phone_hash = identity.guardian_phone_hash, false)
         )
       )
     );
  if v_identity_candidate_count <> 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'provider_customer_identity_not_unique',
      'candidate_count', v_identity_candidate_count
    );
  end if;

  perform pg_catalog.set_config('app.enrollment_claim', '1', true);
  update public.profiles as profile
     set asaas_customer_id = coalesce(
           nullif(pg_catalog.btrim(coalesce(profile.asaas_customer_id, '')), ''),
           v_provider_customer_id
         ),
         subscription_id = case
           when v_provider_subscription_id is null then profile.subscription_id
           else coalesce(
             nullif(pg_catalog.btrim(coalesce(profile.subscription_id, '')), ''),
             v_provider_subscription_id
           )
         end,
         asaas_subscription_status = case
           when v_provider_subscription_id is null
             then profile.asaas_subscription_status
           else v_parent_status
         end,
         asaas_subscription_synced_at = case
           when v_provider_subscription_id is null
             then profile.asaas_subscription_synced_at
           else pg_catalog.now()
         end,
         due_day = case
           when not p_sync_contract_due_day
             or v_parent_next_due_date is null then profile.due_day
           else extract(day from v_parent_next_due_date)::integer
         end
   where profile.id = p_expected_student_id
     and profile.tenant_id = v_tenant_id;
  perform pg_catalog.set_config('app.enrollment_claim', '', true);

  update public.student_payments as payment
     set student_id = p_expected_student_id,
         provider_customer_id = v_provider_customer_id,
         provider_status = v_provider_status,
         billing_type = coalesce(v_provider_billing_type, payment.billing_type),
         payment_date = case
           when v_provider_status = 'RECEIVED' then v_provider_payment_date
           else payment.payment_date
         end,
         estimated_credit_at = case
           when v_provider_estimated_credit_date is null
             then payment.estimated_credit_at
           else (
             v_provider_estimated_credit_date::timestamp + interval '12 hours'
           ) at time zone 'UTC'
         end,
         updated_at = pg_catalog.now()
   where payment.id = p_expected_local_payment_id
     and payment.tenant_id = v_tenant_id
     and (
       payment.student_id is null
       or payment.student_id = p_expected_student_id
     )
     and (
       payment.provider_customer_id is null
       or payment.provider_customer_id = v_provider_customer_id
     );

  if not found then
    raise exception using
      errcode = '40001',
      message = 'authoritative_unlinked_payment_changed_concurrently';
  end if;

  select public.recompute_student_financial_status(
    v_tenant_id,
    p_expected_student_id
  ) into v_financial_status;
  if coalesce((v_financial_status ->> 'ok')::boolean, false) is false then
    raise exception using
      errcode = '55000',
      message = 'student_financial_status_recompute_failed';
  end if;

  update public.asaas_reconciliation_issues as issue
     set resolved_at = coalesce(issue.resolved_at, pg_catalog.now()),
         resolution_note = coalesce(
           issue.resolution_note,
           'Resolved by authoritative provider/customer identity repair: ' ||
             v_reason
         )
   where issue.provider_entity_id = v_provider_payment_id
     and issue.local_entity_id = p_expected_local_payment_id::text
     and issue.resolved_at is null
     and issue.kind = 'PAYMENT_TENANT_OR_STUDENT_UNRESOLVED';

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', case when v_already_bound then 'ALREADY_BOUND' else 'BOUND' end,
    'payment_id', p_expected_local_payment_id,
    'student_id', p_expected_student_id,
    'tenant_id', v_tenant_id,
    'provider_payment_id', v_provider_payment_id,
    'identity_factors', v_identity_matches,
    'contract_due_day_synced',
      p_sync_contract_due_day and v_parent_next_due_date is not null,
    'financial_status', v_financial_status ->> 'status_financial'
  );
end;
$function$;

alter function public.repair_authoritative_unlinked_student_payment(
  uuid,uuid,text,jsonb,jsonb,jsonb,boolean,text
) owner to postgres;
revoke all on function public.repair_authoritative_unlinked_student_payment(
  uuid,uuid,text,jsonb,jsonb,jsonb,boolean,text
) from public, anon, authenticated;
grant execute on function public.repair_authoritative_unlinked_student_payment(
  uuid,uuid,text,jsonb,jsonb,jsonb,boolean,text
) to service_role;

comment on function public.repair_authoritative_unlinked_student_payment(
  uuid,uuid,text,jsonb,jsonb,jsonb,boolean,text
) is
  'Service-only, idempotent repair for an exact legacy unlinked Asaas payment. Requires fresh payment, customer and parent snapshots plus unique matching CPF/contact identity; never guesses by name or amount.';

-- Old settlements predate the durable webhook inbox.  Their gross cash entry
-- already exists, but credited_at was never persisted.  A fresh payment GET
-- and the matching Asaas statement row are independent proofs of the cash
-- date; changing status or synthesizing a webhook is deliberately forbidden.
create or replace function public.repair_authoritative_legacy_payment_credit(
  p_expected_local_payment_id uuid,
  p_expected_tenant_id text,
  p_authoritative_payment jsonb,
  p_authoritative_statement jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text := nullif(pg_catalog.btrim(coalesce(p_expected_tenant_id, '')), '');
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_payment public.student_payments%rowtype;
  v_provider_payment_id text;
  v_provider_customer_id text;
  v_provider_status text;
  v_provider_value numeric;
  v_provider_due_date date;
  v_provider_payment_date date;
  v_provider_credit_date date;
  v_statement_id text;
  v_statement_type text;
  v_statement_payment_id text;
  v_statement_value numeric;
  v_statement_date date;
  v_payment_count integer;
  v_gross_count integer;
  v_gross_amount numeric;
  v_refund_count integer;
  v_action text := 'CREDIT_DATE_REPAIRED';
begin
  if p_expected_local_payment_id is null
     or v_tenant_id is null
     or p_authoritative_payment is null
     or pg_catalog.jsonb_typeof(p_authoritative_payment) <> 'object'
     or p_authoritative_statement is null
     or pg_catalog.jsonb_typeof(p_authoritative_statement) <> 'object'
     or v_reason is null
     or pg_catalog.length(v_reason) not between 12 and 500
  then
    raise exception using
      errcode = '22023',
      message = 'authoritative_credit_repair_arguments_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'authoritative-legacy-credit:' || p_expected_local_payment_id::text,
      0
    )
  );

  v_provider_payment_id := nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'id'),
    ''
  );
  v_provider_customer_id := nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'customer'),
    ''
  );
  v_provider_status := upper(nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'status'),
    ''
  ));
  v_statement_id := nullif(
    pg_catalog.btrim(p_authoritative_statement ->> 'id'),
    ''
  );
  v_statement_type := upper(nullif(
    pg_catalog.btrim(p_authoritative_statement ->> 'type'),
    ''
  ));
  v_statement_payment_id := coalesce(
    nullif(pg_catalog.btrim(p_authoritative_statement ->> 'paymentId'), ''),
    nullif(pg_catalog.btrim(p_authoritative_statement #>> '{payment,id}'), ''),
    case
      when pg_catalog.jsonb_typeof(p_authoritative_statement -> 'payment') =
             'string'
        then nullif(
          pg_catalog.btrim(p_authoritative_statement ->> 'payment'),
          ''
        )
      else null
    end
  );

  begin
    v_provider_value := (p_authoritative_payment ->> 'value')::numeric;
    v_provider_due_date := (p_authoritative_payment ->> 'dueDate')::date;
    v_provider_payment_date := (p_authoritative_payment ->> 'paymentDate')::date;
    v_provider_credit_date := (p_authoritative_payment ->> 'creditDate')::date;
    v_statement_value := (p_authoritative_statement ->> 'value')::numeric;
    v_statement_date := (p_authoritative_statement ->> 'date')::date;
  exception
    when invalid_text_representation or numeric_value_out_of_range
      or datetime_field_overflow then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'authoritative_credit_snapshot_invalid'
      );
  end;

  if v_provider_payment_id is null
     or v_provider_customer_id is null
     or v_provider_status <> 'RECEIVED'
     or lower(coalesce(p_authoritative_payment ->> 'deleted', 'false')) = 'true'
     or v_provider_value is null
     or v_provider_value::text in ('NaN', 'Infinity', '-Infinity')
     or v_provider_value <= 0
     or v_provider_due_date is null
     or v_provider_payment_date is null
     or v_provider_credit_date is null
     or v_statement_id is null
     or v_statement_type <> 'PAYMENT_RECEIVED'
     or v_statement_payment_id is distinct from v_provider_payment_id
     or v_statement_date is distinct from v_provider_credit_date
     or pg_catalog.round(coalesce(v_statement_value, 0), 2) is distinct from
          pg_catalog.round(v_provider_value, 2)
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'authoritative_credit_evidence_mismatch'
    );
  end if;

  select pg_catalog.count(*)::integer
    into v_payment_count
    from public.student_payments as candidate
   where nullif(pg_catalog.btrim(coalesce(candidate.asaas_payment_id, '')), '') =
           v_provider_payment_id
      or nullif(pg_catalog.btrim(coalesce(candidate.asaas_id, '')), '') =
           v_provider_payment_id;

  if v_payment_count <> 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'local_provider_payment_not_unique'
    );
  end if;

  select payment.*
    into v_payment
    from public.student_payments as payment
   where payment.id = p_expected_local_payment_id
     and payment.tenant_id = v_tenant_id
     and (
       nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') =
         v_provider_payment_id
       or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') =
         v_provider_payment_id
     )
   for update;

  if not found
     or upper(pg_catalog.btrim(coalesce(v_payment.status, ''))) <> 'RECEIVED'
     or (
       v_payment.provider_status is not null
       and upper(pg_catalog.btrim(v_payment.provider_status)) <> 'RECEIVED'
     )
     or (
       v_payment.provider_customer_id is not null
       and pg_catalog.btrim(v_payment.provider_customer_id) is distinct from
             v_provider_customer_id
     )
     or pg_catalog.round(coalesce(v_payment.value, 0), 2) is distinct from
          pg_catalog.round(v_provider_value, 2)
     or (
       v_payment.amount_cents is not null
       and v_payment.amount_cents is distinct from
             pg_catalog.round(v_provider_value * 100)::integer
     )
     or v_payment.due_date is distinct from v_provider_due_date
     or v_payment.payment_date is distinct from v_provider_payment_date
     or coalesce(v_payment.refunded_amount, 0) <> 0
     or (
       v_payment.credited_at is not null
       and v_payment.credited_at::date is distinct from v_provider_credit_date
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'local_credit_snapshot_mismatch'
    );
  end if;

  select pg_catalog.count(*)::integer, pg_catalog.max(transaction.amount)
    into v_gross_count, v_gross_amount
    from public.financial_transactions as transaction
   where transaction.student_payment_id = p_expected_local_payment_id
     and transaction.tenant_id = v_tenant_id
     and transaction.type = 'ENTRADA';
  select pg_catalog.count(*)::integer
    into v_refund_count
    from public.financial_transactions as transaction
   where transaction.refund_student_payment_id = p_expected_local_payment_id;

  if v_gross_count <> 1
     or pg_catalog.round(coalesce(v_gross_amount, 0), 2) is distinct from
          pg_catalog.round(v_provider_value, 2)
     or v_refund_count <> 0
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'local_credit_ledger_not_corroborated'
    );
  end if;

  if v_payment.credited_at is null then
    update public.student_payments as payment
       set credited_at = (
             v_provider_credit_date::timestamp + interval '12 hours'
           ) at time zone 'UTC',
           updated_at = pg_catalog.now()
     where payment.id = p_expected_local_payment_id
       and payment.credited_at is null;
    if not found then
      raise exception using
        errcode = '40001',
        message = 'authoritative_credit_changed_concurrently';
    end if;
  else
    v_action := 'ALREADY_REPAIRED';
  end if;

  update public.asaas_reconciliation_issues as issue
     set resolved_at = coalesce(issue.resolved_at, pg_catalog.now()),
         resolution_note = coalesce(
           issue.resolution_note,
           'Resolved by payment GET plus unique Asaas statement evidence: ' ||
             v_reason
         )
   where issue.provider_entity_id = v_provider_payment_id
     and issue.local_entity_id = p_expected_local_payment_id::text
     and issue.resolved_at is null
     and issue.kind in (
       'LOCAL_CREDIT_DATE_MISSING',
       'CREDIT_DATE_MISMATCH',
       'STATEMENT_CREDIT_DATE_MISMATCH',
       'LEDGER_GROSS_DATE_MISMATCH'
     );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', v_action,
    'payment_id', p_expected_local_payment_id,
    'provider_payment_id', v_provider_payment_id,
    'credit_date', v_provider_credit_date
  );
end;
$function$;

alter function public.repair_authoritative_legacy_payment_credit(
  uuid,text,jsonb,jsonb,text
) owner to postgres;
revoke all on function public.repair_authoritative_legacy_payment_credit(
  uuid,text,jsonb,jsonb,text
) from public, anon, authenticated;
grant execute on function public.repair_authoritative_legacy_payment_credit(
  uuid,text,jsonb,jsonb,text
) to service_role;

-- Deletion is orthogonal to status in Asaas: a deleted charge may still say
-- PENDING or OVERDUE.  This recovery path converges an exact legacy open row
-- to CANCELLED/DELETED only when a fresh provider snapshot says deleted=true
-- and there is provably no cash, credit, refund or ledger entry.
create or replace function public.repair_authoritative_deleted_legacy_payment(
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_authoritative_payment jsonb,
  p_authoritative_subscription jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text := nullif(pg_catalog.btrim(coalesce(p_expected_tenant_id, '')), '');
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_payment public.student_payments%rowtype;
  v_profile public.profiles%rowtype;
  v_provider_payment_id text;
  v_provider_customer_id text;
  v_provider_subscription_id text;
  v_provider_status text;
  v_provider_value numeric;
  v_provider_refunded_value numeric;
  v_provider_due_date date;
  v_parent_id text;
  v_parent_customer_id text;
  v_parent_status text;
  v_payment_count integer;
  v_financial_status jsonb;
  v_action text := 'CANCELLED';
begin
  if p_expected_local_payment_id is null
     or v_tenant_id is null
     or p_authoritative_payment is null
     or pg_catalog.jsonb_typeof(p_authoritative_payment) <> 'object'
     or v_reason is null
     or pg_catalog.length(v_reason) not between 12 and 500
  then
    raise exception using
      errcode = '22023',
      message = 'authoritative_deleted_payment_repair_arguments_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'authoritative-deleted-payment:' || p_expected_local_payment_id::text,
      0
    )
  );
  if p_expected_student_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-lifecycle:' || v_tenant_id || ':' ||
          p_expected_student_id::text,
        0
      )
    );
  end if;

  v_provider_payment_id := nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'id'),
    ''
  );
  v_provider_customer_id := nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'customer'),
    ''
  );
  v_provider_subscription_id := nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'subscription'),
    ''
  );
  v_provider_status := upper(nullif(
    pg_catalog.btrim(p_authoritative_payment ->> 'status'),
    ''
  ));
  begin
    v_provider_value := (p_authoritative_payment ->> 'value')::numeric;
    v_provider_refunded_value := coalesce(
      nullif(pg_catalog.btrim(p_authoritative_payment ->> 'refundedValue'), ''),
      '0'
    )::numeric;
    v_provider_due_date := (p_authoritative_payment ->> 'dueDate')::date;
  exception
    when invalid_text_representation or numeric_value_out_of_range
      or datetime_field_overflow then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'authoritative_deleted_payment_snapshot_invalid'
      );
  end;

  if v_provider_payment_id is null
     or v_provider_customer_id is null
     or v_provider_subscription_id is null
     or v_provider_status not in ('PENDING', 'OVERDUE')
     or lower(coalesce(p_authoritative_payment ->> 'deleted', 'false')) <> 'true'
     or v_provider_value is null
     or v_provider_value::text in ('NaN', 'Infinity', '-Infinity')
     or v_provider_value <= 0
     or v_provider_refunded_value::text in ('NaN', 'Infinity', '-Infinity')
     or v_provider_refunded_value <> 0
     or v_provider_due_date is null
     or nullif(pg_catalog.btrim(p_authoritative_payment ->> 'paymentDate'), '') is not null
     or nullif(pg_catalog.btrim(p_authoritative_payment ->> 'creditDate'), '') is not null
     or nullif(pg_catalog.btrim(p_authoritative_payment ->> 'confirmedDate'), '') is not null
     or nullif(pg_catalog.btrim(p_authoritative_payment ->> 'clientPaymentDate'), '') is not null
     or (
       p_authoritative_payment ? 'refunds'
       and coalesce(p_authoritative_payment -> 'refunds', 'null'::jsonb)
             not in ('null'::jsonb, '[]'::jsonb)
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'authoritative_deleted_payment_not_repairable'
    );
  end if;

  if p_authoritative_subscription is null
     or pg_catalog.jsonb_typeof(p_authoritative_subscription) <> 'object'
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'authoritative_deleted_parent_snapshot_missing'
    );
  end if;
  v_parent_id := nullif(
    pg_catalog.btrim(p_authoritative_subscription ->> 'id'),
    ''
  );
  v_parent_customer_id := nullif(
    pg_catalog.btrim(p_authoritative_subscription ->> 'customer'),
    ''
  );
  v_parent_status := upper(nullif(
    pg_catalog.btrim(p_authoritative_subscription ->> 'status'),
    ''
  ));
  if v_parent_id is distinct from v_provider_subscription_id
     or v_parent_customer_id is distinct from v_provider_customer_id
     or v_parent_status is null
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'authoritative_deleted_parent_identity_mismatch'
    );
  end if;

  select pg_catalog.count(*)::integer
    into v_payment_count
    from public.student_payments as candidate
   where nullif(pg_catalog.btrim(coalesce(candidate.asaas_payment_id, '')), '') =
           v_provider_payment_id
      or nullif(pg_catalog.btrim(coalesce(candidate.asaas_id, '')), '') =
           v_provider_payment_id;
  if v_payment_count <> 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'local_provider_payment_not_unique'
    );
  end if;

  select payment.*
    into v_payment
    from public.student_payments as payment
   where payment.id = p_expected_local_payment_id
     and payment.tenant_id = v_tenant_id
     and (
       nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') =
         v_provider_payment_id
       or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') =
         v_provider_payment_id
     )
   for update;

  if not found
     or v_payment.student_id is distinct from p_expected_student_id
     or pg_catalog.round(coalesce(v_payment.value, 0), 2) is distinct from
          pg_catalog.round(v_provider_value, 2)
     or (
       v_payment.amount_cents is not null
       and v_payment.amount_cents is distinct from
             pg_catalog.round(v_provider_value * 100)::integer
     )
     or v_payment.due_date is distinct from v_provider_due_date
     or (
       upper(pg_catalog.btrim(coalesce(v_payment.status, ''))) not in (
         v_provider_status, 'CANCELLED'
       )
     )
     or (
       upper(pg_catalog.btrim(coalesce(v_payment.provider_status, ''))) not in (
         '', v_provider_status, 'DELETED'
       )
     )
     or v_payment.payment_date is not null
     or v_payment.paid_at is not null
     or v_payment.credited_at is not null
     or coalesce(v_payment.refunded_amount, 0) <> 0
     or coalesce(v_payment.ledger_entry_created, false)
     or exists (
       select 1
         from public.financial_transactions as transaction
        where transaction.student_payment_id = p_expected_local_payment_id
           or transaction.refund_student_payment_id = p_expected_local_payment_id
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'local_deleted_payment_snapshot_mismatch'
    );
  end if;

  if upper(pg_catalog.btrim(coalesce(v_payment.status, ''))) = 'CANCELLED'
     and upper(pg_catalog.btrim(coalesce(v_payment.provider_status, ''))) =
           'DELETED'
  then
    v_action := 'ALREADY_CANCELLED';
  end if;

  if p_expected_student_id is not null then
    select profile.*
      into v_profile
      from public.profiles as profile
     where profile.id = p_expected_student_id
       and profile.tenant_id = v_tenant_id
       and profile.role = 'STUDENT'
       and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) in (
         'active', 'suspended', 'offboarded'
       )
       and coalesce(profile.is_test_account, false) is false
       and nullif(
             pg_catalog.btrim(coalesce(profile.asaas_customer_id, '')),
             ''
           ) = v_provider_customer_id
     for update;
    if not found
       or exists (
         select 1
           from public.profiles as other_profile
          where other_profile.id <> p_expected_student_id
            and nullif(
                  pg_catalog.btrim(coalesce(other_profile.asaas_customer_id, '')),
                  ''
                ) = v_provider_customer_id
       )
    then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'deleted_payment_student_binding_not_corroborated'
      );
    end if;

  end if;

  update public.student_payments as payment
     set status = 'CANCELLED',
         provider_status = 'DELETED',
         exclusion_reason = coalesce(
           nullif(pg_catalog.btrim(coalesce(payment.exclusion_reason, '')), ''),
           'provider_deleted_legacy_reconciled'
         ),
         updated_at = pg_catalog.now()
   where payment.id = p_expected_local_payment_id
     and upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
           v_provider_status, 'CANCELLED'
         )
     and payment.payment_date is null
     and payment.paid_at is null
     and payment.credited_at is null;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'authoritative_deleted_payment_changed_concurrently';
  end if;

  if p_expected_student_id is not null then
    select public.recompute_student_financial_status(
      v_tenant_id,
      p_expected_student_id
    ) into v_financial_status;
    if coalesce((v_financial_status ->> 'ok')::boolean, false) is false then
      raise exception using
        errcode = '55000',
        message = 'student_financial_status_recompute_failed';
    end if;
  end if;

  update public.asaas_reconciliation_issues as issue
     set resolved_at = coalesce(issue.resolved_at, pg_catalog.now()),
         resolution_note = coalesce(
           issue.resolution_note,
           'Resolved by fresh Asaas deleted=true snapshot with no cash: ' ||
             v_reason
         )
   where issue.provider_entity_id = v_provider_payment_id
     and issue.local_entity_id = p_expected_local_payment_id::text
     and issue.resolved_at is null
     and issue.kind in (
       'PROVIDER_PAYMENT_DELETED_LOCAL_OPEN',
       'PAYMENT_STATUS_MISMATCH'
     );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', v_action,
    'payment_id', p_expected_local_payment_id,
    'student_id', p_expected_student_id,
    'provider_payment_id', v_provider_payment_id,
    'profile_subscription_adopted', false,
    'financial_status', v_financial_status ->> 'status_financial'
  );
end;
$function$;

alter function public.repair_authoritative_deleted_legacy_payment(
  uuid,uuid,text,jsonb,jsonb,text
) owner to postgres;
revoke all on function public.repair_authoritative_deleted_legacy_payment(
  uuid,uuid,text,jsonb,jsonb,text
) from public, anon, authenticated;
grant execute on function public.repair_authoritative_deleted_legacy_payment(
  uuid,uuid,text,jsonb,jsonb,text
) to service_role;

notify pgrst, 'reload schema';

commit;
