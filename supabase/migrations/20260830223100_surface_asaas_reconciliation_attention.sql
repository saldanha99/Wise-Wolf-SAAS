begin;

do $foundation$
begin
  if pg_catalog.to_regprocedure(
       'public.director_pending_counts_unchecked()'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.can_execute_legacy_role_rpc(text[])'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.active_tenant_id(uuid)'
     ) is null
     or pg_catalog.to_regclass(
       'public.management_payment_notification_outbox'
     ) is null
     or pg_catalog.to_regclass('public.student_payments') is null
     or pg_catalog.to_regclass('public.asaas_reconciliation_runs') is null
     or pg_catalog.to_regclass('public.asaas_reconciliation_issues') is null
  then
    raise exception 'Asaas reconciliation attention foundation is missing';
  end if;
end;
$foundation$;

-- Put the two previously hidden financial queues in the director's existing
-- pending center: payments with no student and unresolved high/critical Asaas
-- facts from the newest completed audit. Historical runs remain available for
-- audit but never inflate the current badge.
create or replace function public.director_pending_counts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text;
  v_today date := pg_catalog.timezone(
    'America/Sao_Paulo', pg_catalog.now()
  )::date;
  v_counts jsonb;
  v_payment_notification_attention integer := 0;
  v_unlinked_payments integer := 0;
  v_asaas_attention integer := 0;
  v_latest_run_id uuid;
begin
  if not private.can_execute_legacy_role_rpc(
    array['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) then
    return '{}'::jsonb;
  end if;

  v_tenant_id := private.active_tenant_id((select auth.uid()));
  v_counts := coalesce(
    public.director_pending_counts_unchecked(),
    '{}'::jsonb
  );

  if v_tenant_id is not null then
    select pg_catalog.count(*)::integer
      into v_payment_notification_attention
      from public.management_payment_notification_outbox as outbox
     where outbox.tenant_id = v_tenant_id
       and outbox.status in ('SUBMITTING', 'FAILED', 'UNKNOWN');

    select pg_catalog.count(distinct coalesce(
             nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), ''),
             nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), ''),
             payment.id::text
           ))::integer
      into v_unlinked_payments
      from public.student_payments as payment
     where payment.tenant_id = v_tenant_id
       and payment.student_id is null
       and upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
         'PENDING', 'OVERDUE', 'CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'
       );

    select run.id
      into v_latest_run_id
      from public.asaas_reconciliation_runs as run
     where run.status = 'COMPLETED'
       and run.metrics ->> 'tenantId' = v_tenant_id
       and run.window_end - run.window_start >= 44
       and run.window_start <= v_today - 45
       and run.window_end >= v_today - 1
       and run.finished_at >= pg_catalog.now() - interval '36 hours'
     order by run.finished_at desc nulls last, run.started_at desc
     limit 1;

    if v_latest_run_id is not null then
      select pg_catalog.count(distinct coalesce(
               issue.provider_entity_id,
               issue.local_entity_id,
               issue.kind
             ))::integer
        into v_asaas_attention
        from public.asaas_reconciliation_issues as issue
       where issue.run_id = v_latest_run_id
         and issue.tenant_id = v_tenant_id
         and issue.resolved_at is null
         and issue.severity in ('HIGH', 'CRITICAL')
         and issue.kind <> 'PAYMENT_TENANT_OR_STUDENT_UNRESOLVED';
    else
      -- A day-only deploy smoke test must never replace the operational
      -- audit. If no 45-day-or-wider run exists, surface that absence as one
      -- action instead of declaring the provider fully reconciled.
      v_asaas_attention := 1;
    end if;
  end if;

  return v_counts || pg_catalog.jsonb_build_object(
    'avisos_pagamento', coalesce(v_payment_notification_attention, 0),
    'pagamentos_sem_aluno', coalesce(v_unlinked_payments, 0),
    'conciliacao_asaas', coalesce(v_asaas_attention, 0)
  );
end;
$function$;

alter function public.director_pending_counts() owner to postgres;
alter function public.director_pending_counts() set search_path = '';
revoke all on function public.director_pending_counts()
  from public, anon, authenticated, service_role;
grant execute on function public.director_pending_counts()
  to authenticated, service_role;

do $postcheck$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.director_pending_counts()'::pg_catalog.regprocedure
  );
begin
  if v_definition not like '%pagamentos_sem_aluno%'
     or v_definition not like '%conciliacao_asaas%'
     or v_definition not like '%management_payment_notification_outbox%'
     or pg_catalog.has_function_privilege(
       'anon', 'public.director_pending_counts()', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated', 'public.director_pending_counts()', 'EXECUTE'
     )
  then
    raise exception 'director Asaas reconciliation attention is not visible';
  end if;
end;
$postcheck$;

create or replace function public.asaas_reconciliation_attention()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text;
  v_today date := pg_catalog.timezone(
    'America/Sao_Paulo', pg_catalog.now()
  )::date;
  v_latest_run_id uuid;
  v_observed_at timestamptz;
  v_window_start date;
  v_window_end date;
  v_payload jsonb;
