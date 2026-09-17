-- A assinatura criada pela renovação (`renewal:<oferta>:subscription`) precisa
-- de prova para o guard de mutações da Asaas — sem isso a reativação do aluno
-- renovado (Bianca, 17/09/2026) e qualquer mutação futura nessa assinatura
-- morrem em ASAAS_IDENTITY_MISMATCH, e os pagamentos dela caem em TRIAGE.
-- A oferta mora em `private.*`; esta RPC devolve só o vínculo, para service_role.
create or replace function public.student_course_renewal_binding(p_offer uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.role() <> 'service_role' then null else (
    select pg_catalog.jsonb_build_object(
      'offer_id', offer.id,
      'tenant_id', offer.tenant_id,
      'student_id', offer.student_id,
      'status', offer.status,
      'billing_status', offer.billing_status,
      'provider_created_subscription_id', offer.provider_created_subscription_id
    )
    from private.student_course_renewal_offers as offer
    where offer.id = p_offer
  ) end;
$$;

alter function public.student_course_renewal_binding(uuid) owner to postgres;
revoke all on function public.student_course_renewal_binding(uuid) from public, anon, authenticated;
grant execute on function public.student_course_renewal_binding(uuid) to service_role;
