-- Reativação pelo painel de aluno SUSPENSO que assinou renovação (Bianca,
-- 17/09/2026): a assinatura nova já existe na Asaas (criada pela renovação) e a
-- primeira cobrança pode até estar paga, mas o ledger local não a tem — o
-- ledger recusa cobrança de aluno inativo, e a reativação recusa aluno cuja
-- cobrança não está no ledger. Deadlock.
--
-- Saída: quando a assinatura do perfil foi criada por uma renovação assinada e
-- sincronizada, a reativação TOLERA a cobrança que só existe no provedor e,
-- depois de ativar o cadastro, reenfileira os eventos da inbox daquela
-- assinatura para o worker importá-los pelo caminho normal e guardado
-- (`apply_active_student_payment_event`, que já conhece `renewal:*`).
-- Nada é inserido na mão em `student_payments`.

create or replace function public.student_course_renewal_binding_for_subscription(
  p_tenant text, p_student uuid, p_subscription text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.role() <> 'service_role' then null else (
    select pg_catalog.jsonb_build_object(
      'offer_id', offer.id,
      'signed_at', offer.signed_at,
      'billing_synced_at', offer.billing_synced_at,
      'term_months', offer.term_months,
      'classes_per_week', offer.classes_per_week,
      'monthly_fee_cents', offer.monthly_fee_cents
    )
    from private.student_course_renewal_offers as offer
    where offer.tenant_id = p_tenant
      and offer.student_id = p_student
      and offer.status = 'SIGNED'
      and offer.billing_status = 'SYNCED'
      and nullif(pg_catalog.btrim(coalesce(offer.provider_created_subscription_id, '')), '')
        = nullif(pg_catalog.btrim(coalesce(p_subscription, '')), '')
    order by offer.signed_at desc
    limit 1
  ) end;
$$;

-- Reenfileira os eventos da inbox (em TRIAGE) das cobranças da assinatura da
-- renovação, DEPOIS de o aluno estar ativo. Só para assinatura provada pela
-- renovação e pelo cliente Asaas do próprio aluno; devolve quantos voltaram.
create or replace function public.requeue_asaas_inbox_events_for_renewal_subscription(
  p_tenant text, p_student uuid, p_subscription text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer text;
  v_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if public.student_course_renewal_binding_for_subscription(p_tenant, p_student, p_subscription) is null then
    return 0;
  end if;
  select nullif(pg_catalog.btrim(coalesce(profile.asaas_customer_id, '')), '')
    into v_customer
    from public.profiles as profile
   where profile.id = p_student
     and profile.tenant_id = p_tenant
     and lower(coalesce(profile.lifecycle_status, '')) = 'active';
  if v_customer is null then
    return 0;
  end if;
  update public.asaas_webhook_inbox as inbox
     set status = 'RETRY',
         lease_owner = null,
         lease_expires_at = null,
         next_attempt_at = pg_catalog.now(),
         processed_at = null,
         last_error = 'requeued_after_renewal_reactivation',
         updated_at = pg_catalog.now()
   where inbox.status = 'TRIAGE'
     and inbox.event_name like 'PAYMENT_%'
     and nullif(pg_catalog.btrim(coalesce(inbox.payload #>> '{payment,subscription}', '')), '') = p_subscription
     and nullif(pg_catalog.btrim(coalesce(inbox.payload #>> '{payment,customer}', '')), '') = v_customer;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter function public.student_course_renewal_binding_for_subscription(text, uuid, text) owner to postgres;
alter function public.requeue_asaas_inbox_events_for_renewal_subscription(text, uuid, text) owner to postgres;
revoke all on function public.student_course_renewal_binding_for_subscription(text, uuid, text) from public, anon, authenticated;
revoke all on function public.requeue_asaas_inbox_events_for_renewal_subscription(text, uuid, text) from public, anon, authenticated;
grant execute on function public.student_course_renewal_binding_for_subscription(text, uuid, text) to service_role;
grant execute on function public.requeue_asaas_inbox_events_for_renewal_subscription(text, uuid, text) to service_role;