begin
  if not private.can_execute_legacy_role_rpc(
    array['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) then
    return '{}'::jsonb;
  end if;
  v_tenant_id := private.active_tenant_id((select auth.uid()));
  if v_tenant_id is null then
    return '{}'::jsonb;
  end if;

  select run.id, run.finished_at, run.window_start, run.window_end
    into v_latest_run_id, v_observed_at, v_window_start, v_window_end
    from public.asaas_reconciliation_runs as run
   where run.status = 'COMPLETED'
     and run.metrics ->> 'tenantId' = v_tenant_id
     and run.window_end - run.window_start >= 44
     and run.window_start <= v_today - 45
     and run.window_end >= v_today - 1
     and run.finished_at >= pg_catalog.now() - interval '36 hours'
   order by run.finished_at desc nulls last, run.started_at desc
   limit 1;

  with unlinked_current as (
    select
      coalesce(
        nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), ''),
        nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '')
      ) as provider_entity_id,
      payment.id::text as local_entity_id,
      'PAYMENT_TENANT_OR_STUDENT_UNRESOLVED'::text as kind,
      case
        when upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
          'RECEIVED', 'RECEIVED_IN_CASH'
        ) then 'HIGH'::text
        else 'CRITICAL'::text
      end as severity,
      payment.value,
      payment.due_date,
      payment.status,
      'Sem aluno vinculado'::text as student_name,
      payment.updated_at as observed_at
    from public.student_payments as payment
    where payment.tenant_id = v_tenant_id
      and payment.student_id is null
      and upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
        'PENDING', 'OVERDUE', 'CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'
      )
  ),
  run_attention as (
    select
      issue.provider_entity_id,
      issue.local_entity_id,
      issue.kind,
      issue.severity,
      coalesce(
        payment.value,
        case
          when coalesce(issue.details ->> 'value', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            then (issue.details ->> 'value')::numeric
          else null
        end
      ) as value,
      coalesce(
        payment.due_date,
        case
          when coalesce(issue.details ->> 'dueDate', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            then (issue.details ->> 'dueDate')::date
          else null
        end
      ) as due_date,
      coalesce(payment.status, issue.details ->> 'providerStatus') as status,
      coalesce(
        nullif(pg_catalog.btrim(coalesce(student.full_name, '')), ''),
        'Sem aluno vinculado'
      ) as student_name,
      issue.observed_at
    from public.asaas_reconciliation_issues as issue
    left join public.student_payments as payment
      on payment.id::text = issue.local_entity_id
     and payment.tenant_id = v_tenant_id
    left join public.profiles as student
      on student.id = payment.student_id
     and student.tenant_id = payment.tenant_id
    where issue.run_id = v_latest_run_id
      and issue.tenant_id = v_tenant_id
      and issue.resolved_at is null
      and issue.severity in ('HIGH', 'CRITICAL')
      and issue.kind <> 'PAYMENT_TENANT_OR_STUDENT_UNRESOLVED'
  ),
  combined_attention as (
    select * from unlinked_current
    union all
    select * from run_attention
  ),
  current_attention as (
    select distinct on (
      coalesce(provider_entity_id, local_entity_id, kind)
    )
      provider_entity_id, local_entity_id, kind, severity, value, due_date,
      status, student_name, observed_at
    from combined_attention
    order by
      coalesce(provider_entity_id, local_entity_id, kind),
      case severity when 'CRITICAL' then 0 else 1 end,
      observed_at desc
  )
  select pg_catalog.jsonb_build_object(
    'run_id', v_latest_run_id,
    'observed_at', v_observed_at,
    'window_start', v_window_start,
    'window_end', v_window_end,
    'audit_available', v_latest_run_id is not null,
    'qtd', pg_catalog.count(*)::integer,
    'total', pg_catalog.round(coalesce(pg_catalog.sum(value), 0), 2),
    'itens', coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'referencia', case
          when provider_entity_id is null then '—'
          else '…' || pg_catalog.right(provider_entity_id, 8)
        end,
        'aluno', student_name,
        'valor', value,
        'vencimento', due_date,
        'status', status,
        'severidade', severity,
        'problema', case kind
          when 'PAYMENT_TENANT_OR_STUDENT_UNRESOLVED'
            then 'Pagamento sem aluno identificado'
          when 'PROVIDER_PAYMENT_DELETED_LOCAL_OPEN'
            then 'Cobrança excluída no Asaas ainda aberta aqui'
          when 'LOCAL_CREDIT_DATE_MISSING'
            then 'Data de crédito ainda não conciliada'
          when 'PAYMENT_STATUS_MISMATCH'
            then 'Situação do pagamento divergente'
          else pg_catalog.replace(kind, '_', ' ')
        end
      ) order by
        case severity when 'CRITICAL' then 0 else 1 end,
        case upper(coalesce(status, ''))
          when 'OVERDUE' then 0
          when 'PENDING' then 1
          when 'CONFIRMED' then 2
          else 3
        end,
        due_date nulls last,
        provider_entity_id
    ), '[]'::jsonb)
  )
  into v_payload
  from current_attention;

  return coalesce(
    v_payload,
    pg_catalog.jsonb_build_object(
      'audit_available', false,
      'qtd', 0, 'total', 0, 'itens', '[]'::jsonb
    )
  );
end;
$function$;

alter function public.asaas_reconciliation_attention() owner to postgres;
revoke all on function public.asaas_reconciliation_attention()
  from public, anon, authenticated, service_role;
grant execute on function public.asaas_reconciliation_attention()
  to authenticated, service_role;

do $attention_postcheck$
begin
  if pg_catalog.has_function_privilege(
       'anon', 'public.asaas_reconciliation_attention()', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated',
       'public.asaas_reconciliation_attention()',
       'EXECUTE'
     )
  then
    raise exception 'Asaas reconciliation attention boundary is unsafe';
  end if;
end;
$attention_postcheck$;

notify pgrst, 'reload schema';

commit;
