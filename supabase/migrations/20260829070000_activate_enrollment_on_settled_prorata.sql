begin;

-- Pro-rata e uma obrigacao financeira propria. Nao e mensalidade, nao antecipa
-- nextDueDate e nao reutiliza o ID da primeira parcela da assinatura.
create or replace function public.resolve_enrollment_payment_observation_binding(
  p_tenant_id text,
  p_student_id uuid,
  p_provider_payment_id text,
  p_external_reference text,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  normalized_payment_id text := nullif(
    trim(coalesce(p_provider_payment_id, '')),
    ''
  );
  normalized_reference text := nullif(
    lower(trim(coalesce(p_external_reference, ''))),
    ''
  );
  normalized_outcome text := upper(trim(coalesce(p_outcome, '')));
  profile_row public.profiles%rowtype;
  offer_row public.offers%rowtype;
  reference_parts text[];
  resolved_kind text;
  resolved_purpose text;
  candidate record;
  candidate_count integer := 0;
  candidate_offer_id uuid;
  candidate_kind text;
  candidate_reference text;
  profile_payment_id text;
  offer_payment_id text;
  fee_fallback_payment_count integer := 0;
begin
  if normalized_tenant is null
     or p_student_id is null
     or normalized_payment_id is null
     or length(normalized_payment_id) > 240
     or normalized_outcome not in ('SETTLED', 'PENDING', 'UNSETTLED')
     or length(coalesce(normalized_reference, '')) > 500
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_enrollment_payment_binding_resolution';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' ||
        p_student_id::text,
      0
    )
  );

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_student_id
     and profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
   for share;
  if not found then
    return jsonb_build_object('ok', true, 'action', 'NONE');
  end if;
  profile_payment_id := nullif(trim(coalesce(
    profile_row.enrollment_payment_id,
    ''
  )), '');

  if normalized_reference = p_student_id::text then
    if profile_payment_id = normalized_payment_id then
      return jsonb_build_object(
        'ok', true,
        'action', 'BOUND',
        'offer_id', null,
        'payment_kind', 'ENROLLMENT_FEE',
        'external_reference', p_student_id::text
      );
    end if;
    return jsonb_build_object('ok', true, 'action', 'NONE');
  end if;

  if normalized_reference is not null then
    reference_parts := pg_catalog.regexp_match(
      normalized_reference,
      '^enrollment:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(fee|one-time|pro-rata|subscription)$'
    );
    if reference_parts is null then
      return jsonb_build_object('ok', true, 'action', 'NONE');
    end if;
    resolved_purpose := reference_parts[2];
    resolved_kind := case resolved_purpose
      when 'fee' then 'ENROLLMENT_FEE'
      when 'one-time' then 'ONE_TIME'
      when 'pro-rata' then 'PRO_RATA'
      else 'SUBSCRIPTION_ACTIVATION'
    end;

    select offer.* into offer_row
      from public.offers as offer
     where offer.id = reference_parts[1]::uuid
       and offer.tenant_id = normalized_tenant
       and offer.kind = 'ENROLLMENT'
       and (
         offer.processing_by = p_student_id
         or offer.consumed_by = p_student_id
       )
     for share;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'offer_not_owned');
    end if;

    offer_payment_id := case resolved_kind
      when 'ENROLLMENT_FEE' then nullif(trim(coalesce(
        offer_row.metadata ->> 'enrollment_payment_id',
        ''
      )), '')
      when 'ONE_TIME' then nullif(trim(coalesce(
        offer_row.metadata ->> 'one_time_payment_id',
        ''
      )), '')
      when 'PRO_RATA' then nullif(trim(coalesce(
        offer_row.metadata ->> 'pro_rata_charge_id',
        ''
      )), '')
      else coalesce(
        nullif(trim(coalesce(
          offer_row.metadata ->> 'subscription_activation_payment_id',
          ''
        )), ''),
        nullif(trim(coalesce(
          offer_row.metadata ->> 'activation_payment_id',
          ''
        )), '')
      )
    end;

    if resolved_kind = 'ENROLLMENT_FEE' then
      if offer_payment_id is not null
         and offer_payment_id <> normalized_payment_id
      then
        return jsonb_build_object(
          'ok', false,
          'reason', 'enrollment_payment_binding_mismatch'
        );
      elsif offer_payment_id is null then
        if profile_payment_id is distinct from normalized_payment_id then
          return jsonb_build_object(
            'ok', false,
            'reason', 'enrollment_payment_binding_mismatch'
          );
        end if;
        select count(*) into fee_fallback_payment_count
          from public.student_payments as payment
         where payment.tenant_id = normalized_tenant
           and payment.student_id = p_student_id
           and (
             nullif(trim(coalesce(payment.asaas_payment_id, '')), '') =
               normalized_payment_id
             or nullif(trim(coalesce(payment.asaas_id, '')), '') =
               normalized_payment_id
           )
           and lower(trim(coalesce(
             payment.raw_payload #>> '{payment,externalReference}',
             ''
           ))) = normalized_reference
           and not exists (
             select 1
               from public.offers as competing_offer
              where competing_offer.id <> offer_row.id
                and competing_offer.tenant_id = normalized_tenant
                and competing_offer.kind = 'ENROLLMENT'
                and (
                  competing_offer.processing_by = p_student_id
                  or competing_offer.consumed_by = p_student_id
                )
                and nullif(trim(coalesce(
                  competing_offer.metadata ->> 'enrollment_payment_id',
                  ''
                )), '') = normalized_payment_id
           );
        if fee_fallback_payment_count <> 1 then
          return jsonb_build_object(
            'ok', false,
            'reason', 'enrollment_payment_binding_mismatch'
          );
        end if;
      end if;
    elsif resolved_kind in ('ONE_TIME', 'PRO_RATA') then
      if resolved_kind = 'PRO_RATA' and (
        coalesce(
          nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
          0
        ) <= 0
        or offer_row.payload ->> 'proRataFormulaVersion'
             is distinct from 'weekly-frequency-times-4-v1'
      ) then
        return jsonb_build_object(
          'ok', false,
          'reason', 'pro_rata_scope_invalid'
        );
      end if;
      if offer_payment_id is not null
         and offer_payment_id <> normalized_payment_id
      then
        return jsonb_build_object(
          'ok', false,
          'reason', case resolved_kind
            when 'ONE_TIME' then 'one_time_payment_binding_mismatch'
            else 'pro_rata_payment_binding_mismatch'
          end
        );
      elsif offer_payment_id is null and normalized_outcome <> 'SETTLED' then
        return jsonb_build_object(
          'ok', false,
          'reason', case resolved_kind
            when 'ONE_TIME' then 'one_time_payment_binding_mismatch'
            else 'pro_rata_payment_binding_pending'
          end
        );
      end if;
    else
      -- Taxa e pro-rata sao as provas de ativacao quando aplicaveis. Depois da
      -- primeira ativacao, parcelas mensais seguintes sao financeiro normal:
      -- nunca devem reabrir a oferta nem virar divergencia de matricula.
      if greatest(coalesce(offer_row.enrollment_fee, 0), 0) > 0
         or coalesce(
              nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
              0
            ) > 0
      then
        return jsonb_build_object('ok', true, 'action', 'NONE');
      elsif offer_payment_id is not null
            and offer_payment_id <> normalized_payment_id
      then
        return jsonb_build_object('ok', true, 'action', 'NONE');
      elsif offer_payment_id is null and normalized_outcome <> 'SETTLED' then
        return jsonb_build_object('ok', true, 'action', 'NONE');
      end if;
    end if;

    return jsonb_build_object(
      'ok', true,
      'action', 'BOUND',
      'offer_id', offer_row.id,
      'payment_kind', resolved_kind,
      'external_reference', 'enrollment:' || offer_row.id::text || ':' ||
        resolved_purpose
    );
  end if;

  for candidate in
    select distinct binding.offer_id, binding.payment_kind,
           binding.external_reference
      from (
        select offer.id as offer_id,
               match.payment_kind,
               'enrollment:' || offer.id::text || ':' || match.purpose
                 as external_reference
          from public.offers as offer
          cross join lateral (
            values
              (
                'ENROLLMENT_FEE'::text,
                'fee'::text,
                nullif(trim(coalesce(
                  offer.metadata ->> 'enrollment_payment_id',
                  ''
                )), '')
              ),
              (
                'ONE_TIME'::text,
                'one-time'::text,
                nullif(trim(coalesce(
                  offer.metadata ->> 'one_time_payment_id',
                  ''
                )), '')
              ),
              (
                'PRO_RATA'::text,
                'pro-rata'::text,
                nullif(trim(coalesce(
                  offer.metadata ->> 'pro_rata_charge_id',
                  ''
                )), '')
              ),
              (
                'SUBSCRIPTION_ACTIVATION'::text,
                'subscription'::text,
                nullif(trim(coalesce(
                  offer.metadata ->> 'subscription_activation_payment_id',
                  ''
                )), '')
              ),
              (
                'SUBSCRIPTION_ACTIVATION'::text,
                'subscription'::text,
                nullif(trim(coalesce(
                  offer.metadata ->> 'activation_payment_id',
                  ''
                )), '')
              )
          ) as match(payment_kind, purpose, bound_payment_id)
         where offer.tenant_id = normalized_tenant
           and offer.kind = 'ENROLLMENT'
           and (
             offer.processing_by = p_student_id
             or offer.consumed_by = p_student_id
           )
           and match.bound_payment_id = normalized_payment_id
      ) as binding
  loop
    candidate_count := candidate_count + 1;
    candidate_offer_id := candidate.offer_id;
    candidate_kind := candidate.payment_kind;
    candidate_reference := candidate.external_reference;
  end loop;

  if candidate_count = 0 and profile_payment_id = normalized_payment_id then
    return jsonb_build_object(
      'ok', true,
      'action', 'BOUND',
      'offer_id', null,
      'payment_kind', 'ENROLLMENT_FEE',
      'external_reference', p_student_id::text
    );
  elsif candidate_count = 0 then
    return jsonb_build_object('ok', true, 'action', 'NONE');
  elsif candidate_count > 1 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'enrollment_payment_binding_ambiguous',
      'offer_count', candidate_count
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'action', 'BOUND',
    'offer_id', candidate_offer_id,
    'payment_kind', candidate_kind,
    'external_reference', candidate_reference
  );
