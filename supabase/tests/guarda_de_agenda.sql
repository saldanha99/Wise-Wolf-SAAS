\set ON_ERROR_STOP on
-- Guarda de agenda (11/11/2026): até 7 dias = taxa de R$ 49,90; depois,
-- R$ 60 por mês iniciado de espera, matrícula inclusa. Só leitura de regra e
-- definição; roda em transação e não toca em oferta real.
begin;
create or replace function pg_temp.ga_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'guarda de agenda: %',m;end if;end$$;
do $test$
declare
  d date := date '2026-11-11';
  v_def text;
begin
  perform pg_temp.ga_assert(private.trial_closing_enrollment_charge(d, d) = 49.90, 'início hoje');
  perform pg_temp.ga_assert(private.trial_closing_enrollment_charge(d + 7, d) = 49.90, '7 dias');
  perform pg_temp.ga_assert(private.trial_closing_agenda_hold_months(d + 7, d) = 0, '7 dias sem guarda');
  perform pg_temp.ga_assert(private.trial_closing_enrollment_charge(d + 8, d) = 60, '8 dias');
  perform pg_temp.ga_assert(private.trial_closing_enrollment_charge(d + 30, d) = 60, '30 dias');
  perform pg_temp.ga_assert(private.trial_closing_enrollment_charge(d + 31, d) = 120, '31 dias');
  perform pg_temp.ga_assert(private.trial_closing_enrollment_charge(d + 60, d) = 120, '2 meses');
  perform pg_temp.ga_assert(private.trial_closing_enrollment_charge(d + 61, d) = 180, '61 dias');
  perform pg_temp.ga_assert(private.trial_closing_agenda_hold_months(d + 60, d) = 2, 'meses de 2 meses');
  perform pg_temp.ga_assert(private.trial_closing_enrollment_charge(null, d) = 49.90, 'sem data');

  select pg_catalog.pg_get_functiondef('private.trial_closing_create_offer(uuid,text)'::regprocedure) into v_def;
  perform pg_temp.ga_assert(strpos(v_def, 'private.trial_closing_enrollment_charge(v_start, v_today)') > 0, 'oferta não usa a regra nova');
  perform pg_temp.ga_assert(strpos(v_def, '''agendaHoldMonths''') > 0, 'oferta não grava os meses de guarda');
  perform pg_temp.ga_assert(strpos(v_def, 'then 0 else 49.90') = 0, 'regra antiga ainda na oferta');

  select pg_catalog.pg_get_functiondef('public.get_offer_public(uuid)'::regprocedure) into v_def;
  perform pg_temp.ga_assert(strpos(v_def, 'trial_closing_apply_enrollment_charge') > 0, 'página não recalcula');
  select pg_catalog.pg_get_functiondef('public.claim_enrollment_offer(uuid,jsonb)'::regprocedure) into v_def;
  perform pg_temp.ga_assert(strpos(v_def, 'trial_closing_apply_enrollment_charge') > 0, 'assinatura não recalcula');
  perform pg_temp.ga_assert(strpos(v_def, 'set enrollment_fee = 0') = 0, 'assinatura ainda zera a taxa');

  -- Oferta inexistente: sem fluxo, não faz nada.
  perform pg_temp.ga_assert(private.trial_closing_apply_enrollment_charge(gen_random_uuid()) is null, 'oferta inexistente');
end
$test$;
rollback;
