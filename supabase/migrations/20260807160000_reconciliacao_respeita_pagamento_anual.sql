-- Reconciliação: aluno que pagou o ano à vista NÃO é inadimplente.
--
-- O bucket `nunca_cobrado` da migration anterior contava cobranças na vida
-- (<= 1) e por isso acusava quem pagou adiantado. Leandro Alexandre da Silva
-- pagou R$ 2.244,00 em 30/03/2026 num boleto só — exatamente 12 × R$ 187,00.
-- Ele está pago até março/2027 e aparecia como o pior caso da escola.
--
-- Alarme falso é pior que alarme nenhum: dois de cinco itens errados ensinam o
-- diretor a ignorar a tela inteira, e aí os três verdadeiros também morrem.
--
-- A REGRA passa a ser COBERTURA, não contagem:
--   meses_cobertos = total recebido / mensalidade
--   coberto_ate    = data do 1º pagamento + meses_cobertos
-- Só entra na lista quem tem aula recente E cuja cobertura já venceu. Quem
-- pagou 12 meses some por 12 meses e volta sozinho quando vencer — sem
-- ninguém precisar lembrar de tirá-lo de uma lista de exceção.
--
-- ⚠️ Nome chumbado seria pior: resolveria hoje e quebraria no próximo aluno
-- que pagar adiantado.
--
-- ⚠️ Pagamento fora do sistema continua invisível de propósito. Gabriel
-- Cavalcante Natal não tem NENHUM `student_payments` — se recebeu à vista por
-- fora, o dinheiro não está no DRE nem no caixa, e a tela deve continuar
-- apontando. O conserto ali é lançar o pagamento, não silenciar o alerta.

-- ⚠️ SEM `begin;`/`commit;` e RE-EXECUTÁVEL.