end;
$function$;


create or replace function public.apply_enrollment_payment_observation(
  p_tenant_id text,
  p_student_id uuid,
  p_offer_id uuid,
  p_provider_payment_id text,
  p_provider_customer_id text,
  p_provider_subscription_id text,
  p_payment_kind text,
  p_outcome text,
  p_provider_value numeric,
  p_external_reference text,
  p_provider_status text,
  p_due_date date,
  p_billing_type text,
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  normalized_payment_id text := nullif(
    trim(coalesce(p_provider_payment_id, '')),
    ''
  );
  normalized_customer_id text := nullif(
    trim(coalesce(p_provider_customer_id, '')),
    ''
  );
  normalized_subscription_id text := nullif(
    trim(coalesce(p_provider_subscription_id, '')),
    ''
  );
  normalized_kind text := upper(trim(coalesce(p_payment_kind, '')));
  normalized_outcome text := upper(trim(coalesce(p_outcome, '')));
  normalized_reference text := nullif(
    trim(coalesce(p_external_reference, '')),
    ''
  );
  normalized_provider_status text := upper(trim(coalesce(
    p_provider_status,
    ''
  )));
  normalized_billing_type text := upper(trim(coalesce(p_billing_type, '')));
  normalized_description text := nullif(trim(coalesce(p_description, '')), '');
  profiles_have_updated_at boolean := false;
  offer_row public.offers%rowtype;
  profile_row public.profiles%rowtype;
  payment_row public.student_payments%rowtype;
  local_payment_count integer := 0;
  local_outcome text;
  expected_reference text;
  completion jsonb;
  reopening jsonb;
  affected_rows integer := 0;
  offer_fee_id text;
  profile_fee_id text;
  fee_uses_profile_fallback boolean := false;
  fee_competing_offer_count integer := 0;
begin
  select exists(
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'profiles'
      and a.attname = 'updated_at'
      and not a.attisdropped
      and a.attnum > 0
  ) into profiles_have_updated_at;

  if normalized_tenant is null
     or p_student_id is null
     or normalized_payment_id is null
     or normalized_customer_id is null
     or normalized_kind not in (
       'ENROLLMENT_FEE', 'ONE_TIME', 'PRO_RATA', 'SUBSCRIPTION_ACTIVATION'
     )
     or (
       normalized_kind = 'SUBSCRIPTION_ACTIVATION'
       and normalized_subscription_id is null
     )
     or (
       normalized_kind <> 'SUBSCRIPTION_ACTIVATION'
       and normalized_subscription_id is not null
     )
     or length(coalesce(normalized_subscription_id, '')) > 240
     or normalized_outcome not in ('SETTLED', 'PENDING', 'UNSETTLED')
     or p_provider_value is null
     or p_provider_value <= 0
     or normalized_reference is null
     or normalized_provider_status = ''
     or length(normalized_provider_status) > 120
     or p_due_date is null
     or normalized_billing_type not in ('PIX', 'BOLETO', 'CREDIT_CARD')
     or normalized_description is null
     or length(normalized_description) > 500
     or (p_offer_id is null and normalized_kind <> 'ENROLLMENT_FEE')
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_enrollment_payment_observation';
  end if;

  if normalized_outcome is distinct from (
    case
      when normalized_provider_status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
        then 'SETTLED'
      when normalized_provider_status in (
        'REFUNDED', 'CANCELLED', 'DELETED', 'CHARGEBACK',
        'CHARGEBACK_REQUESTED', 'RECEIVED_IN_CASH_UNDONE'
      ) then 'UNSETTLED'
      else 'PENDING'
    end
  )
  then
    raise exception using
      errcode = '22023',
      message = 'provider_status_outcome_mismatch';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' ||
        p_student_id::text,
      0
    )
  );

  if p_offer_id is not null then
    select offer.* into offer_row
      from public.offers as offer
     where offer.id = p_offer_id
       and offer.tenant_id = normalized_tenant
       and offer.kind = 'ENROLLMENT'
     for update;
    if not found
       or (
         offer_row.processing_by is distinct from p_student_id
         and offer_row.consumed_by is distinct from p_student_id
       )
    then
      return jsonb_build_object('ok', false, 'reason', 'offer_not_owned');
    end if;
  end if;

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_student_id
     and profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
     and nullif(trim(coalesce(profile.asaas_customer_id, '')), '') =
       normalized_customer_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'profile_binding_changed');
  end if;

  expected_reference := case
    when p_offer_id is null then p_student_id::text
    when normalized_kind = 'ENROLLMENT_FEE'
      then 'enrollment:' || p_offer_id::text || ':fee'
    when normalized_kind = 'ONE_TIME'
      then 'enrollment:' || p_offer_id::text || ':one-time'
    when normalized_kind = 'PRO_RATA'
      then 'enrollment:' || p_offer_id::text || ':pro-rata'
    else 'enrollment:' || p_offer_id::text || ':subscription'
  end;
  if normalized_reference <> expected_reference then
    return jsonb_build_object(
      'ok', false,
      'reason', 'provider_reference_mismatch'
    );
  end if;

  if normalized_kind = 'ENROLLMENT_FEE' then
    profile_fee_id := nullif(trim(coalesce(
      profile_row.enrollment_payment_id,
      ''
    )), '');
    offer_fee_id := case when p_offer_id is null then null else nullif(
      trim(coalesce(offer_row.metadata ->> 'enrollment_payment_id', '')),
      ''
    ) end;
    if p_offer_id is null and profile_fee_id is distinct from normalized_payment_id
    then
      return jsonb_build_object(
        'ok', false,
        'reason', 'enrollment_payment_binding_mismatch'
      );
    elsif p_offer_id is not null and offer_fee_id is not null
          and offer_fee_id <> normalized_payment_id
    then
      return jsonb_build_object(
        'ok', false,
        'reason', 'enrollment_payment_binding_mismatch'
      );
    elsif p_offer_id is not null and offer_fee_id is null then
      if profile_fee_id is distinct from normalized_payment_id then
        return jsonb_build_object(
          'ok', false,
          'reason', 'enrollment_payment_binding_mismatch'
        );
      end if;
      select count(*) into fee_competing_offer_count
        from public.offers as competing_offer
       where competing_offer.id <> p_offer_id
         and competing_offer.tenant_id = normalized_tenant
         and competing_offer.kind = 'ENROLLMENT'
         and (
           competing_offer.processing_by = p_student_id
           or competing_offer.consumed_by = p_student_id
         )
         and nullif(trim(coalesce(
           competing_offer.metadata ->> 'enrollment_payment_id',
           ''
         )), '') = normalized_payment_id;
      if fee_competing_offer_count <> 0 then
        return jsonb_build_object(
          'ok', false,
          'reason', 'enrollment_payment_binding_mismatch'
        );
      end if;
      fee_uses_profile_fallback := true;
    end if;
  elsif p_offer_id is null then
    return jsonb_build_object('ok', false, 'reason', 'offer_required');
  elsif normalized_kind = 'ONE_TIME' then
    if (
         nullif(trim(coalesce(
           offer_row.metadata ->> 'one_time_payment_id',
           ''
         )), '') is not null
         and nullif(trim(coalesce(
           offer_row.metadata ->> 'one_time_payment_id',
           ''
         )), '') <> normalized_payment_id
       ) or (
         normalized_outcome <> 'SETTLED'
         and nullif(trim(coalesce(
           offer_row.metadata ->> 'one_time_payment_id',
           ''
         )), '') is distinct from normalized_payment_id
       )
    then
      return jsonb_build_object(
        'ok', false,
        'reason', 'one_time_payment_binding_mismatch'
      );
    end if;
  elsif normalized_kind = 'PRO_RATA' then
    begin
      if coalesce(
           nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
           0
         ) <= 0
         or round(
              coalesce(
                nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
                0
              ),
              2
            ) is distinct from round(p_provider_value, 2)
         or offer_row.payload ->> 'proRataFormulaVersion'
              is distinct from 'weekly-frequency-times-4-v1'
      then
        return jsonb_build_object(
          'ok', false,
          'reason', 'pro_rata_scope_invalid'
        );
      end if;
    exception when others then
      return jsonb_build_object(
        'ok', false,
        'reason', 'pro_rata_scope_invalid'
      );
    end;
    if (
         nullif(trim(coalesce(
           offer_row.metadata ->> 'pro_rata_charge_id',
           ''
         )), '') is not null
         and nullif(trim(coalesce(
           offer_row.metadata ->> 'pro_rata_charge_id',
           ''
         )), '') <> normalized_payment_id
       ) or (
         normalized_outcome <> 'SETTLED'
         and nullif(trim(coalesce(
           offer_row.metadata ->> 'pro_rata_charge_id',
           ''
         )), '') is distinct from normalized_payment_id
       )
    then
      return jsonb_build_object(
        'ok', false,
        'reason', 'pro_rata_payment_binding_mismatch'
      );
    end if;
  else
    if nullif(trim(coalesce(profile_row.subscription_id, '')), '')
         is distinct from normalized_subscription_id
       or nullif(trim(coalesce(
            offer_row.metadata ->> 'subscription_id',
            ''
          )), '') is distinct from normalized_subscription_id
       or (
         coalesce(
           nullif(trim(coalesce(
             offer_row.metadata ->> 'subscription_activation_payment_id',
             ''
           )), ''),
           nullif(trim(coalesce(
             offer_row.metadata ->> 'activation_payment_id',
             ''
           )), '')
         ) is not null
         and coalesce(
           nullif(trim(coalesce(
             offer_row.metadata ->> 'subscription_activation_payment_id',
             ''
           )), ''),
           nullif(trim(coalesce(
             offer_row.metadata ->> 'activation_payment_id',
             ''
           )), '')
         ) <> normalized_payment_id
       )
       or (
         normalized_outcome <> 'SETTLED'
         and coalesce(
           nullif(trim(coalesce(
             offer_row.metadata ->> 'subscription_activation_payment_id',
             ''
           )), ''),
           nullif(trim(coalesce(
             offer_row.metadata ->> 'activation_payment_id',
             ''
           )), '')
         ) is distinct from normalized_payment_id
       )
    then
      return jsonb_build_object(
        'ok', false,
        'reason', 'subscription_activation_payment_binding_mismatch'
      );
    end if;
  end if;

  if exists (
    select 1
      from public.student_payments as payment
     where (
       nullif(trim(coalesce(payment.asaas_payment_id, '')), '') =
         normalized_payment_id
       or nullif(trim(coalesce(payment.asaas_id, '')), '') =
         normalized_payment_id
     )
       and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') is not null
       and nullif(trim(coalesce(payment.asaas_id, '')), '') is not null
       and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') <>
           nullif(trim(coalesce(payment.asaas_id, '')), '')
  ) then
    return jsonb_build_object(
      'ok', false,
      'reason', 'local_payment_provider_alias_divergence'
    );
  end if;

  select count(*) into local_payment_count
    from public.student_payments as payment
   where nullif(trim(coalesce(payment.asaas_payment_id, '')), '') =
           normalized_payment_id
      or nullif(trim(coalesce(payment.asaas_id, '')), '') =
           normalized_payment_id;
  if local_payment_count > 1 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'local_payment_binding_ambiguous'
    );
  end if;

  if local_payment_count = 0 and normalized_outcome = 'PENDING' then
    insert into public.student_payments (
      asaas_payment_id,
      student_id,
      tenant_id,
      provider_customer_id,
      value,
      amount_cents,
      status,
      provider_status,
      due_date,
      billing_type,
      payment_method,
      description,
      payment_type,
      updated_at
    ) values (
      normalized_payment_id,
      p_student_id,
      normalized_tenant,
      normalized_customer_id,
      p_provider_value,
      round(p_provider_value * 100)::integer,
      normalized_provider_status,
      normalized_provider_status,
      p_due_date,
      normalized_billing_type,
      normalized_billing_type,
      normalized_description,
      case
        when normalized_kind = 'ENROLLMENT_FEE' then 'ENROLLMENT'
        when normalized_kind = 'PRO_RATA' then 'PRO_RATA'
        else 'SUBSCRIPTION'
      end,
      now()
    )
    on conflict (asaas_payment_id) where asaas_payment_id is not null
      do nothing;

    select count(*) into local_payment_count
      from public.student_payments as payment
     where nullif(trim(coalesce(payment.asaas_payment_id, '')), '') =
             normalized_payment_id
        or nullif(trim(coalesce(payment.asaas_id, '')), '') =
             normalized_payment_id;
  end if;

  if local_payment_count = 0 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'payment_event_not_observed'
    );
  end if;
  if local_payment_count > 1 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'local_payment_binding_ambiguous'
    );
  end if;

  if local_payment_count = 1 then
    select payment.* into payment_row
      from public.student_payments as payment
     where nullif(trim(coalesce(payment.asaas_payment_id, '')), '') =
             normalized_payment_id
        or nullif(trim(coalesce(payment.asaas_id, '')), '') =
             normalized_payment_id
     for update;

    if payment_row.tenant_id is distinct from normalized_tenant
       or payment_row.student_id is distinct from p_student_id
       or nullif(trim(coalesce(payment_row.provider_customer_id, '')), '')
         is distinct from normalized_customer_id
       or round(coalesce(payment_row.value, 0), 2)
         is distinct from round(p_provider_value, 2)
       or payment_row.due_date is distinct from p_due_date
       or upper(trim(coalesce(payment_row.billing_type, '')))
         is distinct from normalized_billing_type
       or (
         normalized_kind = 'PRO_RATA'
         and upper(trim(coalesce(payment_row.payment_type, '')))
           is distinct from 'PRO_RATA'
       )
    then
      return jsonb_build_object(
        'ok', false,
        'reason', 'local_payment_identity_mismatch'
      );
    end if;

    if fee_uses_profile_fallback
       and lower(trim(coalesce(
         payment_row.raw_payload #>> '{payment,externalReference}',
         ''
       ))) is distinct from lower(expected_reference)
    then
      return jsonb_build_object(
        'ok', false,
        'reason', 'enrollment_payment_binding_mismatch'
      );
    end if;

    local_outcome := case
      when upper(trim(coalesce(payment_row.status, ''))) in (
        'REFUNDED', 'CANCELLED', 'DELETED', 'CHARGEBACK',
        'CHARGEBACK_REQUESTED', 'RECEIVED_IN_CASH_UNDONE'
      ) or upper(trim(coalesce(payment_row.provider_status, ''))) in (
        'REFUNDED', 'CANCELLED', 'DELETED', 'CHARGEBACK',
        'CHARGEBACK_REQUESTED', 'RECEIVED_IN_CASH_UNDONE'
      ) then 'UNSETTLED'
      when upper(trim(coalesce(payment_row.status, ''))) in (
        'RECEIVED', 'RECEIVED_IN_CASH', 'PAGO'
      ) or upper(trim(coalesce(payment_row.provider_status, ''))) in (
        'RECEIVED', 'RECEIVED_IN_CASH', 'PAGO'
      ) then 'SETTLED'
      else 'PENDING'
    end;
    if local_outcome is distinct from normalized_outcome then
      return jsonb_build_object(
        'ok', false,
        'reason', 'provider_observation_stale',
        'local_outcome', local_outcome
      );
    end if;
  end if;

  if normalized_outcome in ('SETTLED', 'PENDING') then
    if lower(trim(coalesce(profile_row.lifecycle_status, ''))) <> 'active'
       or (
         select count(*) from public.tenant_memberships as membership
          where membership.user_id = p_student_id
       ) <> 1
       or not exists (
         select 1 from public.tenant_memberships as membership
          where membership.user_id = p_student_id
            and membership.tenant_id = normalized_tenant
            and membership.role = 'STUDENT'
            and membership.status = 'ACTIVE'
       )
       or exists (
         select 1 from public.student_offboarding_operations as operation
          where operation.tenant_id = normalized_tenant
            and operation.student_id = p_student_id
            and operation.status in (
              'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
              'UNKNOWN', 'BLOCKED'
            )
       )
       or exists (
         select 1 from public.student_account_deletion_claims as deletion
          where deletion.tenant_id = normalized_tenant
            and deletion.student_id = p_student_id
            and deletion.status in (
              'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
              'UNKNOWN', 'BLOCKED'
            )
       )
    then
      return jsonb_build_object(
        'ok', false,
        'reason', 'student_lifecycle_inactive'
      );
    end if;
  end if;

  if normalized_outcome = 'UNSETTLED' then
    if p_offer_id is null then
      if profiles_have_updated_at then
        update public.profiles
           set enrollment_fee_paid = false,
               status_financial = 'PENDING',
               updated_at = now()
         where id = p_student_id
           and tenant_id = normalized_tenant
           and role = 'STUDENT'
           and asaas_customer_id = normalized_customer_id
           and enrollment_payment_id = normalized_payment_id;
      else
        update public.profiles
           set enrollment_fee_paid = false,
               status_financial = 'PENDING'
         where id = p_student_id
           and tenant_id = normalized_tenant
           and role = 'STUDENT'
           and asaas_customer_id = normalized_customer_id
           and enrollment_payment_id = normalized_payment_id;
      end if;
      get diagnostics affected_rows = row_count;
      if affected_rows <> 1 then
        return jsonb_build_object(
          'ok', false,
          'reason', 'profile_binding_changed'
        );
      end if;
      return jsonb_build_object(
        'ok', true,
        'action', 'PAYMENT_REVOKED',
        'processing_state', null
      );
    end if;
    if normalized_kind in ('ONE_TIME', 'PRO_RATA') then
      update public.offers
         set metadata = coalesce(metadata, '{}'::jsonb) ||
               case normalized_kind
                 when 'ONE_TIME' then jsonb_build_object(
                   'one_time_payment_id', normalized_payment_id
                 )
                 else jsonb_build_object(
                   'pro_rata_charge_id', normalized_payment_id
                 )
               end
       where id = p_offer_id;
    end if;
    reopening := public.reopen_enrollment_offer_for_unsettled_payment(
      p_offer_id,
      p_student_id,
      normalized_payment_id,
      'payment_refunded'
    );
    if reopening ->> 'ok' <> 'true' then
      return jsonb_build_object(
        'ok', false,
        'reason', coalesce(reopening ->> 'reason', 'reopen_failed')
      );
    end if;
    return jsonb_build_object(
      'ok', true,
      'action', 'REOPENED',
      'processing_state', 'AWAITING_PAYMENT'
    );
  end if;

  if normalized_kind = 'ENROLLMENT_FEE' then
    if profiles_have_updated_at then
      update public.profiles
         set enrollment_fee_paid = case
               when normalized_outcome = 'SETTLED' then true
               else enrollment_fee_paid
             end,
             updated_at = now()
       where id = p_student_id
         and tenant_id = normalized_tenant
         and role = 'STUDENT'
         and lifecycle_status = 'active'
         and asaas_customer_id = normalized_customer_id
         and enrollment_payment_id = normalized_payment_id;
    else
      update public.profiles
         set enrollment_fee_paid = case
               when normalized_outcome = 'SETTLED' then true
               else enrollment_fee_paid
             end
       where id = p_student_id
         and tenant_id = normalized_tenant
         and role = 'STUDENT'
         and lifecycle_status = 'active'
         and asaas_customer_id = normalized_customer_id
         and enrollment_payment_id = normalized_payment_id;
    end if;
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then
      return jsonb_build_object(
        'ok', false,
        'reason', 'profile_binding_changed'
      );
    end if;
  end if;

  if p_offer_id is null then
    return jsonb_build_object(
      'ok', true,
      'action', case
        when normalized_outcome = 'SETTLED' then 'BILLING_RECORDED'
        else 'AWAITING_PAYMENT'
      end,
      'processing_state', null
    );
  end if;

  update public.offers
     set metadata = case normalized_kind
           when 'ENROLLMENT_FEE' then
             coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'enrollment_payment_id', normalized_payment_id
             ) || case when normalized_outcome = 'SETTLED'
               then jsonb_build_object('enrollment_fee_paid_at', now())
               else '{}'::jsonb end
           when 'ONE_TIME' then
             coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'one_time_payment_id', normalized_payment_id
             ) || case when normalized_outcome = 'SETTLED'
               then jsonb_build_object('one_time_paid_at', now())
               else '{}'::jsonb end
           when 'PRO_RATA' then
             coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'pro_rata_charge_id', normalized_payment_id
             ) || case when normalized_outcome = 'SETTLED'
               then jsonb_build_object('pro_rata_paid_at', now())
               else '{}'::jsonb end
           else coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'subscription_activation_payment_id', normalized_payment_id,
             'activation_payment_id', normalized_payment_id
           ) || case when normalized_outcome = 'SETTLED'
             then jsonb_build_object(
               'subscription_activation_received_at', now()
             )
             else '{}'::jsonb end
         end,
         processing_state = case
           when processing_state = 'COMPLETED' then processing_state
           when normalized_outcome = 'SETTLED' then 'BILLING_READY'
           else 'AWAITING_PAYMENT'
         end,
         processing_updated_at = now(),
         processing_error_code = null,
         processing_error_message = null
   where id = p_offer_id;

  if normalized_outcome = 'PENDING' then
    if offer_row.processing_state = 'COMPLETED' then
      reopening := public.reopen_enrollment_offer_for_unsettled_payment(
        p_offer_id,
        p_student_id,
        normalized_payment_id,
        'payment_not_settled'
      );
      if reopening ->> 'ok' <> 'true' then
        return jsonb_build_object(
          'ok', false,
          'reason', coalesce(reopening ->> 'reason', 'reopen_failed')
        );
      end if;
    end if;
    return jsonb_build_object(
      'ok', true,
      'action', 'AWAITING_PAYMENT',
      'processing_state', 'AWAITING_PAYMENT'
    );
  end if;

  completion := public.complete_enrollment_offer(p_offer_id, p_student_id);
  if completion ->> 'success' <> 'true' then
    return jsonb_build_object(
      'ok', true,
      'action', 'BILLING_RECORDED',
      'processing_state', 'BILLING_READY',
      'completion_error', completion ->> 'error'
    );
  end if;
  return jsonb_build_object(
    'ok', true,
    'action', case
      when completion ->> 'already_completed' = 'true'
        then 'ALREADY_COMPLETED'
      else 'COMPLETED'
    end,
    'processing_state', 'COMPLETED',
    'correlation_id', completion ->> 'correlation_id'
  );
