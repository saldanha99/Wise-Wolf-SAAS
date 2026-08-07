-- Reconciliação financeira — estados impossíveis que ninguém vigia.
--
-- O levantamento de 07/08/2026 encontrou dinheiro parado em cinco lugares, e
-- nenhum deles aparecia em relatório nenhum porque nenhum deles é um "erro":
-- são estados intermediários legítimos que ficaram parados.
--
--   • 5 alunos ESTUDANDO e praticamente nunca cobrados (um deles com 25 aulas em
--     60 dias e ZERO cobranças na vida). Não aparecem em inadimplência — não
--     estão atrasados, porque nunca foram cobrados.
--   • R$ 4.135,00 sendo cobrados de 3 alunos que não têm aula nem agenda.
--   • R$ 3.519,50 de fechamento PAGO sem nota fiscal (risco fiscal).
--   • R$ 2.286,00 de fechamento com NF anexada parado esperando o diretor.
--   • Aula confirmada pelo aluno e nunca lançada — o professor não recebeu.
--
-- `alunos_sem_assinatura` já cobre "sem cobrança recorrente" e já alimenta o
-- badge do menu. Esta função NÃO duplica aquilo: ela separa o caso grave
-- (nunca cobrado) e cobre as quatro lacunas restantes.
--
-- ⚠️ Reconciliação REPORTA, não corrige. Emitir cobrança, cancelar contrato e
-- aprovar fechamento são decisões comerciais do diretor. Auto-corrigir aqui
-- criaria cobrança para aluno que talvez tenha um acordo verbal — e o sistema
-- não sabe disso.

-- ⚠️ SEM `begin;`/`commit;` e RE-EXECUTÁVEL: o release aplica a lista inteira a
-- cada deploy, dentro da transação dele.

---------------------------------------------------------------------------
-- Reconciliação financeira do tenant.
---------------------------------------------------------------------------
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
  v_nunca_cobrado jsonb;
  v_cobrado_sem_estudar jsonb;
  v_arquivado_com_fatura jsonb;
  v_pago_sem_nf jsonb;
  v_parado_com_nf jsonb;
  v_aula_nao_lancada jsonb;
begin
  -- Mesmo padrão de `alunos_sem_assinatura`: o cron (service_role) entra
  -- direto; usuário logado precisa ser da direção.
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
  -- 1. ESTUDANDO E NUNCA COBRADO — a aula é entregue de graça.
  --
  -- Pior que inadimplência: o aluno não deve nada formalmente, porque a
  -- escola nunca pediu. Foi assim que uma aluna com 26 aulas em 60 dias
  -- acabou pedindo a chave PIX no WhatsApp — ela queria pagar e não havia
  -- fatura. Corte em <=1 cobrança na vida: quem tem 6-7 está sendo cobrado
  -- na mão todo mês e é outro problema (falta de recorrência).
  -------------------------------------------------------------------------
  select coalesce(jsonb_agg(x order by x.mensalidade desc), '[]'::jsonb) into v_nunca_cobrado
  from (
    select trim(p.full_name) as aluno,
           p.id as student_id,
           coalesce(p.monthly_fee, 0)::numeric(10,2) as mensalidade,
           p.created_at::date as matriculado,
           (select count(*) from public.v_payable_class_logs v
             where v.student_id = p.id and v.class_date >= current_date - 60)::int as aulas_60d,
           (select count(*) from public.student_payments sp where sp.student_id = p.id)::int as cobrancas_vida
      from public.profiles p
     where p.tenant_id = v_tenant
       and p.role = 'STUDENT'
       and coalesce(p.monthly_fee, 0) > 0
       and public.is_student_notifiable(p.id)
       and (select count(*) from public.student_payments sp where sp.student_id = p.id) <= 1
       and (select count(*) from public.v_payable_class_logs v
             where v.student_id = p.id and v.class_date >= current_date - 60) > 0
  ) x;

  -------------------------------------------------------------------------
  -- 2. COBRADO SEM ESTUDAR — fatura correndo para quem parou.
  --
  -- O inverso do item 1 e igualmente invisível: entra em inadimplência e
  -- parece "aluno que não paga", quando na verdade é aluno que saiu e ninguém
  -- encerrou. Cobrar quem saiu gera chamado no WhatsApp e some com a
  -- credibilidade da régua de cobrança.
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
       -- Sem agenda ativa E sem aula lançada em 90 dias: parou de verdade.
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
  -- 2b. ALUNO ARQUIVADO COM FATURA EM ABERTO — cobrança órfã.
  --
  -- O diretor arquivou o aluno, mas as faturas continuaram de pé. Elas não
  -- são cobradas de ninguém (o aluno saiu) e mesmo assim entram no total de
  -- inadimplência — foi exatamente isso que inflou o relatório de 07/08 em
  -- R$ 3.091,00 e fez dois ex-alunos parecerem os maiores devedores da
  -- escola. Ou se cancela a fatura, ou se cobra de verdade.
  --
  -- Este bucket é separado do 2 de propósito: lá o aluno ainda está ativo e a
  -- decisão é "encerrar ou cobrar"; aqui a decisão já foi tomada e só faltou
  -- limpar a cobrança.
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
  -- 3. FECHAMENTO PAGO SEM NOTA FISCAL — risco fiscal.
  --
  -- Dinheiro saiu, nota não entrou. 30 dias é a folga: abaixo disso o
  -- professor ainda está no prazo natural de emitir.
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
  -- 4. FECHAMENTO PARADO COM NF ANEXADA — esperando o diretor.
  --
  -- O professor fez a parte dele. Cada dia aqui é um dia que ele não recebe.
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
  -- 5. AULA CONFIRMADA PELO ALUNO E NUNCA LANÇADA.
  --
  -- O aluno diz que a aula aconteceu e não existe class_log: o professor não
  -- vai receber por ela. 7 dias de folga para o lançamento normal.
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
    'nunca_cobrado', jsonb_build_object(
      'itens', v_nunca_cobrado,
      'qtd', jsonb_array_length(v_nunca_cobrado),
      'mensal', (select coalesce(sum((i->>'mensalidade')::numeric), 0)
                   from jsonb_array_elements(v_nunca_cobrado) i)
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
-- Badge do menu: a reconciliação vira número no item "Dinheiro".
--
-- ⚠️ Redefinição COMPLETA de `director_pending_counts` — as chaves que já
-- existiam são preservadas uma a uma. Perder uma delas apagaria em silêncio o
-- badge de outra tela.
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
    -- Aluno tendo aula que ninguém está cobrando.
    'sem_assinatura', coalesce((alunos_sem_assinatura(v_tenant)->>'alunos')::int, 0),
    -- NOVO: soma das pendências de reconciliação, no item "Dinheiro".
    'reconciliacao', coalesce((v_recon->'nunca_cobrado'->>'qtd')::int, 0)
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
