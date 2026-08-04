-- A assinatura do aditivo muda o valor no SISTEMA. A cobrança recorrente vive na
-- Asaas, e lá o valor continuava o antigo.
--
-- Em produção (04/08/2026): 23 dos 53 alunos ativos têm assinatura recorrente.
-- O Victor tinha assinatura `sub_...` E uma cobrança de R$ 299 já gerada para
-- 30/08 — ou seja, mesmo com o aditivo assinado ele seria cobrado o valor velho.
--
-- POR QUE FILA E NÃO CHAMADA DIRETA: a assinatura acontece numa página PÚBLICA,
-- com o aluno deslogado. Ela não tem (nem pode ter) credencial para falar com a
-- Asaas. E se tivesse, uma falha de rede da Asaas no meio derrubaria a
-- assinatura do aluno por um motivo que não é problema dele. Então a assinatura
-- só ENFILEIRA, e um cron sincroniza — com o erro guardado e visível quando
-- falha, em vez de divergência silenciosa.

begin;

alter table public.student_plan_changes
  add column if not exists billing_sync_status text not null default 'NOT_NEEDED',
  add column if not exists billing_sync_error text,
  add column if not exists billing_synced_at timestamptz,
  add column if not exists billing_attempts int not null default 0,
  add column if not exists asaas_subscription_id text,
  -- Cobrança JÁ gerada (a do mês em curso) entra no valor novo ou fica no antigo?
  -- É decisão comercial e o diretor escolhe na hora de propor: cobrar R$ 90 a mais
  -- numa fatura que o aluno já viu rende chamado no WhatsApp.
  add column if not exists update_pending_payments boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'student_plan_changes_billing_sync_chk'
  ) then
    alter table public.student_plan_changes
      add constraint student_plan_changes_billing_sync_chk
      check (billing_sync_status in ('NOT_NEEDED', 'PENDING', 'SYNCED', 'FAILED'));
  end if;
end $$;

create index if not exists ix_plan_change_billing_pending
  on public.student_plan_changes (billing_sync_status)
  where billing_sync_status = 'PENDING';

