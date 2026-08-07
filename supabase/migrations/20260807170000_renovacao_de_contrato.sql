-- Renovação de contrato: a data existia, mas só na Asaas.
--
-- O fim do contrato do aluno vive no `endDate` da assinatura Asaas, e nada na
-- plataforma lia isso. Em `profiles` há `start_date` e `contract_accepted`, mas
-- NENHUMA data de término; `fidelity_plan` é texto livre (nulo em 29 de 55
-- alunos, "Personalizado / Manual" em 22) e não serve como data.
--
-- Medido em 07/08/2026: duas assinaturas já tinham expirado sem ninguém saber.
-- Uma delas é de uma aluna que pagou 6 de 6 faturas sem um dia de atraso — ela
-- simplesmente deixaria de ser faturada em outubro, sem erro, sem alerta e sem
-- ninguém perceber até a receita cair.
--
-- Quatro outros contratos vencem nos próximos 90 dias.
--
-- ⚠️ Este arquivo só faz o sistema ENXERGAR. Ele não renova, não cancela e não
-- dispara mensagem: renovação é conversa comercial, e a dor real dessas
-- pessoas (não perder o professor, o horário, a agenda) não cabe num robô.

-- ⚠️ SEM `begin;`/`commit;` e RE-EXECUTÁVEL.

---------------------------------------------------------------------------
-- 1. Espelho do estado da assinatura (preenchido pela edge sync-subscription-status).
---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists asaas_subscription_status text;
alter table public.profiles
  add column if not exists asaas_subscription_end_date date;
alter table public.profiles
  add column if not exists asaas_subscription_synced_at timestamptz;

create index if not exists ix_profiles_subscription_end
  on public.profiles (asaas_subscription_end_date)
  where asaas_subscription_end_date is not null;

