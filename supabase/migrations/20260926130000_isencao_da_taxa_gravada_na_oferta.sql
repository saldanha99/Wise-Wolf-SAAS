-- A isenção da taxa de matrícula do fechamento autônomo da experimental passa
-- a valer na COBRANÇA, não só na tela.
--
-- O patch de 23/09 (20260923214500, aplicado fora do release) isenta a taxa
-- quando o início das aulas está a até 7 dias: get_offer_public MOSTRA a taxa
-- zero, e claim_enrollment_offer GRAVA a taxa zero na oferta. Só que o aluno
-- assina por begin_enrollment_offer, que lê offers.enrollment_fee e nunca
-- passa pela claim_enrollment_offer — a página diria "sem taxa" e a cobrança
-- sairia com R$ 49,90. Medido em 26/09/2026: 1 oferta nessa situação (início
-- 05/10, ainda não assinada), que passaria a divergir a partir de 28/09.
--
-- Conserto: a mesma rotina que mostra a isenção grava a isenção na oferta,
-- antes de a assinatura começar (processing_by nulo). O que a página mostra e
-- o que a cobrança lê passam a ser o mesmo número.
--
-- Só age onde o patch existe (get_offer_public_pre_trial_fee_impl e
-- private.trial_closing_flows); num banco sem ele, não faz nada.
-- Reaplicável: create or replace preserva dono e permissões.

do $fee$
begin
  if pg_catalog.to_regprocedure('public.get_offer_public_pre_trial_fee_impl(uuid)') is null
     or pg_catalog.to_regclass('private.trial_closing_flows') is null then
    return;
  end if;

  execute $function$
create or replace function public.get_offer_public(p_offer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $body$
declare
  v_result jsonb;
  v_start date;
  v_today date := (pg_catalog.clock_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
  v_result := public.get_offer_public_pre_trial_fee_impl(p_offer_id);
  if v_result ? 'error' then return v_result; end if;
  select (flow.plan ->> 'start_date')::date into v_start
    from private.trial_closing_flows as flow
   where flow.offer_id = p_offer_id and flow.plan ? 'start_date'
   limit 1;
  if v_start is not null and v_start <= v_today + 7 then
    -- A cobrança lê offers.enrollment_fee (begin_enrollment_offer): grava a
    -- isenção que a página está mostrando, enquanto a assinatura não começou.
    update public.offers as offer
       set enrollment_fee = 0,
           payload = pg_catalog.jsonb_set(coalesce(offer.payload, '{}'::jsonb),
             '{enrollmentFee}', '0'::jsonb, true)
     where offer.id = p_offer_id
       and offer.enrollment_fee > 0
       and offer.consumed_at is null
       and offer.revoked_at is null
       and offer.processing_by is null;
    return v_result || pg_catalog.jsonb_build_object('enrollmentFee', 0);
  end if;
  return v_result;
end $body$;
$function$;
end
$fee$;