---------------------------------------------------------------------------
-- Propor: agora aceita a escolha sobre a fatura já gerada.
---------------------------------------------------------------------------
create or replace function public.create_student_plan_change(
  p_student_id uuid,
  p_to_frequency text,
  p_to_fee numeric,
  p_update_pending_payments boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant text;
  v_from_freq text;
  v_from_fee numeric;
  v_fidelity text;
  v_token text;
  v_freq text;
begin
  select tenant_id, class_frequency, monthly_fee, fidelity_plan
    into v_tenant, v_from_freq, v_from_fee, v_fidelity
    from public.profiles
   where id = p_student_id and role = 'STUDENT';

  if v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'Aluno não encontrado');
  end if;

  if not (v_tenant = public._my_tenant_id()
          and public._my_role() = any (array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'])) then
    return jsonb_build_object('ok', false, 'error', 'Sem permissão');
  end if;

  v_freq := lower(btrim(coalesce(p_to_frequency, '')));
  if v_freq !~ '^[1-9][0-9]?x$' then
    return jsonb_build_object('ok', false, 'error', 'Frequência inválida (use algo como "6x")');
  end if;

  if p_to_fee is null or p_to_fee <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Informe o novo valor da mensalidade');
  end if;

  if v_freq = lower(coalesce(v_from_freq, '')) and p_to_fee = v_from_fee then
    return jsonb_build_object('ok', false, 'error', 'O plano proposto é igual ao atual');
  end if;

  update public.student_plan_changes
     set status = 'CANCELLED', cancelled_at = now()
   where student_id = p_student_id and status = 'PENDING';

  insert into public.student_plan_changes (
    tenant_id, student_id, created_by,
    from_frequency, to_frequency, from_monthly_fee, to_monthly_fee, fidelity_plan,
    update_pending_payments
  ) values (
    v_tenant, p_student_id, auth.uid(),
    v_from_freq, v_freq, v_from_fee, p_to_fee, v_fidelity,
    coalesce(p_update_pending_payments, true)
  )
  returning token into v_token;

  return jsonb_build_object('ok', true, 'token', v_token);
end;
$$;

---------------------------------------------------------------------------
-- Assinar: aplica o valor E enfileira a Asaas quando há assinatura recorrente.
---------------------------------------------------------------------------
create or replace function public.sign_student_plan_change(
  p_token text,
  p_typed_signature text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_change public.student_plan_changes%rowtype;
  v_name text;
  v_subscription text;
begin
  select * into v_change from public.student_plan_changes where token = p_token for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Proposta não encontrada');
  end if;

  if v_change.status = 'SIGNED' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  if v_change.status = 'CANCELLED' then
    return jsonb_build_object('ok', false, 'error', 'Esta proposta foi substituída por outra. Peça o link novo à escola.');
  end if;

  if v_change.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'Esta proposta expirou. Peça um link novo à escola.');
  end if;

  select full_name, subscription_id into v_name, v_subscription
    from public.profiles where id = v_change.student_id;

  if public.normalize_signature_name(p_typed_signature) is distinct from public.normalize_signature_name(v_name)
     or btrim(coalesce(p_typed_signature, '')) = '' then
    return jsonb_build_object('ok', false, 'error', 'A assinatura precisa ser exatamente o nome completo do aluno.');
  end if;

  -- AQUI o plano passa a valer. Antes desta linha, a escola cobra o valor antigo.
  update public.profiles
     set monthly_fee = v_change.to_monthly_fee,
         class_frequency = v_change.to_frequency
   where id = v_change.student_id;

  update public.student_plan_changes
     set status = 'SIGNED',
         typed_signature = btrim(p_typed_signature),
         signature_ip = coalesce(
           nullif(btrim(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)), ''),
           'Via Web (Digital)'
         ),
         signed_at = now(),
         asaas_subscription_id = v_subscription,
         -- Sem assinatura recorrente não há nada a sincronizar: a escola cobra na
         -- mão e o status fica NOT_NEEDED em vez de PENDING para sempre.
         billing_sync_status = case
           when nullif(btrim(coalesce(v_subscription, '')), '') is null then 'NOT_NEEDED'
           else 'PENDING'
         end
   where id = v_change.id;

  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

---------------------------------------------------------------------------
-- Fila que a edge consome (só service_role: ela roda com a chave da Asaas).
---------------------------------------------------------------------------
create or replace function public.plan_changes_awaiting_billing()
returns table (
  id uuid,
  tenant_id text,
  student_id uuid,
  student_name text,
  asaas_subscription_id text,
  to_monthly_fee numeric,
  to_frequency text,
  update_pending_payments boolean,
  billing_attempts int
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.id, c.tenant_id, c.student_id, p.full_name, c.asaas_subscription_id,
         c.to_monthly_fee, c.to_frequency, c.update_pending_payments, c.billing_attempts
    from public.student_plan_changes c
    join public.profiles p on p.id = c.student_id
   where c.billing_sync_status = 'PENDING'
     and c.status = 'SIGNED'
     and c.asaas_subscription_id is not null
     -- 6 tentativas: erro de rede se resolve sozinho, chave errada não. Parar de
     -- tentar deixa o FAILED visível em vez de bater na Asaas para sempre.
     and c.billing_attempts < 6
   order by c.signed_at
   limit 50;
$$;

create or replace function public.mark_plan_change_billing(
  p_id uuid,
  p_ok boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.student_plan_changes
     set billing_attempts = billing_attempts + 1,
         billing_sync_status = case
           when p_ok then 'SYNCED'
           -- Só desiste na última tentativa; antes disso continua PENDING e o
           -- próximo cron tenta de novo.
           when billing_attempts + 1 >= 6 then 'FAILED'
           else 'PENDING'
         end,
         billing_sync_error = case when p_ok then null else left(coalesce(p_error, 'erro desconhecido'), 500) end,
         billing_synced_at = case when p_ok then now() else billing_synced_at end
   where id = p_id;
end;
$$;

---------------------------------------------------------------------------
-- Cron wrapper (mesmo padrão de trigger_notify_payment_due).
---------------------------------------------------------------------------
create or replace function public.trigger_sync_plan_change_billing()
returns bigint
language plpgsql
security definer
set search_path to 'public', 'vault'
as $$
declare
  request_id bigint;
  service_key text;
begin
  select decrypted_secret into service_key
    from vault.decrypted_secrets where name = 'wisewolf_service_role_key' limit 1;
  if service_key is null or service_key = '' then
    raise warning 'service key ausente';
    return -1;
  end if;
  select net.http_post(
    url := 'http://kong:8000/functions/v1/sync-plan-change-billing',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || service_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;

alter function public.create_student_plan_change(uuid, text, numeric, boolean) owner to postgres;
alter function public.sign_student_plan_change(text, text) owner to postgres;
alter function public.plan_changes_awaiting_billing() owner to postgres;
alter function public.mark_plan_change_billing(uuid, boolean, text) owner to postgres;
alter function public.trigger_sync_plan_change_billing() owner to postgres;

grant execute on function public.create_student_plan_change(uuid, text, numeric, boolean) to authenticated;
grant execute on function public.sign_student_plan_change(text, text) to anon, authenticated;
-- A fila carrega id de assinatura da Asaas: nunca sai para o navegador.
revoke all on function public.plan_changes_awaiting_billing() from public, anon, authenticated;
revoke all on function public.mark_plan_change_billing(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.plan_changes_awaiting_billing() to service_role;
grant execute on function public.mark_plan_change_billing(uuid, boolean, text) to service_role;

-- A versão antiga de 3 argumentos sai de circulação: se ficasse, o frontend
-- poderia continuar chamando ela e a escolha sobre a fatura já gerada nunca
-- chegaria ao banco (ficaria sempre no default).
drop function if exists public.create_student_plan_change(uuid, text, numeric);

commit;
