-- Pró-rata só até o fim do mês anterior ao da 1ª mensalidade.
--
-- Caso Miguel (16/11/2026): início ter 17/11 (ter e sex), vencimento dia 5.
-- A conta antiga cobrava toda aula antes do 1º vencimento (05/12): 17, 20, 24,
-- 27/11, 01 e 04/12. A direção decidiu que a mensalidade de 05/12 paga dezembro
-- inteiro, então o pró-rata cobre só as aulas de novembro (4).
--
-- Regra: intervalo [início, 1º dia do mês da 1ª mensalidade). Começar no mesmo
-- mês da 1ª mensalidade = sem pró-rata. A tela (lib/enrollmentOffer.ts) faz a
-- mesma conta; o banco é quem vale. Ofertas já criadas não mudam (o valor fica
-- congelado no payload). Remendo por âncora em private.prepare_enrollment_offer_payload.
--
-- ⚠️ proRataIntervalEndExclusive continua sendo a data do 1º vencimento: a
-- conclusão da matrícula (complete_enrollment_offer_*) confere esse campo contra
-- firstBillingDate como impressão digital da oferta. Só a CONTAGEM mudou.

do $$
declare
  v_def text;
  v_count_anchor text := E'    v_first_billing_date - 1,\n    interval ''1 day''';
  v_count_patch text := E'    -- prorata_ate_o_fim_do_mes_anterior\n    pg_catalog.date_trunc(''month'', v_first_billing_date)::date - 1,\n    interval ''1 day''';
begin
  v_def := pg_get_functiondef('private.prepare_enrollment_offer_payload(jsonb,text)'::regprocedure);
  if position('prorata_ate_o_fim_do_mes_anterior' in v_def) > 0 then
    return;
  end if;
  if position(v_count_anchor in v_def) = 0 then
    raise exception 'ancora_de_prepare_enrollment_offer_payload_nao_encontrada';
  end if;
  v_def := replace(v_def, v_count_anchor, v_count_patch);
  execute v_def;
end;
$$;
