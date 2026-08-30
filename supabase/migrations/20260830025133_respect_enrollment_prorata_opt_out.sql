-- O valor do pró-rata continua autoritativo: o banco recalcula preço e número
-- de aulas. Esta correção preserva apenas a decisão comercial explícita de
-- cobrar ou não cobrar o período anterior à primeira mensalidade.
do $migration$
declare
  v_function_oid regprocedure := pg_catalog.to_regprocedure(
    'private.prepare_enrollment_offer_payload(jsonb,text)'
  );
  v_definition text;
  v_forced_expression constant text :=
    'v_enable_pro_rata := v_duration <> 0 and v_class_count > 0;';
  v_opt_out_expression constant text :=
    'v_enable_pro_rata := v_enable_pro_rata and v_duration <> 0 and v_class_count > 0;';
begin
  if v_function_oid is null then
    raise exception 'prepare_enrollment_offer_payload_missing';
  end if;

  select pg_catalog.pg_get_functiondef(v_function_oid)
  into v_definition;

  if pg_catalog.strpos(v_definition, v_opt_out_expression) > 0 then
    return;
  end if;
  if pg_catalog.strpos(v_definition, v_forced_expression) = 0 then
    raise exception 'prepare_enrollment_offer_payload_shape_changed';
  end if;

  v_definition := pg_catalog.replace(
    v_definition,
    v_forced_expression,
    v_opt_out_expression
  );
  execute v_definition;
end;
$migration$;

-- Registros legados podem conter um valor proporcional residual mesmo com a
-- flag desligada. Todas as fronteiras financeiras devem considerar a flag e
-- o valor em conjunto: sem opt-in explícito, não há obrigação PRO_RATA.
do $payment_guards$
declare
  v_patch record;
  v_function_oid regprocedure;
  v_definition text;
