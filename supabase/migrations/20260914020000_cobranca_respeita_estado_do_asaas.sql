-- Cobrança e suspensão respeitam o último estado que o Asaas informou.
--
-- O caso (13/09/2026): desde 30/08 o asaas-webhook deixa em TRIAGE os eventos
-- que não consegue corroborar — assinatura legada sem subscription_id no
-- perfil, cartão em CONFIRMED, vencimento alterado no Asaas. O dinheiro entra
-- no Asaas, mas a linha local continua PENDING. Resultado medido:
--   * a régua de vencidas (notify-payment-due) cobrou quem já tinha pago —
--     4 dos 10 avisos de 13/09, e outros 7 entre 28/08 e 08/09;
--   * a suspensão diária (suspend_overdue_students) marcou SUSPENDED dois
--     alunos com o pagamento recebido no Asaas (bloqueia a área do aluno).
--
-- A regra: o último evento que o Asaas mandou para AQUELA cobrança — a mesma
-- asaas_payment_id da linha local — vence o status local quando diz que ela
-- está paga, estornada/excluída ou com outro vencimento.
--
-- ⚠️ Só serve para NÃO cobrar e NÃO suspender. Nunca para dar baixa: baixa no
-- caixa continua sendo trabalho do webhook, que é quem corrobora a origem.
-- ⚠️ O evento pode estar em TRIAGE, e isso é de propósito: a triagem duvida
-- de a QUEM o pagamento pertence (vínculo). Aqui o vínculo já existia — a
-- linha local tem o mesmo id do Asaas desde antes do evento.
--
-- Re-executável: o release.sh reaplica a lista inteira a cada deploy.

create or replace function private.student_payment_provider_block_reason(
  p_payment_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select case
           when ultimo.provider_status in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
             then 'asaas_ja_recebeu'
           when ultimo.provider_status in (
                  'REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS',
                  'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE',
                  'AWAITING_CHARGEBACK_REVERSAL'
                )
             or ultimo.event_name = 'PAYMENT_DELETED'
             then 'asaas_estorno_ou_exclusao'
           -- Vencimento movido no Asaas: a cobrança local ficou velha. Cobrar
           -- "atraso" de algo que o Asaas ainda não considera vencido é o
           -- mesmo erro de cobrar quem pagou.
           when ultimo.provider_due_date is not null
            and ultimo.provider_due_date is distinct from payment.due_date
             then 'asaas_vencimento_mudou'
         end
    from public.student_payments as payment
    left join lateral (
      select inbox.event_name,
             upper(btrim(coalesce(inbox.payload -> 'payment' ->> 'status', '')))
               as provider_status,
             case
               when (inbox.payload -> 'payment' ->> 'dueDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                 then (inbox.payload -> 'payment' ->> 'dueDate')::date
             end as provider_due_date
        from public.asaas_webhook_inbox as inbox
       where inbox.provider_entity_id in (
               nullif(btrim(coalesce(payment.asaas_payment_id, '')), ''),
               nullif(btrim(coalesce(payment.asaas_id, '')), '')
             )
         and jsonb_typeof(inbox.payload -> 'payment') = 'object'
       order by inbox.event_created_at desc nulls last,
                inbox.received_at desc nulls last
       limit 1
    ) as ultimo on true
   where payment.id = p_payment_id;
$function$;

alter function private.student_payment_provider_block_reason(uuid) owner to postgres;
revoke all on function private.student_payment_provider_block_reason(uuid)
  from public, anon, authenticated, service_role;

-- Porta da edge notify-payment-due: devolve só o motivo (nada de dado do aluno).
create or replace function public.student_payment_collection_blocks(
  p_payment_ids uuid[]
)
returns table (payment_id uuid, reason text)
language sql
stable
security definer
set search_path = ''
as $function$
  select payment.id,
         private.student_payment_provider_block_reason(payment.id)
    from public.student_payments as payment
   where payment.id = any (coalesce(p_payment_ids, '{}'::uuid[]));
$function$;

alter function public.student_payment_collection_blocks(uuid[]) owner to postgres;
revoke all on function public.student_payment_collection_blocks(uuid[])
  from public, anon, authenticated;
grant execute on function public.student_payment_collection_blocks(uuid[])
  to service_role;

-- A suspensão diária vivia só no banco (nenhuma migration a criava). Vem para
-- o repositório com a mesma regra de antes e UMA mudança: cobrança que o
-- Asaas diz estar paga, estornada ou com outro vencimento não conta como
-- atraso — nem para suspender, nem para manter suspenso.
create or replace function public.suspend_overdue_students(
  p_grace_days integer default 15
)
returns table (suspended_count integer)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count int := 0;
  v_student record;
begin
  for v_student in
    select p.id, p.tenant_id, min(sp.due_date) as first_overdue
      from profiles p
      join student_payments sp on sp.student_id = p.id
     where p.role in ('STUDENT', 'student')
       and coalesce(p.status_financial, 'ACTIVE') not in ('SUSPENDED', 'INACTIVE')
       and sp.status in ('PENDING', 'OVERDUE')
       and sp.due_date < (now() - (p_grace_days || ' days')::interval)
       and private.student_payment_provider_block_reason(sp.id) is null
     group by p.id, p.tenant_id
  loop
    update profiles set
      status_financial = 'SUSPENDED',
      suspended_at = now(),
      suspended_reason = 'Inadimplência superior a ' || p_grace_days || ' dias',
      first_overdue_at = coalesce(first_overdue_at, v_student.first_overdue::timestamptz)
    where id = v_student.id;
    v_count := v_count + 1;
  end loop;

  -- Regularizou (ou o Asaas já recebeu): volta a ACTIVE.
  update profiles set
    status_financial = 'ACTIVE',
    suspended_at = null,
    suspended_reason = null
  where role in ('STUDENT', 'student')
    and status_financial = 'SUSPENDED'
    and not exists (
      select 1
        from student_payments sp
       where sp.student_id = profiles.id
         and sp.status in ('PENDING', 'OVERDUE')
         and sp.due_date < (now() - interval '1 day')
         and private.student_payment_provider_block_reason(sp.id) is null
    );

  return query select v_count;
end;
$function$;

alter function public.suspend_overdue_students(integer) owner to postgres;
revoke all on function public.suspend_overdue_students(integer)
  from public, anon, authenticated;
grant execute on function public.suspend_overdue_students(integer) to service_role;

do $postcheck$
begin
  if pg_catalog.has_function_privilege(
       'authenticated', 'public.student_payment_collection_blocks(uuid[])', 'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'service_role', 'public.student_payment_collection_blocks(uuid[])', 'EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated', 'public.suspend_overdue_students(integer)', 'EXECUTE')
     or pg_catalog.has_function_privilege(
       'anon', 'private.student_payment_provider_block_reason(uuid)', 'EXECUTE')
  then
    raise exception 'cobrança × estado do Asaas não foi instalada com as permissões certas';
  end if;
end;
$postcheck$;
