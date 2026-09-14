-- Cobertura de mensalidade não quita matrícula, multa, material ou aula extra.
-- Autoridade financeira continua no banco; perfil legado não é sobrescrito.
create or replace function private.payment_is_tuition(p_type text, p_description text)
returns boolean language sql immutable set search_path = '' as $$
  select upper(btrim(coalesce(p_type, ''))) in ('SUBSCRIPTION', 'MONTHLY', 'TUITION')
    and not private.payment_is_enrollment_fee(p_type, p_description)
    and lower(translate(btrim(coalesce(p_description, '')),
      'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇç',
      'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc'))
      !~ '(^|[^a-z])(taxa|multa|cancelamento|extra|extras|material|reposicao)([^a-z]|$)'
$$;
alter function private.payment_is_tuition(text, text) owner to postgres;
revoke all on function private.payment_is_tuition(text, text) from public, anon, authenticated, service_role;

create or replace function private.student_payment_prepayment_state(p_payment uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when private.student_month_prepayment_review(p.student_id, p.due_date) then 'REVIEW'
    when private.student_month_covered(p.student_id, p.due_date) then 'COVERED'
    else null end
  from public.student_payments p
  join public.profiles s on s.id = p.student_id and s.tenant_id = p.tenant_id
  where p.id = p_payment
    and private.payment_is_tuition(p.payment_type, p.description)
$$;
alter function private.student_payment_prepayment_state(uuid) owner to postgres;
revoke all on function private.student_payment_prepayment_state(uuid) from public, anon, authenticated, service_role;

create or replace function private.student_payment_is_covered(p_payment uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.student_payment_prepayment_state(p_payment) = 'COVERED', false)
$$;
alter function private.student_payment_is_covered(uuid) owner to postgres;
revoke all on function private.student_payment_is_covered(uuid) from public, anon, authenticated, service_role;

-- Contexto limitado a um aluno por vez. Nenhum identificador do provedor,
-- segredo, documento pessoal ou telefone é exposto por esta nova interface.
create or replace function public.get_prepayment_management_context(
  p_tenant text, p_student uuid default null, p_search text default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := nullif(btrim(p_tenant), '');
  v_search text := left(btrim(coalesce(p_search, '')), 100);
  v_students jsonb;
  v_payments jsonb := '[]'::jsonb;
  v_allocations jsonb := '[]'::jsonb;
  v_history jsonb := '[]'::jsonb;
  v_more boolean;
  v_settings jsonb := jsonb_build_object('enabled', false, 'starts_on', null);
begin
  if not private.prepayment_caller_can_write(v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  if not exists(select 1 from public.tenants where id = v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'escola_nao_encontrada');
  end if;
  if p_student is not null and not exists (
    select 1 from public.profiles where id = p_student and tenant_id = v_tenant and role = 'STUDENT'
  ) then
    return jsonb_build_object('ok', false, 'error', 'aluno_de_outra_escola');
  end if;

  with matches as (
    select p.id, p.full_name,
      row_number() over(order by p.full_name, p.id) as position
    from public.profiles p
    where p.tenant_id = v_tenant and p.role = 'STUDENT'
      and (v_search = '' or position(lower(v_search) in lower(coalesce(p.full_name, ''))) > 0)
      and coalesce(p.is_test_account, false) is false and p.test_fixture_key is null
    order by p.full_name, p.id limit 101
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'full_name', full_name)
    order by full_name, id) filter(where position <= 100), '[]'::jsonb), count(*) > 100
  into v_students, v_more from matches;

  if p_student is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'student_id', p.student_id, 'value', p.value, 'status', p.status,
      'due_date', p.due_date,
      'received_on', coalesce((p.paid_at at time zone 'America/Sao_Paulo')::date, p.payment_date),
      'description', p.description,
      'registration_allowed', eligibility.block_reason is null,
      'registration_block_reason', eligibility.block_reason,
      'payment_review_reason', source.review_reason,
      'monthly_allowed', eligibility.block_reason is null
        and (notice.status is null or notice.status in ('PENDING', 'SUPPRESSED', 'FAILED')),
      'monthly_block_reason', coalesce(eligibility.block_reason, case
        when notice.status is not null and notice.status not in ('PENDING', 'SUPPRESSED', 'FAILED')
          then 'aviso_do_rateio_ja_saiu' else null end)
    ) order by p.due_date desc nulls last, p.id), '[]'::jsonb)
    into v_payments from public.student_payments p
    left join public.management_payment_notification_outbox notice
      on notice.tenant_id = p.tenant_id and notice.payment_id = p.id and notice.notification_kind = 'PAYMENT_SPLIT'
    cross join lateral (select private.prepayment_payment_review_reason(p.id) as review_reason) source
    cross join lateral (select case
      when source.review_reason is not null then 'pagamento_requer_revisao'
      when exists(select 1 from public.student_payment_allocations a where a.payment_id = p.id and a.status = 'REVIEW')
        then 'pagamento_completo_em_revisao'
      when exists(select 1 from public.student_payment_allocations a where a.payment_id = p.id and a.status = 'ACTIVE')
        then 'pagamento_ja_tem_parcelas'
      when (notice.source_snapshot->>'modo' = 'MENSAL'
          and (coalesce(notice.submit_attempt_count, 0) > 0 or notice.status = 'PREPARED'))
        or exists(select 1 from public.management_reserve_notification_outbox r
          join public.student_payment_allocations a on a.id = r.allocation_id
          where a.payment_id = p.id and r.submit_attempt_count > 0)
        then 'parcelamento_mensal_ja_avisado_requer_reconciliacao'
      else null end as block_reason) eligibility
    where p.tenant_id = v_tenant and p.student_id = p_student
      and p.status in ('RECEIVED', 'RECEIVED_IN_CASH')
      and coalesce(p.refunded_amount, 0) = 0 and p.value > 0
      and private.payment_is_tuition(p.payment_type, p.description);

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'grupo_id', a.grupo_id, 'registration_id', a.registration_id,
      'payment_id', a.payment_id, 'student_id', a.student_id, 'competencia', a.competencia,
      'sequencia', a.sequencia, 'meses', a.meses, 'valor', a.valor, 'modo', a.modo,
      'origem', a.origem, 'recebido_em', a.recebido_em, 'observacao', a.observacao,
      'status', case when a.status = 'ACTIVE' and not validity.is_valid then 'REVIEW' else a.status end,
      'stored_status', a.status, 'is_valid', validity.is_valid,
      'status_reason', case when a.status = 'ACTIVE' and not validity.is_valid
        then coalesce(private.prepayment_payment_review_reason(a.payment_id), 'PAYMENT_SOURCE_CHANGED')
        else a.status_reason end,
      'created_at', a.created_at, 'cancelled_at', a.cancelled_at
    ) order by a.created_at desc, a.registration_id, a.sequencia), '[]'::jsonb)
    into v_allocations from public.student_payment_allocations a
    cross join lateral (select private.prepayment_allocation_is_valid(a.id) as is_valid) validity
    where a.tenant_id = v_tenant and a.student_id = p_student;

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'action', e.event_type, 'occurred_at', e.occurred_at,
      'actor_name', coalesce(actor.full_name, 'Sistema'), 'reason', e.reason,
      'grupo_id', e.grupo_id, 'registration_id', e.registration_id,
      'allocation_id', e.allocation_id
    ) order by e.occurred_at desc, e.id), '[]'::jsonb)
    into v_history
    from (select * from private.prepayment_allocation_events
      where tenant_id = v_tenant and student_id = p_student order by occurred_at desc, id limit 200) e
    left join public.profiles actor on actor.id = e.actor_id;
  end if;

  select jsonb_build_object('enabled', s.enabled, 'starts_on', s.starts_on)
  into v_settings from public.monthly_reserve_notification_settings s where s.tenant_id = v_tenant;

  return jsonb_build_object('ok', true, 'can_write', true,
    'students', v_students, 'has_more_students', v_more,
    'payments', v_payments, 'allocations', v_allocations, 'history', v_history,
    'notification_settings', coalesce(v_settings, jsonb_build_object('enabled', false, 'starts_on', null)));