begin
  for v_patch in
    select *
    from (
      values
        (
          'public.complete_enrollment_offer(uuid,uuid)',
          $old$    v_pro_rata_value := coalesce(
      nullif(v_offer.payload ->> 'proRataValue', '')::numeric,
      0
    );$old$,
          $new$    v_pro_rata_value := case
      when v_offer.payload ->> 'enableProRata' = 'true' then coalesce(
        nullif(v_offer.payload ->> 'proRataValue', '')::numeric,
        0
      )
      else 0
    end;$new$,
          'complete_offer_value'
        ),
        (
          'public.resolve_enrollment_payment_observation_binding(text,uuid,text,text,text)',
          $old$      if resolved_kind = 'PRO_RATA' and (
        coalesce($old$,
          $new$      if resolved_kind = 'PRO_RATA' and (
        offer_row.payload ->> 'enableProRata' is distinct from 'true'
        or coalesce($new$,
          'resolver_explicit_pro_rata'
        ),
        (
          'public.resolve_enrollment_payment_observation_binding(text,uuid,text,text,text)',
          $old$           and match.bound_payment_id = normalized_payment_id$old$,
          $new$           and match.bound_payment_id = normalized_payment_id
           and (
             match.payment_kind <> 'PRO_RATA'
             or (
               offer.payload ->> 'enableProRata' = 'true'
               and coalesce(
                 nullif(offer.payload ->> 'proRataValue', '')::numeric,
                 0
               ) > 0
               and offer.payload ->> 'proRataFormulaVersion'
                 = 'weekly-frequency-times-4-v1'
             )
           )$new$,
          'resolver_reference_less_pro_rata'
        ),
        (
          'public.resolve_enrollment_payment_observation_binding(text,uuid,text,text,text)',
          $old$         or coalesce(
              nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
              0
            ) > 0$old$,
          $new$         or (
              offer_row.payload ->> 'enableProRata' = 'true'
              and coalesce(
                nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
                0
              ) > 0
            )$new$,
          'resolver_subscription_activation'
        ),
        (
          'public.apply_enrollment_payment_observation(text,uuid,uuid,text,text,text,text,text,numeric,text,text,date,text,text)',
          $old$  elsif normalized_kind = 'PRO_RATA' then
    begin
      if coalesce($old$,
          $new$  elsif normalized_kind = 'PRO_RATA' then
    begin
      if offer_row.payload ->> 'enableProRata' is distinct from 'true'
         or coalesce($new$,
          'apply_pro_rata_observation'
        ),
        (
          'public.reopen_enrollment_offer_for_unsettled_payment(uuid,uuid,text,text)',
          $old$  pro_rata_id := nullif(trim(coalesce(
    offer_row.metadata ->> 'pro_rata_charge_id', ''
  )), '');$old$,
          $new$  pro_rata_id := case
    when offer_row.payload ->> 'enableProRata' = 'true' then nullif(
      trim(coalesce(offer_row.metadata ->> 'pro_rata_charge_id', '')),
      ''
    )
    else null
  end;$new$,
          'reopen_pro_rata_payment'
        ),
        (
          'public.complete_enrollment_offer_pre_schedule_impl(uuid,uuid)',
          $old$    when coalesce(
           nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
           0
         ) > 0
      then$old$,
          $new$    when offer_row.payload ->> 'enableProRata' = 'true'
      and coalesce(
            nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
            0
          ) > 0
      then$new$,
          'completion_required_payment'
        ),
        (
          'public.complete_enrollment_offer_pre_schedule_impl(uuid,uuid)',
          $old$    or coalesce(
         nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
         0
       ) > 0
  ) and required_billing_payment_id is null$old$,
          $new$    or (
      offer_row.payload ->> 'enableProRata' = 'true'
      and coalesce(
            nullif(offer_row.payload ->> 'proRataValue', '')::numeric,
            0
          ) > 0
    )
  ) and required_billing_payment_id is null$new$,
          'completion_missing_payment'
        ),
        (
          'public.complete_enrollment_offer_pre_schedule_impl(uuid,uuid)',
          $old$        when payment_id = nullif(trim(coalesce(
               offer_row.metadata ->> 'pro_rata_charge_id',
               ''
             )), '')
          and coalesce($old$,
          $new$        when payment_id = nullif(trim(coalesce(
               offer_row.metadata ->> 'pro_rata_charge_id',
               ''
             )), '')
          and offer_row.payload ->> 'enableProRata' = 'true'
          and coalesce($new$,
          'completion_expected_pro_rata_value'
        )
    ) as patches(function_signature, old_text, new_text, patch_name)
  loop
    v_function_oid := pg_catalog.to_regprocedure(v_patch.function_signature);
    if v_function_oid is null then
      raise exception 'pro_rata_guard_function_missing: %',
        v_patch.function_signature;
    end if;

    select pg_catalog.pg_get_functiondef(v_function_oid)
    into v_definition;

    if pg_catalog.strpos(v_definition, v_patch.new_text) > 0 then
      continue;
    end if;
    if pg_catalog.strpos(v_definition, v_patch.old_text) = 0 then
      raise exception 'pro_rata_guard_shape_changed: %', v_patch.patch_name;
    end if;

    v_definition := pg_catalog.replace(
      v_definition,
      v_patch.old_text,
      v_patch.new_text
    );
    execute v_definition;
  end loop;
end;
$payment_guards$;

revoke all on function private.prepare_enrollment_offer_payload(jsonb,text)
  from public, anon, authenticated, service_role;

revoke all on function public.resolve_enrollment_payment_observation_binding(
  text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_enrollment_payment_observation_binding(
  text, uuid, text, text, text
) to service_role;

revoke all on function public.apply_enrollment_payment_observation(
  text, uuid, uuid, text, text, text, text, text, numeric, text,
  text, date, text, text
) from public, anon, authenticated;
grant execute on function public.apply_enrollment_payment_observation(
  text, uuid, uuid, text, text, text, text, text, numeric, text,
  text, date, text, text
) to service_role;

revoke all on function public.reopen_enrollment_offer_for_unsettled_payment(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.reopen_enrollment_offer_for_unsettled_payment(
  uuid, uuid, text, text
) to service_role;

revoke all on function public.complete_enrollment_offer_pre_schedule_impl(
  uuid, uuid
) from public, anon, authenticated, service_role;

revoke all on function public.complete_enrollment_offer(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.complete_enrollment_offer(uuid,uuid)
  to service_role;

comment on function private.prepare_enrollment_offer_payload(jsonb,text) is
  'Normaliza ofertas de matrícula, respeita enableProRata=false e recalcula autoritativamente o valor quando habilitado.';

comment on function public.complete_enrollment_offer(uuid,uuid) is
  'Conclui matrícula somente com obrigações financeiras explicitamente habilitadas na oferta.';
