-- Guarda de agenda no fechamento pós-experimental (decisão da direção, 11/11/2026).
--
-- Antes: começar em até 7 dias depois da assinatura = sem taxa; mais tarde =
-- taxa de matrícula de R$ 49,90.
-- Agora:
--   * começa em até 7 dias  → taxa de matrícula de R$ 49,90;
--   * começa depois disso   → guarda de agenda de R$ 60 por mês de espera, com a
--     matrícula INCLUSA (não soma os R$ 49,90). Cada mês iniciado conta inteiro:
--     8 a 30 dias = R$ 60; 31 a 60 = R$ 120; 61 a 90 = R$ 180.
-- O valor sai de uma vez no link da matrícula (offers.enrollment_fee, a mesma
-- cobrança da taxa) e é recalculado no dia em que o aluno abre/assina o link.
--
-- Só o fechamento autônomo da Wise Wolf (private.trial_closing_flows com
-- start_date) é afetado; ofertas manuais da plataforma não mudam.
-- Reaplicável: funções com create or replace; patches por texto conferem se já
-- foram aplicados e abortam (derrubando o release) se a definição mudou.

create or replace function private.trial_closing_agenda_hold_months(p_start date, p_today date)
returns integer language sql immutable set search_path = '' as $$
  select case
    when p_start is null or p_today is null or p_start <= p_today + 7 then 0
    else pg_catalog.ceil((p_start - p_today)::numeric / 30)::integer
  end;
$$;

create or replace function private.trial_closing_enrollment_charge(p_start date, p_today date)
returns numeric language sql immutable set search_path = '' as $$
  select case
    when private.trial_closing_agenda_hold_months(p_start, p_today) = 0 then 49.90::numeric
    else (60 * private.trial_closing_agenda_hold_months(p_start, p_today))::numeric
  end;
$$;

revoke all on function private.trial_closing_agenda_hold_months(date, date) from public, anon, authenticated;
revoke all on function private.trial_closing_enrollment_charge(date, date) from public, anon, authenticated;

-- 1) A oferta nasce com o valor da regra nova e diz quantos meses de guarda tem.
do $patch_create_offer$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'private.trial_closing_create_offer(uuid,text)'::pg_catalog.regprocedure
  ) into v_definition;

  v_old := 'v_fee := case when v_start <= v_today + 7 then 0 else 49.90 end;';
  v_new := 'v_fee := private.trial_closing_enrollment_charge(v_start, v_today);';
  if pg_catalog.strpos(v_definition, v_new) = 0 then
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'trial_closing_create_offer: regra da taxa mudou; guarda de agenda não aplicada';
    end if;
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  end if;

  v_old := '''enrollmentFee'', v_fee';
  v_new := '''enrollmentFee'', v_fee, ''agendaHoldMonths'', private.trial_closing_agenda_hold_months(v_start, v_today)';
  if pg_catalog.strpos(v_definition, v_new) = 0 then
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'trial_closing_create_offer: payload da taxa mudou';
    end if;
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  end if;

  v_old := '''enrollment_fee'', v_fee';
  v_new := '''enrollment_fee'', v_fee, ''agenda_hold_months'', private.trial_closing_agenda_hold_months(v_start, v_today)';
  if pg_catalog.strpos(v_definition, v_new) = 0 then
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'trial_closing_create_offer: retorno da taxa mudou';
    end if;
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  end if;

  execute v_definition;
end;
$patch_create_offer$;

-- 2) A página e a assinatura recalculam pelo dia de hoje e gravam na oferta o
--    mesmo número que mostram (begin_enrollment_offer cobra offers.enrollment_fee).
create or replace function private.trial_closing_apply_enrollment_charge(p_offer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_start date;
  v_today date := (pg_catalog.clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_fee numeric;
  v_months integer;
begin
  select (flow.plan ->> 'start_date')::date into v_start
    from private.trial_closing_flows as flow
   where flow.offer_id = p_offer_id and flow.tenant_id = 'school-wise-wolf'
     and flow.plan ? 'start_date'
   limit 1;
  if v_start is null then return null; end if;
  v_months := private.trial_closing_agenda_hold_months(v_start, v_today);
  v_fee := private.trial_closing_enrollment_charge(v_start, v_today);
  update public.offers as offer
     set enrollment_fee = v_fee,
         payload = coalesce(offer.payload, '{}'::jsonb)
           || pg_catalog.jsonb_build_object('enrollmentFee', v_fee, 'agendaHoldMonths', v_months)
   where offer.id = p_offer_id
     and (offer.enrollment_fee is distinct from v_fee
          or offer.payload -> 'agendaHoldMonths' is distinct from pg_catalog.to_jsonb(v_months))
     and offer.consumed_at is null
     and offer.revoked_at is null
     and offer.processing_by is null;
  return pg_catalog.jsonb_build_object('enrollmentFee', v_fee, 'agendaHoldMonths', v_months);
end;
$$;
revoke all on function private.trial_closing_apply_enrollment_charge(uuid) from public, anon, authenticated;

create or replace function public.get_offer_public(p_offer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_result jsonb;
  v_charge jsonb;
begin
  v_result := public.get_offer_public_pre_trial_fee_impl(p_offer_id);
  if v_result ? 'error' then return v_result; end if;
  v_charge := private.trial_closing_apply_enrollment_charge(p_offer_id);
  if v_charge is not null then return v_result || v_charge; end if;
  return v_result;
end $function$;

create or replace function public.claim_enrollment_offer(p_offer_id uuid, p_profile jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_opportunity uuid;
begin
  if (select auth.uid()) is null then
    return pg_catalog.jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  end if;
  select offer.opportunity_id into v_opportunity from public.offers as offer where offer.id = p_offer_id;
  if v_opportunity is not null then
    perform 1 from public.opportunities as opportunity where opportunity.id = v_opportunity for update;
  end if;
  perform 1 from public.offers as offer where offer.id = p_offer_id for update;
  perform private.trial_closing_apply_enrollment_charge(p_offer_id);
  return public.claim_enrollment_offer_pre_trial_fee_impl(p_offer_id, p_profile);
end $function$;

alter function public.get_offer_public(uuid) owner to postgres;
alter function public.claim_enrollment_offer(uuid,jsonb) owner to postgres;
revoke all on function public.get_offer_public(uuid) from public, anon, authenticated;
revoke all on function public.claim_enrollment_offer(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.get_offer_public(uuid) to anon, authenticated;
grant execute on function public.claim_enrollment_offer(uuid,jsonb) to authenticated;
