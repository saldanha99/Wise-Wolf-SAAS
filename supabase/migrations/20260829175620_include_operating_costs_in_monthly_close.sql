begin;

-- The payment close and the DRE answer different questions. The payment close
-- proves that every recurring obligation was settled and freezes the cash
-- allocation. The DRE supplies the operating cost, expenses and result by
-- competence. Keep both snapshots side by side so neither the Edge Function
-- nor the language model has to combine mutable source rows or invent math.
create or replace function public.refresh_monthly_payment_closure_financial(
  p_tenant_id text,
  p_period_start date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_tenant text := nullif(
    pg_catalog.btrim(coalesce(p_tenant_id, '')),
    ''
  );
  normalized_period date := pg_catalog.date_trunc(
    'month',
    p_period_start
  )::date;
  base_result jsonb;
  dre_result jsonb;
  dre_snapshot jsonb;
  augmented_snapshot jsonb;
  closure_row public.monthly_payment_closures%rowtype;
begin
  -- The base function owns roster construction, blockers and the source hash.
  -- Its advisory transaction lock remains held until this wrapper returns.
  base_result := public.refresh_monthly_payment_closure(
    normalized_tenant,
    normalized_period
  );
  if coalesce((base_result ->> 'ok')::boolean, false) is false then
    return base_result;
  end if;

  select closure.*
    into closure_row
    from public.monthly_payment_closures as closure
   where closure.tenant_id = normalized_tenant
     and closure.period_start = normalized_period
   for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'monthly_payment_closure_missing_after_refresh';
  end if;

  dre_result := public.dre_gerencial(
    pg_catalog.to_char(normalized_period, 'YYYY-MM'),
    normalized_tenant
  );
  if dre_result is null
     or pg_catalog.jsonb_typeof(dre_result) <> 'object'
     or dre_result ? 'error'
  then
    raise exception using
      errcode = '55000',
      message = 'monthly_payment_closure_dre_unavailable';
  end if;

  dre_snapshot := pg_catalog.jsonb_build_object(
    'month', dre_result -> 'month',
    'regime', dre_result -> 'regime',
    'receita_bruta', dre_result -> 'receita_bruta',
    'deducoes', dre_result -> 'deducoes',
    'receita_liquida', dre_result -> 'receita_liquida',
    'custo_servicos', dre_result -> 'custo_servicos',
    'lucro_bruto', dre_result -> 'lucro_bruto',
    'margem_bruta_pct', dre_result -> 'margem_bruta_pct',
    'despesas_operacionais', dre_result -> 'despesas_operacionais',
    'resultado', dre_result -> 'resultado',
    'margem_liquida_pct', dre_result -> 'margem_liquida_pct',
    'indicadores', coalesce(dre_result -> 'indicadores', '{}'::jsonb),
    'linhas', coalesce(dre_result -> 'linhas', '[]'::jsonb),
    'alertas', coalesce(dre_result -> 'alertas', '[]'::jsonb)
  );

  -- After delivery, the original snapshot remains immutable. Any late
  -- operating cost or expense moves the close to REVIEW instead of silently
  -- rewriting, re-sending or presenting a different historical result.
  if closure_row.sent_at is not null then
    if closure_row.snapshot -> 'dre' is distinct from dre_snapshot then
      update public.monthly_payment_closures as closure
         set status = 'REVIEW',
             review_reason = coalesce(
               closure.review_reason,
               'dre_changed_after_monthly_close'
             ),
             updated_at = pg_catalog.now()
       where closure.tenant_id = normalized_tenant
         and closure.period_start = normalized_period;
      return base_result || pg_catalog.jsonb_build_object(
        'status', 'REVIEW',
        'ready', false,
        'already_sent', true,
        'dre_changed_after_monthly_close', true,
        'snapshot', closure_row.snapshot
      );
    end if;
    return base_result || pg_catalog.jsonb_build_object(
      'snapshot', closure_row.snapshot
    );
  end if;

  augmented_snapshot := closure_row.snapshot ||
    pg_catalog.jsonb_build_object('dre', dre_snapshot);
  update public.monthly_payment_closures as closure
     set snapshot = augmented_snapshot,
         updated_at = pg_catalog.now()
   where closure.tenant_id = normalized_tenant
     and closure.period_start = normalized_period;

  -- snapshot_hash deliberately remains the hash of the payment/roster source.
  -- The DRE is versioned independently above and compared explicitly after a
  -- sent close. This preserves the base function's idempotent source check.
  return base_result || pg_catalog.jsonb_build_object(
    'snapshot', augmented_snapshot
  );
end;
$function$;

alter function public.refresh_monthly_payment_closure_financial(text, date)
  owner to postgres;
revoke all on function public.refresh_monthly_payment_closure_financial(
  text, date
) from public, anon, authenticated;
grant execute on function public.refresh_monthly_payment_closure_financial(
  text, date
) to service_role;

do $postcheck$
begin
  if pg_catalog.to_regprocedure(
       'public.refresh_monthly_payment_closure_financial(text,date)'
     ) is null
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.refresh_monthly_payment_closure_financial(text,date)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.refresh_monthly_payment_closure_financial(text,date)',
       'EXECUTE'
     )
  then
    raise exception 'monthly operating-cost close was not installed safely';
  end if;
end;
$postcheck$;

commit;