end;
$$;
alter function public.get_prepayment_management_context(text, uuid, text) owner to postgres;
revoke all on function public.get_prepayment_management_context(text, uuid, text) from public, anon;
grant execute on function public.get_prepayment_management_context(text, uuid, text) to authenticated, service_role;

-- Definições capturadas da produção em 14/09; preservam contratos e guardas.
CREATE OR REPLACE FUNCTION public.list_students_overview()
 RETURNS TABLE(student_id uuid, full_name text, avatar_url text, module text, professor_id uuid, professor_name text, monthly_fee numeric, status_financial text, phone text, is_kids boolean, attended_90 integer, absent_90 integer, attendance_rate integer, last_class_date date, days_since_last integer, overdue_count integer, overdue_value numeric, xp integer, streak_count integer, last_activity timestamp with time zone, risk_level text, risk_score integer, risk_reasons text[], has_activity boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = v_uid;
  IF v_role IS NULL OR NOT private.can_execute_legacy_role_rpc(ARRAY['SCHOOL_ADMIN','SUPER_ADMIN','TEACHER']::text[]) THEN RETURN; END IF;
  RETURN QUERY
  WITH students AS (
    SELECT p.* FROM profiles p WHERE p.role = 'STUDENT'
      AND (v_role='SUPER_ADMIN'
        OR (v_role='SCHOOL_ADMIN' AND p.tenant_id=v_tenant)
        OR (v_role='TEACHER' AND (p.professor_id=v_uid OR p.professor_id2=v_uid
             OR EXISTS (SELECT 1 FROM bookings b WHERE b.student_id=p.id AND b.teacher_id=v_uid))))
  ),
  freq AS (
    SELECT cl.student_id,
      count(*) FILTER (WHERE cl.presence='COMPLETED' AND cl.class_date>=current_date-90) AS att90,
      count(*) FILTER (WHERE cl.presence='STUDENT_ABSENCE' AND cl.class_date>=current_date-90) AS abs90,
      count(*) FILTER (WHERE cl.presence='STUDENT_ABSENCE' AND cl.class_date>=current_date-45) AS abs45,
      max(cl.class_date) FILTER (WHERE cl.presence IN ('COMPLETED','STUDENT_ABSENCE')) AS last_cd
    FROM class_logs cl WHERE cl.student_id IN (SELECT id FROM students) GROUP BY cl.student_id
  ),
  pay AS (
    SELECT sp.student_id, count(*) FILTER (WHERE sp.status='OVERDUE') AS od_count,
      coalesce(sum(sp.value) FILTER (WHERE sp.status='OVERDUE'),0) AS od_value
    FROM student_payments sp WHERE sp.student_id IN (SELECT id FROM students)
      AND NOT private.student_payment_is_covered(sp.id)
      AND private.student_payment_prepayment_state(sp.id) IS DISTINCT FROM 'REVIEW'
    GROUP BY sp.student_id
  ),
  base AS (
    SELECT s.id, s.full_name, s.avatar_url, s.module, s.professor_id,
      s.monthly_fee, s.status_financial, s.phone, coalesce(s.is_kids,false) AS is_kids,
      coalesce(f.att90,0) AS att90, coalesce(f.abs90,0) AS abs90, coalesce(f.abs45,0) AS abs45,
      CASE WHEN coalesce(f.att90,0)+coalesce(f.abs90,0)>0 THEN round(100.0*f.att90/(f.att90+f.abs90))::int END AS rate,
      f.last_cd,
      CASE WHEN f.last_cd IS NOT NULL THEN (current_date-f.last_cd) END AS dsl,
      coalesce(pp.od_count,0) AS od_count, coalesce(pp.od_value,0) AS od_value,
      coalesce(s.xp,0) AS xp, coalesce(s.streak_count,0) AS streak, s.last_activity, s.offboarding_status,
      (EXISTS (SELECT 1 FROM bookings b WHERE b.student_id=s.id)
        OR EXISTS (SELECT 1 FROM student_payments sp2 WHERE sp2.student_id=s.id)) AS has_activity
    FROM students s LEFT JOIN freq f ON f.student_id=s.id LEFT JOIN pay pp ON pp.student_id=s.id
  ),
  scored AS (
    SELECT b.*,
      ((b.od_count>0)::int + (b.abs45>=2)::int + (b.offboarding_status IS NOT NULL AND b.offboarding_status<>'')::int) AS strong,
      ((b.dsl>30)::int + ((b.att90+b.abs90)>=4 AND b.rate<60)::int) AS weak,
      array_remove(ARRAY[
        CASE WHEN b.od_count>0 THEN 'Pagamento em atraso' END,
        CASE WHEN b.abs45>=2 THEN b.abs45||' faltas recentes' END,
        CASE WHEN b.offboarding_status IS NOT NULL AND b.offboarding_status<>'' THEN 'Saída solicitada' END,
        CASE WHEN b.dsl>30 THEN 'Inativo há '||b.dsl||' dias' END,
        CASE WHEN (b.att90+b.abs90)>=4 AND b.rate<60 THEN 'Frequência baixa ('||b.rate||'%)' END
      ], NULL) AS reasons
    FROM base b
  )
  SELECT sc.id, sc.full_name, sc.avatar_url, sc.module, sc.professor_id,
    (SELECT pr.full_name FROM profiles pr WHERE pr.id=sc.professor_id),
    sc.monthly_fee, CASE
      WHEN private.student_month_prepayment_review(sc.id, current_date) THEN 'PENDING'
      WHEN sc.od_count = 0 AND private.student_month_covered(sc.id, current_date) THEN 'ACTIVE'
      ELSE sc.status_financial END, sc.phone, sc.is_kids,
    sc.att90::int, sc.abs90::int, sc.rate, sc.last_cd, sc.dsl::int,
    sc.od_count::int, sc.od_value, sc.xp::int, sc.streak::int, sc.last_activity,
    CASE WHEN sc.strong>=2 OR (sc.strong>=1 AND sc.weak>=1) THEN 'HIGH'
         WHEN sc.strong=1 OR sc.weak>=2 THEN 'MEDIUM' ELSE 'LOW' END,
    (sc.strong*2+sc.weak)::int,
    CASE WHEN (sc.strong>=1 OR sc.weak>=2) THEN sc.reasons ELSE ARRAY[]::text[] END,
    sc.has_activity
  FROM scored sc
  ORDER BY (sc.strong*2+sc.weak) DESC, sc.full_name;
END;
$function$;


alter function public.list_students_overview() owner to postgres;
revoke all on function public.list_students_overview() from public, anon;
grant execute on function public.list_students_overview() to authenticated;

CREATE OR REPLACE FUNCTION public.generate_monthly_student_payments(p_tenant_id text, p_period_start date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  period_start date := date_trunc('month', p_period_start)::date;
  period_end date := (
    date_trunc('month', p_period_start) + interval '1 month'
  )::date;
  candidate record;
  locked_student record;
  payment_due_date date;
  inserted_count integer := 0;
  eligible_count integer := 0;
  inserted_now integer := 0;
  period_claim public.asaas_student_billing_period_claims%rowtype;
  period_source_key text;
  monthly_provider_id text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if normalized_tenant is null or p_period_start is null then
    raise exception using
      errcode = '22023',
      message = 'tenant_and_period_required';
  end if;
  if not exists (
    select 1 from public.tenants as tenant
     where tenant.id = normalized_tenant
  ) then
    raise exception using errcode = '23503', message = 'tenant_not_found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'monthly-student-payments:' || normalized_tenant || ':' ||
        period_start::text,
      0
    )
  );

  for candidate in
    select student.id
      from public.profiles as student
      join public.tenant_memberships as membership
        on membership.user_id = student.id
       and membership.tenant_id = normalized_tenant
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
     where student.role = 'STUDENT'
       and student.tenant_id = normalized_tenant
       and student.status = 'Ativo'
       and lower(trim(coalesce(student.lifecycle_status, ''))) = 'active'
       and coalesce(student.monthly_fee, 0) > 0
     order by student.id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-lifecycle:' || normalized_tenant || ':' ||
          candidate.id::text,
        0
      )
    );

    select
      student.id,
      student.monthly_fee,
      student.due_day
    into locked_student
      from public.profiles as student
      join public.tenant_memberships as membership
        on membership.user_id = student.id
       and membership.tenant_id = normalized_tenant
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
     where student.id = candidate.id
       and student.role = 'STUDENT'
       and student.tenant_id = normalized_tenant
       and student.status = 'Ativo'
       and lower(trim(coalesce(student.lifecycle_status, ''))) = 'active'
       and coalesce(student.monthly_fee, 0) > 0
       and (
         select count(*)
           from public.tenant_memberships as exact_membership
          where exact_membership.user_id = student.id
       ) = 1
       and not exists (
         select 1
           from public.student_offboarding_operations as operation
          where operation.tenant_id = normalized_tenant
            and operation.student_id = student.id
            and operation.status in (
              'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
              'UNKNOWN', 'BLOCKED'
            )
       )
       and not exists (
         select 1
           from public.student_account_deletion_claims as deletion
          where deletion.tenant_id = normalized_tenant
            and deletion.student_id = student.id
            and deletion.status in (
              'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
              'UNKNOWN', 'BLOCKED'
            )
       )
     for update of student, membership;
    if not found then
      continue;
    end if;

    eligible_count := eligible_count + 1;
    -- Compartilha a trava com cadastro/cancelamento da cobertura.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('student-payment-allocation:' || locked_student.id::text, 0)
    );
    if private.student_month_covered(locked_student.id, period_start)
       or private.student_month_prepayment_review(locked_student.id, period_start) then
      continue;
    end if;
    payment_due_date := make_date(
      extract(year from period_start)::integer,
      extract(month from period_start)::integer,
      least(
        greatest(coalesce(locked_student.due_day, 10), 1),
        extract(day from (period_end - interval '1 day'))::integer
      )
    );

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-period-month:' || normalized_tenant || ':' ||
          locked_student.id::text || ':' || period_start::text,
        0
      )
    );

    if exists (
      select 1
        from public.student_payments as existing
       where existing.student_id = locked_student.id
         and existing.tenant_id = normalized_tenant
         and existing.due_date >= period_start
         and existing.due_date < period_end
    ) then
      continue;
    end if;
    if exists (
      select 1
        from public.asaas_student_billing_period_claims as billing_claim
       where billing_claim.tenant_id = normalized_tenant
         and billing_claim.student_id = locked_student.id
         and billing_claim.due_date >= period_start
         and billing_claim.due_date < period_end
    ) then
      continue;
    end if;

    period_source_key := 'monthly-ledger:' || locked_student.id::text || ':' ||
      to_char(period_start, 'YYYY-MM');
    monthly_provider_id := 'MANUAL_MONTHLY_' ||
      to_char(period_start, 'YYYYMM') || '_' ||
      replace(locked_student.id::text, '-', '');

    insert into public.asaas_student_billing_period_claims (
      tenant_id,
      student_id,
      due_date,
      source,
      source_key,
      request_fingerprint,
      status,
      claim_token,
      lease_expires_at,
      provider_entity_id,
      updated_at
    ) values (
      normalized_tenant,
      locked_student.id,
      payment_due_date,
      'MONTHLY_LEDGER',
      period_source_key,
      pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(
            period_source_key || ':' || locked_student.monthly_fee::text,
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ),
      'BOUND',
      gen_random_uuid(),
      now(),
      monthly_provider_id,
      now()
    ) on conflict (tenant_id, student_id, due_date) do nothing;

    select billing_claim.* into period_claim
      from public.asaas_student_billing_period_claims as billing_claim
     where billing_claim.tenant_id = normalized_tenant
       and billing_claim.student_id = locked_student.id
       and billing_claim.due_date = payment_due_date
     for update;
    if not found
       or period_claim.source is distinct from 'MONTHLY_LEDGER'
       or period_claim.source_key is distinct from period_source_key
       or period_claim.status is distinct from 'BOUND'
       or period_claim.provider_entity_id is distinct from monthly_provider_id
    then
      continue;
    end if;

    insert into public.student_payments (
      student_id,
      tenant_id,
      value,
      amount_cents,
      due_date,
      status,
      billing_type,
      asaas_payment_id,
      automation_key,
      description,
      created_at,
      updated_at
    )
    select
      locked_student.id,
      normalized_tenant,
      locked_student.monthly_fee,
      round(locked_student.monthly_fee * 100)::integer,
      payment_due_date,
      case when current_date > payment_due_date then 'OVERDUE' else 'PENDING' end,
      'MANUAL',
      monthly_provider_id,
      'monthly:' || normalized_tenant || ':' || locked_student.id::text || ':' ||
        to_char(period_start, 'YYYY-MM'),
      'Mensalidade ' || to_char(period_start, 'MM/YYYY'),
      now(),
      now()
     where not exists (
       select 1
         from public.student_payments as existing
        where existing.student_id = locked_student.id
          and existing.tenant_id = normalized_tenant
          and existing.due_date >= period_start
          and existing.due_date < period_end
     )
    on conflict (automation_key) where automation_key is not null do nothing;
    get diagnostics inserted_now = row_count;
    inserted_count := inserted_count + inserted_now;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'tenant_id', normalized_tenant,
    'period_start', period_start,
    'eligible', eligible_count,
    'created', inserted_count,
    'skipped', greatest(eligible_count - inserted_count, 0)
  );