---------------------------------------------------------------------------
-- 2. Quem está perto de vencer / já venceu, com professor e horários.
--
-- O professor e os horários entram no retorno de propósito: a dor de quem não
-- renova não é o preço, é perder o professor e o horário que já cabem na
-- rotina. Uma régua que diz "renove seu plano" perde para uma que diz "seu
-- horário de terça 19h com a Beatrís fica reservado até dia X".
---------------------------------------------------------------------------
create or replace function public.contratos_para_renovar(p_tenant text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_jwt text;
  v_role text;
  v_tenant text;
  v_vencendo jsonb;
  v_encerrado jsonb;
begin
  v_jwt := coalesce(current_setting('request.jwt.claims', true)::json->>'role', '');
  select role, tenant_id into v_role, v_tenant from public.profiles where id = auth.uid();

  if v_jwt in ('anon', 'authenticated') then
    if v_role is null or v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') then
      return jsonb_build_object('error', 'sem_permissao');
    end if;
    if v_role = 'SUPER_ADMIN' then v_tenant := coalesce(p_tenant, v_tenant); end if;
  else
    v_tenant := coalesce(p_tenant, v_tenant);
  end if;

  if v_tenant is null then
    return jsonb_build_object('error', 'escola_nao_identificada');
  end if;

  -- Contrato vencendo nos próximos 90 dias, aluno ainda estudando.
  select coalesce(jsonb_agg(x order by x.termina), '[]'::jsonb) into v_vencendo
  from (
    select trim(p.full_name) as aluno,
           p.id as student_id,
           coalesce(p.monthly_fee, 0)::numeric(10,2) as mensalidade,
           p.asaas_subscription_end_date as termina,
           (p.asaas_subscription_end_date - current_date)::int as dias,
           g.professor,
           g.horarios
      from public.profiles p
      cross join lateral (
        select
          -- Professor com quem ele mais teve aula nos últimos 90 dias: é o
          -- vínculo real, não o `professor_id` do cadastro (que fica velho).
          (select trim(t.full_name)
             from public.class_logs cl
             join public.profiles t on t.id = cl.teacher_id
            where cl.student_id = p.id and cl.class_date >= current_date - 90
            group by t.full_name
            order by count(*) desc
            limit 1) as professor,
          (select string_agg(distinct b.day_of_week || ' ' || b.time_slot, ', ')
             from public.bookings b
            where b.student_id = p.id and b.status = 'SCHEDULED') as horarios
      ) g
     where p.tenant_id = v_tenant
       and p.role = 'STUDENT'
       and public.is_student_notifiable(p.id)
       and p.asaas_subscription_end_date is not null
       and p.asaas_subscription_end_date >= current_date
       and p.asaas_subscription_end_date <= current_date + 90
       -- ⚠️ Os dois blocos precisam ser DISJUNTOS. Sem esta linha, quem está
       -- EXPIRED com data de término ainda no futuro (a Asaas marca assim
       -- quando o último ciclo já saiu) aparecia nas duas listas e era contado
       -- duas vezes no badge. "Já encerrado" é o estado mais grave e tem
       -- precedência; aqui ficam só os que ainda estão vivos.
       and upper(coalesce(p.asaas_subscription_status, 'ACTIVE'))
             not in ('EXPIRED', 'INACTIVE', 'NOT_FOUND')
       and exists (select 1 from public.class_logs cl
                    where cl.student_id = p.id and cl.class_date >= current_date - 60)
  ) x;

  -- Assinatura já encerrada (expirada, inativa ou sumida) com aluno ativo.
  -- É o caso que sangra em silêncio: continua tendo aula, para de ser cobrado.
  select coalesce(jsonb_agg(x order by x.termina nulls first), '[]'::jsonb) into v_encerrado
  from (
    select trim(p.full_name) as aluno,
           p.id as student_id,
           coalesce(p.monthly_fee, 0)::numeric(10,2) as mensalidade,
           coalesce(p.asaas_subscription_status, '?') as situacao,
           p.asaas_subscription_end_date as termina,
           (select count(*) from public.v_payable_class_logs v
             where v.student_id = p.id and v.class_date >= current_date - 60)::int as aulas_60d
      from public.profiles p
     where p.tenant_id = v_tenant
       and p.role = 'STUDENT'
       and public.is_student_notifiable(p.id)
       and coalesce(p.subscription_id, '') <> ''
       and (
         upper(coalesce(p.asaas_subscription_status, '')) in ('EXPIRED', 'INACTIVE', 'NOT_FOUND')
         or (p.asaas_subscription_end_date is not null and p.asaas_subscription_end_date < current_date)
       )
       and exists (select 1 from public.class_logs cl
                    where cl.student_id = p.id and cl.class_date >= current_date - 60)
  ) x;

  return jsonb_build_object(
    'ok', true,
    'sincronizado_em', (select max(asaas_subscription_synced_at)
                          from public.profiles where tenant_id = v_tenant),
    'vencendo', jsonb_build_object(
      'itens', v_vencendo,
      'qtd', jsonb_array_length(v_vencendo),
      'mensal', (select coalesce(sum((i->>'mensalidade')::numeric), 0)
                   from jsonb_array_elements(v_vencendo) i)
    ),
    'encerrado', jsonb_build_object(
      'itens', v_encerrado,
      'qtd', jsonb_array_length(v_encerrado),
      'mensal', (select coalesce(sum((i->>'mensalidade')::numeric), 0)
                   from jsonb_array_elements(v_encerrado) i)
    )
  );
end;
$$;

alter function public.contratos_para_renovar(text) owner to postgres;
grant execute on function public.contratos_para_renovar(text) to authenticated;

---------------------------------------------------------------------------
-- 3. Badge: renovação entra na conta de pendências do diretor.
--
-- ⚠️ Redefinição COMPLETA de director_pending_counts, preservando cada chave
-- existente. Perder uma apagaria em silêncio o badge de outra tela.
---------------------------------------------------------------------------
create or replace function public.director_pending_counts()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_role text;
  v_tenant text;
  v_recon jsonb;
  v_renov jsonb;
begin
  select role, tenant_id into v_role, v_tenant from profiles where id = auth.uid();
  if v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then return '{}'::jsonb; end if;

  v_recon := financial_reconciliation(v_tenant);
  v_renov := contratos_para_renovar(v_tenant);

  return jsonb_build_object(
    'acolhimento', (select count(*) from profiles
        where tenant_id = v_tenant and role = 'STUDENT' and documentation_status = 'PENDING'),
    'presenca', (select count(*) from attendance_confirmations ac
        join class_logs cl on cl.id = ac.class_log_id
        where cl.tenant_id = v_tenant and ac.status = 'CONFLICT'),
    'materiais', (select count(*) from pedagogical_materials
        where tenant_id = v_tenant and approval_status = 'PENDING'),
    'trials', (select count(*) from appointments a
        where a.tenant_id = v_tenant and a.type in ('experimental', 'training')
          and a.status = 'scheduled' and a.start_time <= now()
          and a.start_time >= '2026-06-01'::timestamptz
          and not exists (select 1 from class_logs cl where cl.appointment_id = a.id::text)),
    'pagamentos_retidos', (select count(*) from class_logs
        where tenant_id = v_tenant and coalesce(payment_hold, false) = true),
    'fechamentos', (select count(*) from teacher_closings
        where tenant_id = v_tenant and status = 'PENDENTE'),
    'sem_assinatura', coalesce((alunos_sem_assinatura(v_tenant)->>'alunos')::int, 0),
    'reconciliacao', coalesce((v_recon->'sem_cobertura'->>'qtd')::int, 0)
                   + coalesce((v_recon->'cobrado_sem_estudar'->>'qtd')::int, 0)
                   + coalesce((v_recon->'arquivado_com_fatura'->>'qtd')::int, 0)
                   + coalesce((v_recon->'pago_sem_nf'->>'qtd')::int, 0)
                   + coalesce((v_recon->'parado_com_nf'->>'qtd')::int, 0)
                   + coalesce((v_recon->'aula_nao_lancada'->>'qtd')::int, 0)
                   + coalesce((v_renov->'vencendo'->>'qtd')::int, 0)
                   + coalesce((v_renov->'encerrado'->>'qtd')::int, 0)
  );
end;
$$;

alter function public.director_pending_counts() owner to postgres;
grant execute on function public.director_pending_counts() to authenticated;

---------------------------------------------------------------------------
-- 4. Cron diário de sincronização (mesmo padrão de trigger_notify_payment_due).
---------------------------------------------------------------------------
create or replace function public.trigger_sync_subscription_status()
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
    url := 'http://kong:8000/functions/v1/sync-subscription-status',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || service_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into request_id;
  return request_id;
end;
$$;

alter function public.trigger_sync_subscription_status() owner to postgres;

-- 06:40 UTC (03:40 BRT): antes do cron de cobrança das 12:00 UTC, para o painel
-- do dia já nascer com o estado fresco. `cron.schedule` com o mesmo nome
-- atualiza em vez de duplicar — a migration roda a cada release.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('wisewolf-sync-subscriptions', '40 6 * * *',
                          'select public.trigger_sync_subscription_status();');
  end if;
end $$;