end;
$function$;


create or replace function public.reopen_enrollment_offer_for_unsettled_payment(
  p_offer_id uuid,
  p_user_id uuid,
  p_provider_payment_id text,
  p_reason text default 'payment_refunded'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  offer_tenant text;
  offer_row public.offers%rowtype;
  profile_row public.profiles%rowtype;
  payment_id text := nullif(trim(coalesce(p_provider_payment_id, '')), '');
  normalized_reason text := lower(trim(coalesce(p_reason, '')));
  offer_fee_id text;
  profile_fee_id text;
  one_time_id text;
  pro_rata_id text;
  activation_primary_id text;
  activation_legacy_id text;
  payment_kind text;
  binding_count integer := 0;
  was_completed boolean;
  preserve_current_profile boolean := false;
  profiles_have_updated_at boolean := false;
begin
  select exists(
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'profiles'
      and a.attname = 'updated_at'
      and not a.attisdropped
      and a.attnum > 0
  ) into profiles_have_updated_at;

  if p_offer_id is null or p_user_id is null or payment_id is null
     or normalized_reason not in ('payment_refunded', 'payment_not_settled')
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_enrollment_refund_reopen';
  end if;

  select offer.tenant_id into offer_tenant
    from public.offers as offer
   where offer.id = p_offer_id
     and offer.kind = 'ENROLLMENT';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'offer_not_owned');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || offer_tenant || ':' || p_user_id::text,
      0
    )
  );

  select offer.* into offer_row
    from public.offers as offer
   where offer.id = p_offer_id
     and offer.tenant_id = offer_tenant
     and offer.kind = 'ENROLLMENT'
   for update;
  if not found or (
    offer_row.processing_by is distinct from p_user_id
    and offer_row.consumed_by is distinct from p_user_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'offer_not_owned');
  end if;
  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_user_id
     and profile.tenant_id = offer_tenant
     and profile.role = 'STUDENT'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'profile_not_found');
  end if;

  offer_fee_id := nullif(trim(coalesce(
    offer_row.metadata ->> 'enrollment_payment_id', ''
  )), '');
  profile_fee_id := nullif(trim(coalesce(
    profile_row.enrollment_payment_id, ''
  )), '');
  one_time_id := nullif(trim(coalesce(
    offer_row.metadata ->> 'one_time_payment_id', ''
  )), '');
  pro_rata_id := nullif(trim(coalesce(
    offer_row.metadata ->> 'pro_rata_charge_id', ''
  )), '');
  activation_primary_id := nullif(trim(coalesce(
    offer_row.metadata ->> 'subscription_activation_payment_id', ''
  )), '');
  activation_legacy_id := nullif(trim(coalesce(
    offer_row.metadata ->> 'activation_payment_id', ''
  )), '');
  if activation_primary_id is not null and activation_legacy_id is not null
     and activation_primary_id <> activation_legacy_id
  then
    return jsonb_build_object('ok', false, 'reason', 'payment_binding_ambiguous');
  end if;

  if payment_id = coalesce(offer_fee_id, profile_fee_id) then
    binding_count := binding_count + 1;
    payment_kind := 'ENROLLMENT_FEE';
  end if;
  if payment_id = one_time_id then
    binding_count := binding_count + 1;
    payment_kind := 'ONE_TIME';
  end if;
  if payment_id = pro_rata_id then
    binding_count := binding_count + 1;
    payment_kind := 'PRO_RATA';
  end if;
  if payment_id = coalesce(activation_primary_id, activation_legacy_id) then
    binding_count := binding_count + 1;
    payment_kind := 'ACTIVATION';
  end if;
  if binding_count = 0 then
    return jsonb_build_object('ok', false, 'reason', 'payment_not_bound');
  elsif binding_count > 1 then
    return jsonb_build_object('ok', false, 'reason', 'payment_binding_ambiguous');
  end if;

  preserve_current_profile := payment_kind = 'ENROLLMENT_FEE'
    and offer_fee_id = payment_id
    and profile_fee_id is not null
    and profile_fee_id <> payment_id;
  was_completed := offer_row.processing_state = 'COMPLETED';

  if not preserve_current_profile then
    if profiles_have_updated_at then
      update public.profiles
         set enrollment_fee_paid = case
               when payment_kind = 'ENROLLMENT_FEE' then false
               else enrollment_fee_paid
             end,
             status_financial = 'PENDING',
             updated_at = now()
       where id = p_user_id
         and tenant_id = offer_tenant;
    else
      update public.profiles
         set enrollment_fee_paid = case
               when payment_kind = 'ENROLLMENT_FEE' then false
               else enrollment_fee_paid
             end,
             status_financial = 'PENDING'
       where id = p_user_id
         and tenant_id = offer_tenant;
    end if;
  end if;

  update public.offers
     set metadata = case
           when payment_kind = 'ENROLLMENT_FEE'
             then coalesce(metadata, '{}'::jsonb) - 'enrollment_fee_paid_at'
           when payment_kind = 'ONE_TIME'
             then coalesce(metadata, '{}'::jsonb) - 'one_time_paid_at'
           when payment_kind = 'PRO_RATA'
             then coalesce(metadata, '{}'::jsonb) - 'pro_rata_paid_at'
           else coalesce(metadata, '{}'::jsonb)
             - 'subscription_activation_received_at'
         end,
         processing_state = 'AWAITING_PAYMENT',
         processing_updated_at = now(),
         processing_completed_at = null,
         processing_error_code = normalized_reason,
         processing_error_message = case
           when normalized_reason = 'payment_refunded'
             then 'Provider payment was fully refunded'
           else 'Provider payment is not settled'
         end
   where id = p_offer_id;

  if was_completed or preserve_current_profile then
    insert into public.asaas_reconciliation_issues (
      tenant_id, source, kind, severity, provider_entity_id,
      local_entity_id, fingerprint, details
    ) values (
      offer_tenant,
      'ENROLLMENT',
      case when preserve_current_profile
        then 'HISTORICAL_ENROLLMENT_PAYMENT_REFUNDED'
        when normalized_reason = 'payment_refunded'
          then 'ENROLLMENT_PAYMENT_REFUNDED_AFTER_COMPLETION'
        else 'ENROLLMENT_ACTIVATED_BEFORE_SETTLEMENT'
      end,
      case when normalized_reason = 'payment_refunded' then 'CRITICAL' else 'HIGH' end,
      payment_id,
      p_offer_id::text,
      'enrollment-unsettled:' || p_offer_id::text || ':' || payment_id,
      jsonb_build_object(
        'paymentKind', payment_kind,
        'reason', normalized_reason,
        'userId', p_user_id,
        'commercialSideEffectsPreserved', true,
        'currentProfileAccessPreserved', preserve_current_profile
      )
    ) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', true,
    'action', case when preserve_current_profile
      then 'HISTORICAL_OFFER_REOPENED'
      else 'REOPENED'
    end,
    'processing_state', 'AWAITING_PAYMENT',
    'payment_kind', payment_kind,
    'reason', normalized_reason,
    'was_completed', was_completed,
    'current_profile_access_preserved', preserve_current_profile
  );