end;
$function$;


alter function public.generate_monthly_student_payments(text,date) owner to postgres;
revoke all on function public.generate_monthly_student_payments(text,date) from public, anon, authenticated;
grant execute on function public.generate_monthly_student_payments(text,date) to service_role;

CREATE OR REPLACE FUNCTION public.recompute_student_financial_status_pre_lifecycle_impl(p_tenant_id text, p_student_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_tenant text := nullif(
    pg_catalog.btrim(coalesce(p_tenant_id, '')),
    ''
  );
  profile_row public.profiles%rowtype;
  controlling_due_date date;
  derived_status text;
  payment_snapshot jsonb;
  previous_derivation public.student_financial_status_audit%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if normalized_tenant is null or p_student_id is null then
    raise exception 'invalid_student_financial_scope' using errcode = '22023';
  end if;

  -- This row lock serializes different payment webhooks for one student. The
  -- payment snapshots themselves have already committed before this RPC runs.
  select profile.*
    into profile_row
    from public.profiles as profile
   where profile.id = p_student_id
   for update;

  if profile_row.id is null then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'PROFILE_MISSING'
    );
  end if;
  if profile_row.tenant_id is distinct from normalized_tenant
     or profile_row.role is distinct from 'STUDENT'
  then
    raise exception 'student_financial_scope_mismatch' using errcode = '42501';
  end if;
  if pg_catalog.lower(pg_catalog.btrim(coalesce(
       profile_row.lifecycle_status,
       ''
     ))) <> 'active'
     or pg_catalog.upper(pg_catalog.btrim(coalesce(
       profile_row.status_financial,
       ''
     ))) = 'ARCHIVED'
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'PRESERVED',
      'status', profile_row.status_financial
    );
  end if;

  select pg_catalog.max(payment.due_date)
    into controlling_due_date
    from public.student_payments as payment
   where payment.tenant_id = normalized_tenant
     and payment.student_id = p_student_id
     and payment.due_date is not null
     and payment.due_date <= current_date
     and pg_catalog.upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
       'OVERDUE',
       'RECEIVED',
       'RECEIVED_IN_CASH',
       'PAGO',
       'PAYMENT_RECEIVED',
       'PAYMENT_RECEIVED_IN_CASH',
       'REFUNDED',
       'REVERSED'
     );

  -- Uma parcela válida do mês também é evidência de competência, sem criar
  -- recebimento novo nem alterar mensalidade/paid_through legado.
  select greatest(controlling_due_date, max(a.competencia))
    into controlling_due_date
    from public.student_payment_allocations a
   where a.tenant_id = normalized_tenant and a.student_id = p_student_id
     and a.competencia <= current_date
     and a.status in ('ACTIVE', 'REVIEW');

  if controlling_due_date is null then
    select * into previous_derivation
      from public.student_financial_status_audit
     where tenant_id = normalized_tenant and student_id = p_student_id
     order by created_at desc, id desc limit 1;
    -- Só revoga o ACTIVE que esta rotina comprovadamente derivou da cobertura
    -- agora cancelada. Um status manual/legado sem essa evidência é preservado.
    if profile_row.status_financial = 'ACTIVE'
       and previous_derivation.derived_status = 'ACTIVE'
       and exists (
         select 1 from jsonb_array_elements(previous_derivation.payment_snapshot) evidence
         join public.student_payment_allocations a
           on a.id::text = evidence->>'allocation_id'
         where a.tenant_id = normalized_tenant and a.student_id = p_student_id
           and a.status = 'CANCELLED' and evidence->>'valid' = 'true'
       ) then
      derived_status := 'PENDING';
      controlling_due_date := previous_derivation.controlling_due_date;
      payment_snapshot := jsonb_build_array(jsonb_build_object(
        'reason', 'LAST_DERIVED_PREPAYMENT_CANCELLED',
        'previous_audit_id', previous_derivation.id));
    else
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'NO_MATURED_PAYMENT',
        'status', profile_row.status_financial
      );
    end if;
  end if;

  if derived_status is null then
  select
    case
      when private.student_month_prepayment_review(p_student_id, controlling_due_date)
        then 'PENDING'
      -- Multiple legacy rows may share a competence. Never clear a proven
      -- outstanding charge merely because another row on that day settled.
      when pg_catalog.bool_or(
        pg_catalog.upper(pg_catalog.btrim(coalesce(payment.status, ''))) =
          'OVERDUE' and not private.student_payment_is_covered(payment.id)
      ) then 'OVERDUE'
      when private.student_month_covered(p_student_id, controlling_due_date)
        or pg_catalog.bool_or(
        pg_catalog.upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
          'RECEIVED',
          'RECEIVED_IN_CASH',
          'PAGO',
          'PAYMENT_RECEIVED',
          'PAYMENT_RECEIVED_IN_CASH'
        )
      ) then 'ACTIVE'
      when pg_catalog.bool_or(
        pg_catalog.upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
          'REFUNDED',
          'REVERSED'
        )
      ) then 'PENDING'
      -- CREATED/CONFIRMED/PENDING and the manual NAO_RECEITA accounting
      -- classification are not proof that a tuition payment granted access.
      else null
    end,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', payment.id,
        'providerPaymentId', payment.asaas_payment_id,
        'status', payment.status,
        'providerStatus', payment.provider_status
      ) order by payment.id
    )
    into derived_status, payment_snapshot
    from public.student_payments as payment
   where payment.tenant_id = normalized_tenant
     and payment.student_id = p_student_id
     and payment.due_date = controlling_due_date;
  end if;

  if derived_status is null then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'NO_DECISIVE_CHANGE',
      'status', profile_row.status_financial,
      'controlling_due_date', controlling_due_date
    );
  end if;

  if pg_catalog.upper(pg_catalog.btrim(coalesce(
       profile_row.status_financial,
       ''
     ))) = derived_status
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'UNCHANGED',
      'status', derived_status,
      'controlling_due_date', controlling_due_date
    );
  end if;

  insert into public.student_financial_status_audit (
    tenant_id,
    student_id,
    previous_status,
    derived_status,
    controlling_due_date,
    payment_snapshot
  ) values (
    normalized_tenant,
    p_student_id,
    profile_row.status_financial,
    derived_status,
    controlling_due_date,
    coalesce(payment_snapshot, '[]'::jsonb) || (
      select coalesce(jsonb_agg(jsonb_build_object('allocation_id', a.id,
        'competencia', a.competencia, 'status', a.status,
        'valid', private.prepayment_allocation_is_valid(a.id))), '[]'::jsonb)
      from public.student_payment_allocations a where a.student_id = p_student_id
        and a.tenant_id = normalized_tenant
        and a.competencia = date_trunc('month', controlling_due_date)::date
        and a.status in ('ACTIVE', 'REVIEW')
    )
  );

  update public.profiles as profile
     set status_financial = derived_status
   where profile.id = p_student_id
     and profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
     and pg_catalog.lower(pg_catalog.btrim(coalesce(
       profile.lifecycle_status,
       ''
     ))) = 'active'
     and pg_catalog.upper(pg_catalog.btrim(coalesce(
       profile.status_financial,
       ''
     ))) <> 'ARCHIVED';

  if not found then
    raise exception 'student_financial_profile_changed_during_recompute'
      using errcode = '40001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'UPDATED',
    'status', derived_status,
    'controlling_due_date', controlling_due_date
  );
end;
$function$;


alter function public.recompute_student_financial_status_pre_lifecycle_impl(text,uuid) owner to postgres;
revoke all on function public.recompute_student_financial_status_pre_lifecycle_impl(text,uuid) from public, anon, authenticated;
grant execute on function public.recompute_student_financial_status_pre_lifecycle_impl(text,uuid) to service_role;
