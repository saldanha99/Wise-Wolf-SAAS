-- Devolve ao banco três travas que o fechamento autônomo da experimental
-- desfez quando foi aplicado direto no banco, fora do release (migrations
-- 20260923214500, 20260924042343 e 20260925024707, que não estão em
-- MIGRATION_RELATIVES). O release de 26/09 reverteu sozinho por causa delas:
-- a suíte SQL roda contra o banco de produção e três testes reprovavam.
--
-- 1. claim_enrollment_offer voltou a ter EXECUTE para authenticated. A porta
--    legada estava fechada desde 21/08 (invite_registration_security): o aluno
--    entra por begin_enrollment_offer e a conclusão passa por
--    complete_enrollment_offer no servidor. Nada no app chama
--    claim_enrollment_offer.
-- 2. get_offer_public voltou a ter EXECUTE para anon e authenticated. Desde
--    22/08 (private_tenant_legal_assets) ela só roda pelo servidor, porque
--    devolve o snapshot jurídico da escola; a página pública busca a oferta
--    pela edge tenant-legal-assets. Testes: private_tenant_legal_assets e
--    security_definer_authorization_hardening.
-- 3. trial_closing_overdue() e trial_closing_prepare_teacher_alternative()
--    usam pg_catalog.coalesce(...), que não existe (COALESCE é forma especial
--    do SQL). As duas quebram na primeira linha que executa: o aviso de
--    experimental sem resposta da professora e a troca de professora pararam
--    em silêncio — o funnel-sweeper guarda o erro em failures[] e responde 200.
--    Teste: wolfie_sql_special_forms_repair.
--
-- Reaplicável: revoke/grant são idempotentes; a reescrita só acontece se o
-- padrão ainda existir, e create or replace preserva dono e permissões.

do $grants$
begin
  if pg_catalog.to_regprocedure('public.claim_enrollment_offer(uuid,jsonb)') is not null then
    revoke all on function public.claim_enrollment_offer(uuid, jsonb)
      from public, anon, authenticated;
    grant execute on function public.claim_enrollment_offer(uuid, jsonb)
      to service_role;
  end if;

  if pg_catalog.to_regprocedure(
    'public.claim_enrollment_offer_pre_trial_fee_impl(uuid,jsonb)'
  ) is not null then
    revoke all on function public.claim_enrollment_offer_pre_trial_fee_impl(uuid, jsonb)
      from public, anon, authenticated;
  end if;

  if pg_catalog.to_regprocedure('public.get_offer_public(uuid)') is not null then
    revoke all on function public.get_offer_public(uuid)
      from public, anon, authenticated;
    grant execute on function public.get_offer_public(uuid)
      to service_role;
  end if;

  if pg_catalog.to_regprocedure(
    'public.get_offer_public_pre_trial_fee_impl(uuid)'
  ) is not null then
    revoke all on function public.get_offer_public_pre_trial_fee_impl(uuid)
      from public, anon, authenticated;
  end if;
end
$grants$;

do $special_forms$
declare
  v_signature text;
  v_oid oid;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.trial_closing_overdue()',
    'public.trial_closing_prepare_teacher_alternative(uuid,jsonb)'
  ] loop
    v_oid := pg_catalog.to_regprocedure(v_signature)::oid;
    if v_oid is null then
      continue;
    end if;

    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    if v_definition !~* 'pg_catalog[.](greatest|least|coalesce|nullif)[[:space:]]*[(]' then
      continue;
    end if;

    v_definition := pg_catalog.regexp_replace(
      v_definition,
      'pg_catalog[.](greatest|least|coalesce|nullif)([[:space:]]*[(])',
      '\1\2',
      'gi'
    );
    execute v_definition;
  end loop;
end
$special_forms$;