end;
$function$;


create or replace function public.complete_enrollment_offer_pre_schedule_impl(
  p_offer_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  offer_row public.offers%rowtype;
  profile_row public.profiles%rowtype;
  payment_id text;
  payment_row public.student_payments%rowtype;
  payment_count integer;
  plan_duration integer;
  enrollment_payment_id text;
  profile_enrollment_payment_id text;
  offer_enrollment_payment_id text;
  enrollment_payment_uses_profile_fallback boolean := false;
  profile_fee_offer_binding_count integer := 0;
  subscription_activation_offer boolean := false;
  required_billing_payment_id text;
  expected_payment_value numeric;
  payment_ids text[] := array[]::text[];
begin
  select offer.* into offer_row
    from public.offers as offer
   where offer.id = p_offer_id
     and offer.kind = 'ENROLLMENT';
  if not found then
    return jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || offer_row.tenant_id || ':' ||
        p_user_id::text,
      0
    )
  );

  select offer.* into offer_row
    from public.offers as offer
   where offer.id = p_offer_id
     and offer.kind = 'ENROLLMENT'
   for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND');
  end if;
  if not private.tenant_is_operational(offer_row.tenant_id) then
    return jsonb_build_object(
      'success', false,
      'error', 'TENANT_UNAVAILABLE'
    );
  end if;
  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_user_id
     and profile.tenant_id = offer_row.tenant_id
     and profile.role = 'STUDENT'
   for update;
  if not found
     or lower(trim(coalesce(profile_row.lifecycle_status, ''))) <> 'active'
     or (
       select count(*) from public.tenant_memberships as membership
        where membership.user_id = p_user_id
     ) <> 1
     or not exists (
       select 1 from public.tenant_memberships as membership
        where membership.user_id = p_user_id
          and membership.tenant_id = offer_row.tenant_id
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
     )
     or exists (
       select 1 from public.student_offboarding_operations as operation
        where operation.tenant_id = offer_row.tenant_id
          and operation.student_id = p_user_id
          and operation.status in (
            'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
            'UNKNOWN', 'BLOCKED'
          )
     )
     or exists (
       select 1 from public.student_account_deletion_claims as deletion
        where deletion.tenant_id = offer_row.tenant_id
          and deletion.student_id = p_user_id
          and deletion.status in (
            'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
            'UNKNOWN', 'BLOCKED'
          )
     )
  then
    return jsonb_build_object(
      'success', false,
      'error', 'STUDENT_LIFECYCLE_INACTIVE'
    );
  end if;

  plan_duration := coalesce(
    nullif(offer_row.payload ->> 'planDuration', '')::integer,
    1
  );
  profile_enrollment_payment_id := nullif(trim(coalesce(
    profile_row.enrollment_payment_id,
    ''
  )), '');
  offer_enrollment_payment_id := nullif(trim(coalesce(
    offer_row.metadata ->> 'enrollment_payment_id',
    ''
  )), '');
  subscription_activation_offer := greatest(
    coalesce(offer_row.enrollment_fee, 0), 0
  ) <= 0
    and (
      coalesce(
        nullif(trim(coalesce(
          offer_row.metadata ->> 'subscription_activation_payment_id',
          ''
        )), ''),
        nullif(trim(coalesce(
          offer_row.metadata ->> 'activation_payment_id',
          ''
        )), '')
      ) is not null
    );
  if offer_enrollment_payment_id is not null
     and profile_enrollment_payment_id is not null
     and offer_enrollment_payment_id <> profile_enrollment_payment_id
  then
    return jsonb_build_object(
      'success', false,
      'error', 'PAYMENT_BINDING_CHANGED'
    );
  end if;
  if offer_enrollment_payment_id is null
     and profile_enrollment_payment_id is not null
     and not subscription_activation_offer
  then
    select count(*) into profile_fee_offer_binding_count
      from public.offers as bound_offer
     where bound_offer.tenant_id = offer_row.tenant_id
       and bound_offer.kind = 'ENROLLMENT'
       and bound_offer.id <> p_offer_id
       and (
         bound_offer.processing_by = p_user_id
         or bound_offer.consumed_by = p_user_id
       )
       and nullif(trim(coalesce(
         bound_offer.metadata ->> 'enrollment_payment_id',
         ''
       )), '') = profile_enrollment_payment_id;
    if profile_fee_offer_binding_count <> 0 then
      return jsonb_build_object(
        'success', false,
        'error', 'PAYMENT_BINDING_CHANGED'
      );
    end if;
  end if;
  -- Offer metadata is authoritative for an offer-scoped fee. The profile is a
  -- compatibility fallback only for standalone/legacy fees with no offer id.
  enrollment_payment_id := coalesce(
    offer_enrollment_payment_id,
    profile_enrollment_payment_id
  );
  enrollment_payment_uses_profile_fallback :=
    offer_enrollment_payment_id is null
    and profile_enrollment_payment_id is not null;
  required_billing_payment_id := case
    when plan_duration = 0 then nullif(trim(coalesce(
      offer_row.metadata ->> 'one_time_payment_id',
      ''
    )), '')
    when coalesce(
           nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
           0
         ) > 0
      then nullif(trim(coalesce(
        offer_row.metadata ->> 'pro_rata_charge_id',
        ''
      )), '')
    when greatest(coalesce(offer_row.enrollment_fee, 0), 0) <= 0
      then coalesce(
      nullif(trim(coalesce(
        offer_row.metadata ->> 'subscription_activation_payment_id',
        ''
      )), ''),
      nullif(trim(coalesce(
        offer_row.metadata ->> 'activation_payment_id',
        ''
      )), '')
    )
    else null
  end;

  if greatest(coalesce(offer_row.enrollment_fee, 0), 0) > 0
     and enrollment_payment_id is null
  then
    return jsonb_build_object(
      'success', false,
      'error', 'PAYMENT_EVENT_NOT_SETTLED'
    );
  elsif greatest(coalesce(offer_row.enrollment_fee, 0), 0) > 0 then
    payment_ids := pg_catalog.array_append(
      payment_ids,
      enrollment_payment_id
    );
  end if;
  if required_billing_payment_id is not null
     and required_billing_payment_id <> all(payment_ids)
  then
    payment_ids := pg_catalog.array_append(
      payment_ids,
      required_billing_payment_id
    );
  end if;
  if (
    plan_duration = 0
    or greatest(coalesce(offer_row.enrollment_fee, 0), 0) <= 0
    or coalesce(
         nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
         0
       ) > 0
  ) and required_billing_payment_id is null then
    return jsonb_build_object(
      'success', false,
      'error', 'PAYMENT_EVENT_NOT_SETTLED'
    );
  end if;
  if enrollment_payment_id is not null
     and enrollment_payment_id = required_billing_payment_id
  then
    return jsonb_build_object(
      'success', false,
      'error', 'PAYMENT_BINDING_AMBIGUOUS'
    );
  end if;

  foreach payment_id in array payment_ids
  loop
    if payment_id is null then
      continue;
    end if;
    if exists (
      select 1
        from public.student_payments as payment
       where (
         nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = payment_id
         or nullif(trim(coalesce(payment.asaas_id, '')), '') = payment_id
       )
         and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') is not null
         and nullif(trim(coalesce(payment.asaas_id, '')), '') is not null
         and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') <>
             nullif(trim(coalesce(payment.asaas_id, '')), '')
    ) then
      return jsonb_build_object(
        'success', false,
        'error', 'PAYMENT_PROVIDER_ALIAS_DIVERGENCE'
      );
    end if;
    select count(*) into payment_count
      from public.student_payments as payment
     where nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = payment_id
        or nullif(trim(coalesce(payment.asaas_id, '')), '') = payment_id;
    if payment_count > 1 then
      return jsonb_build_object(
        'success', false,
        'error', 'PAYMENT_BINDING_AMBIGUOUS'
      );
    end if;
    if payment_count = 0 then
      return jsonb_build_object(
        'success', false,
        'error', 'PAYMENT_EVENT_NOT_PERSISTED'
      );
    end if;
    if payment_count = 1 then
      select payment.* into payment_row
        from public.student_payments as payment
       where nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = payment_id
          or nullif(trim(coalesce(payment.asaas_id, '')), '') = payment_id
       for update;
      expected_payment_value := case
        when payment_id = enrollment_payment_id
          then greatest(coalesce(offer_row.enrollment_fee, 0), 0)
        when payment_id = nullif(trim(coalesce(
               offer_row.metadata ->> 'pro_rata_charge_id',
               ''
             )), '')
          and coalesce(
                nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
                0
              ) > 0
          then coalesce(
            nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
            0
          )
        else coalesce(nullif(offer_row.payload ->> 'value', '')::numeric, 0)
      end;
      if payment_row.tenant_id is distinct from offer_row.tenant_id
         or payment_row.student_id is distinct from p_user_id
         or nullif(trim(coalesce(payment_row.provider_customer_id, '')), '')
           is distinct from nullif(trim(coalesce(
             profile_row.asaas_customer_id,
             ''
           )), '')
         or upper(trim(coalesce(payment_row.status, ''))) in (
           'REFUNDED', 'CANCELLED', 'DELETED', 'CHARGEBACK',
           'CHARGEBACK_REQUESTED', 'RECEIVED_IN_CASH_UNDONE'
         )
         or upper(trim(coalesce(payment_row.provider_status, ''))) in (
           'REFUNDED', 'CANCELLED', 'DELETED', 'CHARGEBACK',
           'CHARGEBACK_REQUESTED', 'RECEIVED_IN_CASH_UNDONE'
         )
         or not (
           upper(trim(coalesce(payment_row.status, ''))) in (
             'RECEIVED', 'RECEIVED_IN_CASH', 'PAGO'
           )
           or upper(trim(coalesce(payment_row.provider_status, ''))) in (
             'RECEIVED', 'RECEIVED_IN_CASH', 'PAGO'
           )
         )
         or round(coalesce(payment_row.value, 0), 2)
           is distinct from round(expected_payment_value, 2)
         or (
           payment_id = enrollment_payment_id
           and enrollment_payment_uses_profile_fallback
           and lower(trim(coalesce(
             payment_row.raw_payload #>> '{payment,externalReference}',
             ''
           ))) is distinct from
             'enrollment:' || p_offer_id::text || ':fee'
         )
      then
        return jsonb_build_object(
          'success', false,
          'error', 'PAYMENT_EVENT_NOT_SETTLED'
        );
      end if;
    end if;
  end loop;

  if offer_row.invite_security_version < 1 then
    return jsonb_build_object('success', false, 'error', 'OFFER_REVOKED');
  end if;
  if not private.tenant_is_operational(offer_row.tenant_id) then
    return jsonb_build_object('success', false, 'error', 'TENANT_UNAVAILABLE');
  end if;
  return public.complete_enrollment_offer_authoritative_impl(
    p_offer_id,
    p_user_id
  );