create or replace function public.financial_reconciliation(p_tenant text default null)
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
  v_sem_cobertura jsonb;
  v_cobrado_sem_estudar jsonb;
  v_arquivado_com_fatura jsonb;
  v_pago_sem_nf jsonb;
  v_parado_com_nf jsonb;
  v_aula_nao_lancada jsonb;
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

  -------------------------------------------------------------------------
  -- 1. MESES DE AULA ENTREGUES × MESES PAGOS.
  --
  -- Substitui o antigo `nunca_cobrado`, que contava BOLETOS e por isso acusava
  -- quem pagou o ano à vista num boleto só.
  --
  -- ⚠️ A primeira tentativa de conserto contava a cobertura a partir do
  -- PRIMEIRO PAGAMENTO, e escondia o caso oposto: uma aluna que estudou de
  -- fevereiro a julho sem pagar nada, pagou UM mês em 07/07 e passava a
  -- parecer em dia — os cinco meses anteriores sumiam da conta.
  --
  -- A régua correta compara SERVIÇO ENTREGUE com DINHEIRO RECEBIDO:
  --   meses_servico = desde a primeira aula até hoje
  --   meses_pagos   = total recebido / mensalidade
  --   deficit       = serviço − pago
  -- Quem pagou 12 e entregou 6 tem déficit negativo e não aparece. Quem
  -- entregou 7 e pagou 1 aparece com o tamanho real do buraco.
  --
  -- Tolerância de 2 meses: cobre atraso normal de boleto e o mês corrente
  -- ainda em curso, sem alarmar no dia seguinte ao vencimento.
  -------------------------------------------------------------------------
  select coalesce(jsonb_agg(x order by x.valor_estimado desc), '[]'::jsonb) into v_sem_cobertura
  from (
    select trim(p.full_name) as aluno,
           p.id as student_id,
           coalesce(p.monthly_fee, 0)::numeric(10,2) as mensalidade,
           c.inicio as primeira_aula,
           c.aulas_60d,
           c.recebido::numeric(10,2) as total_recebido,
           c.meses_servico,
           c.meses_pagos,
           (c.meses_servico - c.meses_pagos) as deficit_meses,
           ((c.meses_servico - c.meses_pagos) * coalesce(p.monthly_fee, 0))::numeric(10,2) as valor_estimado
      from public.profiles p
      cross join lateral (
        select
          (select count(*) from public.v_payable_class_logs v
            where v.student_id = p.id and v.class_date >= current_date - 60)::int as aulas_60d,
          coalesce((select sum(sp.value) from public.student_payments sp
                     where sp.student_id = p.id
                       and sp.status in ('RECEIVED', 'RECEIVED_IN_CASH')), 0) as recebido,
          -- O relógio começa quando o serviço começou, não quando alguém pagou.
          coalesce((select min(v.class_date) from public.v_payable_class_logs v
                     where v.student_id = p.id),
                   p.created_at::date) as inicio
      ) base
      cross join lateral (
        select base.aulas_60d,
               base.recebido,
               base.inicio,
               (floor((current_date - base.inicio) / 30.0)::int + 1) as meses_servico,
               floor(base.recebido / nullif(coalesce(p.monthly_fee, 0), 0))::int as meses_pagos
      ) c
     where p.tenant_id = v_tenant
       and p.role = 'STUDENT'
       and coalesce(p.monthly_fee, 0) > 0
       and public.is_student_notifiable(p.id)
       and c.aulas_60d > 0
       and (c.meses_servico - c.meses_pagos) >= 2
  ) x;

  -------------------------------------------------------------------------
  -- 2. COBRADO SEM ESTUDAR.
  -------------------------------------------------------------------------
  select coalesce(jsonb_agg(x order by x.em_aberto desc), '[]'::jsonb) into v_cobrado_sem_estudar
  from (
    select trim(p.full_name) as aluno,
           p.id as student_id,
           (select count(*) from public.student_payments sp
             where sp.student_id = p.id
               and sp.status not in ('RECEIVED', 'RECEIVED_IN_CASH', 'REFUNDED')
               and coalesce(sp.exclusion_reason, '') = '')::int as faturas_abertas,
           (select coalesce(sum(sp.value), 0) from public.student_payments sp
             where sp.student_id = p.id
               and sp.status not in ('RECEIVED', 'RECEIVED_IN_CASH', 'REFUNDED')
               and coalesce(sp.exclusion_reason, '') = '')::numeric(10,2) as em_aberto
      from public.profiles p
     where p.tenant_id = v_tenant
       and p.role = 'STUDENT'
       and public.is_student_notifiable(p.id)
       and not exists (select 1 from public.bookings b
                        where b.student_id = p.id and b.status = 'SCHEDULED')
       and not exists (select 1 from public.class_logs cl
                        where cl.student_id = p.id and cl.class_date >= current_date - 90)
       and exists (select 1 from public.student_payments sp
                    where sp.student_id = p.id
                      and sp.status not in ('RECEIVED', 'RECEIVED_IN_CASH', 'REFUNDED')
                      and coalesce(sp.exclusion_reason, '') = '')
  ) x;

  -------------------------------------------------------------------------
  -- 2b. ARQUIVADO COM FATURA EM ABERTO.
  -------------------------------------------------------------------------
  select coalesce(jsonb_agg(x order by x.em_aberto desc), '[]'::jsonb) into v_arquivado_com_fatura
  from (
    select trim(p.full_name) as aluno,
           p.id as student_id,
           coalesce(p.status, '-') as status,
           (select count(*) from public.student_payments sp
             where sp.student_id = p.id
               and sp.status not in ('RECEIVED', 'RECEIVED_IN_CASH', 'REFUNDED')
               and coalesce(sp.exclusion_reason, '') = '')::int as faturas_abertas,
           (select coalesce(sum(sp.value), 0) from public.student_payments sp
             where sp.student_id = p.id
               and sp.status not in ('RECEIVED', 'RECEIVED_IN_CASH', 'REFUNDED')
               and coalesce(sp.exclusion_reason, '') = '')::numeric(10,2) as em_aberto
      from public.profiles p
     where p.tenant_id = v_tenant
       and p.role = 'STUDENT'
       and not public.is_student_notifiable(p.id)
       and exists (select 1 from public.student_payments sp
                    where sp.student_id = p.id
                      and sp.status not in ('RECEIVED', 'RECEIVED_IN_CASH', 'REFUNDED')
                      and coalesce(sp.exclusion_reason, '') = '')
  ) x;

  -------------------------------------------------------------------------
  -- 3. FECHAMENTO PAGO SEM NOTA FISCAL.
  -------------------------------------------------------------------------
  select coalesce(jsonb_agg(x order by x.month_year), '[]'::jsonb) into v_pago_sem_nf
  from (
    select trim(t.full_name) as professor,
           c.month_year,
           c.status,
           coalesce(c.total_amount, 0)::numeric(10,2) as valor,
           coalesce(c.paid_at, c.updated_at)::date as pago_em
      from public.teacher_closings c
      join public.profiles t on t.id = c.teacher_id
     where c.tenant_id = v_tenant
       and upper(coalesce(c.status, '')) in ('PAGO', 'COMPLETED', 'PAID_WAITING_NF')
       and coalesce(btrim(c.nf_link), '') = ''
       and coalesce(c.total_amount, 0) > 0
       and coalesce(c.paid_at, c.updated_at) < now() - interval '30 days'
  ) x;

  -------------------------------------------------------------------------
  -- 4. FECHAMENTO PARADO COM NF ANEXADA.
  -------------------------------------------------------------------------
  select coalesce(jsonb_agg(x order by x.month_year), '[]'::jsonb) into v_parado_com_nf
  from (
    select trim(t.full_name) as professor,
           c.month_year,
           coalesce(c.total_amount, 0)::numeric(10,2) as valor,
           (current_date - c.updated_at::date)::int as dias_parado
      from public.teacher_closings c
      join public.profiles t on t.id = c.teacher_id
     where c.tenant_id = v_tenant
       and upper(coalesce(c.status, '')) = 'UNDER_REVIEW'
       and coalesce(btrim(c.nf_link), '') <> ''
       and c.updated_at < now() - interval '7 days'
  ) x;

  -------------------------------------------------------------------------
  -- 5. AULA CONFIRMADA E NUNCA LANÇADA.
  -------------------------------------------------------------------------
  select coalesce(jsonb_agg(x order by x.data), '[]'::jsonb) into v_aula_nao_lancada
  from (
    select trim(t.full_name) as professor,
           trim(s.full_name) as aluno,
           ac.class_date as data,
           (current_date - ac.class_date)::int as dias
      from public.attendance_confirmations ac
      left join public.profiles t on t.id = ac.teacher_id
      left join public.profiles s on s.id = ac.student_id
     where ac.status = 'AWAITING_TEACHER'
       and ac.class_date < current_date - 7
       and coalesce(t.tenant_id, s.tenant_id) = v_tenant
  ) x;

  return jsonb_build_object(
    'ok', true,
    'tenant', v_tenant,
    'gerado_em', now(),
    'sem_cobertura', jsonb_build_object(
      'itens', v_sem_cobertura,
      'qtd', jsonb_array_length(v_sem_cobertura),
      -- Estimativa, não conta a receber: é déficit × mensalidade atual. Serve
      -- para dimensionar o buraco, não para emitir boleto.
      'total', (select coalesce(sum((i->>'valor_estimado')::numeric), 0)
                  from jsonb_array_elements(v_sem_cobertura) i)
    ),
    'cobrado_sem_estudar', jsonb_build_object(
      'itens', v_cobrado_sem_estudar,
      'qtd', jsonb_array_length(v_cobrado_sem_estudar),
      'total', (select coalesce(sum((i->>'em_aberto')::numeric), 0)
                  from jsonb_array_elements(v_cobrado_sem_estudar) i)
    ),
    'arquivado_com_fatura', jsonb_build_object(
      'itens', v_arquivado_com_fatura,
      'qtd', jsonb_array_length(v_arquivado_com_fatura),
      'total', (select coalesce(sum((i->>'em_aberto')::numeric), 0)
                  from jsonb_array_elements(v_arquivado_com_fatura) i)
    ),
    'pago_sem_nf', jsonb_build_object(
      'itens', v_pago_sem_nf,
      'qtd', jsonb_array_length(v_pago_sem_nf),
      'total', (select coalesce(sum((i->>'valor')::numeric), 0)
                  from jsonb_array_elements(v_pago_sem_nf) i)
    ),
    'parado_com_nf', jsonb_build_object(
      'itens', v_parado_com_nf,
      'qtd', jsonb_array_length(v_parado_com_nf),
      'total', (select coalesce(sum((i->>'valor')::numeric), 0)
                  from jsonb_array_elements(v_parado_com_nf) i)
    ),
    'aula_nao_lancada', jsonb_build_object(
      'itens', v_aula_nao_lancada,
      'qtd', jsonb_array_length(v_aula_nao_lancada)
    )
  );
end;
$$;

alter function public.financial_reconciliation(text) owner to postgres;
grant execute on function public.financial_reconciliation(text) to authenticated;

---------------------------------------------------------------------------
-- O badge segue a chave nova.
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
begin
  select role, tenant_id into v_role, v_tenant from profiles where id = auth.uid();
  if v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then return '{}'::jsonb; end if;

  v_recon := financial_reconciliation(v_tenant);

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
  );
end;
$$;

alter function public.director_pending_counts() owner to postgres;
grant execute on function public.director_pending_counts() to authenticated;
