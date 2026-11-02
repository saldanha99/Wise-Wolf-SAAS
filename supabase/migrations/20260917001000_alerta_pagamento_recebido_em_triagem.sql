-- Pagamento RECEBIDO no Asaas que não entrou no sistema avisa o diretor NA HORA.
--
-- O caso (16/09/2026): o Ramiro pagou R$ 429 às 18:53 e o grupo da Gestão não
-- recebeu o rateio. O webhook (fail-closed, de propósito) deixou o evento em
-- TRIAGE porque a linha local dizia R$ 245,14 — o pró-rata da 1ª mensalidade
-- gravado como se fosse o plano. O Felipe (R$ 271, 14/09) estava na mesma
-- situação havia dois dias (perfil sem `subscription_id`). O alerta diário de
-- saúde (`notify_asaas_automation_health`) diz só "Triagem: 25" — sem nome,
-- sem valor, sem motivo — e ninguém liga isso ao rateio que não chegou.
--
-- Este aviso é por EVENTO: cada PAYMENT_RECEIVED/RECEIVED_IN_CASH parado em
-- TRIAGE, cuja linha local ainda não está paga, gera UMA mensagem ao diretor
-- (DM, como a de saúde) com aluno, valor, data e o motivo técnico. Dedupe em
-- `automation_sent` (kind ASAAS_TRIAGE_SETTLED, subject = id do evento). Evento
-- cuja linha local já ficou paga por outro caminho (ex.: Isabella, 10/09) não
-- gera aviso. Re-executável: `create or replace` + cron reagendado por nome.

create or replace function private.notify_settled_payments_in_triage()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  admin_row record;
  ev record;
  dedupe_id uuid;
  sent integer := 0;
  v_msg text;
  v_valor numeric;
begin
  select
    profile.id,
    membership.tenant_id,
    profile.phone
    into admin_row
    from public.tenant_memberships as membership
    join public.profiles as profile on profile.id = membership.user_id
   where membership.tenant_id = 'school-wise-wolf'
     and membership.role = 'SCHOOL_ADMIN'
     and membership.status = 'ACTIVE'
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
     and nullif(trim(profile.phone), '') is not null
     and coalesce(profile.is_test_account, false) is false
   order by membership.is_primary desc nulls last, membership.created_at, profile.id
   limit 1;
  if admin_row.id is null then
    return 0;
  end if;

  for ev in
    select
      inbox.provider_event_id,
      inbox.event_name,
      inbox.last_error,
      inbox.received_at,
      inbox.payload->'payment'->>'id' as provider_payment_id,
      inbox.payload->'payment'->>'value' as value_text,
      inbox.payload->'payment'->>'paymentDate' as payment_date,
      inbox.payload->'payment'->>'customer' as customer_id,
      coalesce(
        (select s.full_name from public.student_payments sp join public.profiles s on s.id = sp.student_id
          where sp.asaas_payment_id = inbox.payload->'payment'->>'id' limit 1),
        (select s.full_name from public.profiles s
          where s.asaas_customer_id = inbox.payload->'payment'->>'customer' limit 1),
        'aluno não identificado'
      ) as student_name,
      (select sp.status from public.student_payments sp
        where sp.asaas_payment_id = inbox.payload->'payment'->>'id' limit 1) as local_status
      from public.asaas_webhook_inbox as inbox
     where inbox.status = 'TRIAGE'
       and inbox.event_name in ('PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH')
       and inbox.received_at > now() - interval '30 days'
     order by inbox.received_at
  loop
    -- Já entrou por outro caminho (baixa manual, reprocessamento): sem aviso.
    if upper(coalesce(ev.local_status, '')) in ('RECEIVED', 'RECEIVED_IN_CASH') then
      continue;
    end if;

    insert into public.automation_sent (kind, subject_id, ref_date)
    values ('ASAAS_TRIAGE_SETTLED', left(ev.provider_event_id, 200), ev.received_at::date)
    on conflict (kind, subject_id, ref_date) do nothing
    returning id into dedupe_id;
    if dedupe_id is null then
      continue;
    end if;

    v_valor := nullif(ev.value_text, '')::numeric;
    v_msg :=
      '💸 *Pagamento recebido no Asaas, mas NÃO registrado no sistema*' || E'\n\n' ||
      '*' || ev.student_name || '* — R$ ' ||
      coalesce(replace(to_char(v_valor, 'FM999999990.00'), '.', ','), '?') ||
      coalesce(' (pago em ' || to_char(nullif(ev.payment_date, '')::date, 'DD/MM') || ')', '') || E'\n' ||
      'Motivo técnico: ' || coalesce(ev.last_error, 'desconhecido') || E'\n\n' ||
      'Enquanto isso o dinheiro fica fora do caixa, do DRE e do rateio no grupo. ' ||
      'Confira o cadastro do aluno (valor da mensalidade, assinatura do Asaas) e me chame para reprocessar.';

    insert into public.notification_queue (
      tenant_id, teacher_id, student_phone, message_body, scheduled_for, status,
      attempts, source_id, source_type, class_date, notification_kind
    ) values (
      admin_row.tenant_id, admin_row.id, admin_row.phone, v_msg, now(), 'pending',
      0, dedupe_id, 'ASAAS_TRIAGE_SETTLED', current_date, 'ASAAS_TRIAGE_SETTLED'
    );
    sent := sent + 1;
  end loop;

  return sent;
end;
$function$;

revoke all on function private.notify_settled_payments_in_triage()
  from public, anon, authenticated, service_role;

do $schedule$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
      from cron.job
     where jobname = 'wisewolf-asaas-triage-settled';
    perform cron.schedule(
      'wisewolf-asaas-triage-settled',
      '*/15 * * * *',
      'select private.notify_settled_payments_in_triage();'
    );
  end if;
end;
$schedule$;