end;
$function$;



alter function public.resolve_enrollment_payment_observation_binding(
  text, uuid, text, text, text
) owner to postgres;
revoke all on function public.resolve_enrollment_payment_observation_binding(
  text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_enrollment_payment_observation_binding(
  text, uuid, text, text, text
) to service_role;

alter function public.apply_enrollment_payment_observation(
  text, uuid, uuid, text, text, text, text, text, numeric, text,
  text, date, text, text
) owner to postgres;
revoke all on function public.apply_enrollment_payment_observation(
  text, uuid, uuid, text, text, text, text, text, numeric, text,
  text, date, text, text
) from public, anon, authenticated;
grant execute on function public.apply_enrollment_payment_observation(
  text, uuid, uuid, text, text, text, text, text, numeric, text,
  text, date, text, text
) to service_role;

alter function public.reopen_enrollment_offer_for_unsettled_payment(
  uuid, uuid, text, text
) owner to postgres;
revoke all on function public.reopen_enrollment_offer_for_unsettled_payment(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.reopen_enrollment_offer_for_unsettled_payment(
  uuid, uuid, text, text
) to service_role;

alter function public.complete_enrollment_offer_pre_schedule_impl(
  uuid, uuid
) owner to postgres;
revoke all on function public.complete_enrollment_offer_pre_schedule_impl(
  uuid, uuid
) from public, anon, authenticated, service_role;

comment on function public.apply_enrollment_payment_observation(
  text, uuid, uuid, text, text, text, text, text, numeric, text,
  text, date, text, text
) is
  'Serializa taxa, avulso, pro-rata e primeira parcela sem confundir mensalidades futuras com ativacao.';

commit;
