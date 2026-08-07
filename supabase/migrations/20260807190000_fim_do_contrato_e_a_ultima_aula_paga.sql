-- O contrato acaba um mês DEPOIS da última cobrança.
--
-- ERRO CORRIGIDO (apontado pelo diretor em 07/08/2026): eu tratei o `endDate`
-- da assinatura Asaas como fim do contrato. Ele é a data da ÚLTIMA COBRANÇA.
-- A parcela vencida naquele dia paga o mês SEGUINTE de aula.
--
-- Prova nas faturas reais, e o erro aparecia na aritmética:
--
--   Bianca Crepaldi — 6 parcelas, de 12/03 a 12/08. A de 12/08 cobre 12/08 a
--   12/09. Contrato de 6 meses assinado em 11/03 termina em SETEMBRO.
--   Lendo `endDate` como fim, o contrato de 6 meses durava 5,2 meses — e o de
--   12 meses durava 11,8. Não fechava com nada, e eu não conferi.
--
--   Com o +1 mês, os 12 alunos batem: 6,2 a 6,8 meses nos contratos de 6, e
--   12,3 a 13,5 nos de 12 (a folga é o intervalo entre a matrícula e a
--   primeira cobrança).
--
-- Consequência do erro: TODAS as datas de renovação saíam um mês adiantadas.
-- Duas alunas foram classificadas como "contrato encerrado" quando ainda tinham
-- um mês pago pela frente, e a mensagem de renovação as avisaria em cima de uma
-- data errada — o pior tipo de erro numa conversa comercial.

-- ⚠️ SEM `begin;`/`commit;` e RE-EXECUTÁVEL.

---------------------------------------------------------------------------
-- A regra, num lugar só. Toda tela e toda mensagem passam por aqui.
---------------------------------------------------------------------------
create or replace function public.fim_do_servico(p_ultima_cobranca date)
returns date
language sql
immutable
set search_path to 'public'
as $$
  -- A última parcela paga o mês seguinte de aula.
  select case when p_ultima_cobranca is null then null
              else (p_ultima_cobranca + interval '1 month')::date end;
$$;

alter function public.fim_do_servico(date) owner to postgres;

---------------------------------------------------------------------------
-- Painel de renovação, agora com a data certa.
--
-- ⚠️ Mudou também o SIGNIFICADO dos dois blocos:
--   • "encerrado" = o serviço PAGO já acabou. É aula sendo dada de graça hoje.
--   • "vencendo"  = ainda há mês pago pela frente; é hora de conversar.
--
-- Antes, quem tinha a cobrança encerrada na Asaas caía direto em "encerrado",
-- mesmo com um mês pago pela frente. Isso apagava a única janela útil: o mês em
-- que ainda dá para renovar antes de a aula virar prejuízo.
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

  -- VENCENDO: ainda há aula paga pela frente, dentro de 90 dias.
  select coalesce(jsonb_agg(x order by x.termina), '[]'::jsonb) into v_vencendo
  from (
    select trim(p.full_name) as aluno,
           p.id as student_id,
           coalesce(p.monthly_fee, 0)::numeric(10,2) as mensalidade,
           public.fim_do_servico(p.asaas_subscription_end_date) as termina,
           (public.fim_do_servico(p.asaas_subscription_end_date) - current_date)::int as dias,
           -- A Asaas já parou de gerar cobrança? Muda a urgência: não basta
           -- renovar, é preciso religar o faturamento.
           (upper(coalesce(p.asaas_subscription_status, '')) in ('EXPIRED', 'INACTIVE', 'NOT_FOUND')) as cobranca_parada,
           g.professor,
           g.horarios
      from public.profiles p
      cross join lateral (
        select
          (select trim(t.full_name)
             from public.class_logs cl
             join public.profiles t on t.id = cl.teacher_id
            where cl.student_id = p.id and cl.class_date >= current_date - 90
            group by t.full_name order by count(*) desc limit 1) as professor,
          (select string_agg(distinct b.day_of_week || ' ' || b.time_slot, ', ')
             from public.bookings b
            where b.student_id = p.id and b.status = 'SCHEDULED') as horarios
      ) g
     where p.tenant_id = v_tenant
       and p.role = 'STUDENT'
       and public.is_student_notifiable(p.id)
       and p.asaas_subscription_end_date is not null
       and public.fim_do_servico(p.asaas_subscription_end_date) >= current_date
       and public.fim_do_servico(p.asaas_subscription_end_date) <= current_date + 90
       and exists (select 1 from public.class_logs cl
                    where cl.student_id = p.id and cl.class_date >= current_date - 60)
  ) x;

  -- ENCERRADO: o mês pago já passou e o aluno continua tendo aula.
  select coalesce(jsonb_agg(x order by x.termina nulls first), '[]'::jsonb) into v_encerrado
  from (
    select trim(p.full_name) as aluno,
           p.id as student_id,
           coalesce(p.monthly_fee, 0)::numeric(10,2) as mensalidade,
           coalesce(p.asaas_subscription_status, '?') as situacao,
           public.fim_do_servico(p.asaas_subscription_end_date) as termina,
           (current_date - public.fim_do_servico(p.asaas_subscription_end_date))::int as dias_de_graca,
           (select count(*) from public.v_payable_class_logs v
             where v.student_id = p.id and v.class_date >= current_date - 60)::int as aulas_60d
      from public.profiles p
     where p.tenant_id = v_tenant
       and p.role = 'STUDENT'
       and public.is_student_notifiable(p.id)
       and coalesce(p.subscription_id, '') <> ''
       and (
         -- Sem data (assinatura sumiu) mas com status morto, ou data já passada.
         (p.asaas_subscription_end_date is null
           and upper(coalesce(p.asaas_subscription_status, '')) in ('EXPIRED', 'INACTIVE', 'NOT_FOUND'))
         or public.fim_do_servico(p.asaas_subscription_end_date) < current_date
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
-- A mensagem, com a data que o aluno vai conferir no próprio calendário.
---------------------------------------------------------------------------
create or replace function public.ofertas_de_renovacao(
  p_tenant text default null,
  p_dias int default null
)
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
  v_dias int;
  v_itens jsonb;
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

  v_dias := coalesce(p_dias,
                     (select dias_antes from public.renewal_offer_settings where tenant_id = v_tenant),
                     15);

  select coalesce(jsonb_agg(x order by x.termina), '[]'::jsonb) into v_itens
  from (
    select trim(p.full_name) as aluno,
           p.id as student_id,
           public.fim_do_servico(p.asaas_subscription_end_date) as termina,
           (public.fim_do_servico(p.asaas_subscription_end_date) - current_date)::int as dias,
           coalesce(p.monthly_fee, 0)::numeric(10,2) as paga_hoje,
           f.freq,
           prof.professor,
           pl.p12,
           'Oi ' || split_part(btrim(p.full_name), ' ', 1) || '! 🐺 '
             || 'Seus horários com '
             || coalesce(split_part(prof.professor, ' ', 1), 'seu professor')
             || ' vão até ' || to_char(public.fim_do_servico(p.asaas_subscription_end_date), 'DD/MM') || '.'
             || E'\n\n'
             || 'Quer seguir com a gente? Pode renovar por mais 6 meses mantendo sua mensalidade de R$ '
             || public.brl_texto(coalesce(p.monthly_fee, 0))
             || case
                  when pl.p12 is not null and pl.p12 < coalesce(p.monthly_fee, 0)
                    then ', ou fechar 12 meses e ela cai para R$ ' || public.brl_texto(pl.p12)
                         || ' — R$ ' || public.brl_texto(coalesce(p.monthly_fee, 0) - pl.p12)
                         || ' a menos por mês.'
                  when pl.p12 is not null
                    then ', ou fechar 12 meses por R$ ' || public.brl_texto(pl.p12) || '.'
                  else '.'
                end
             || E'\n\n'
             || 'Do jeito que for melhor pra você. Me avisa? 😊' as mensagem
      from public.profiles p
      cross join lateral (select public.frequencia_efetiva(p.id) as freq) f
      cross join lateral (
        select (select trim(t.full_name)
                  from public.class_logs cl
                  join public.profiles t on t.id = cl.teacher_id
                 where cl.student_id = p.id and cl.class_date >= current_date - 90
                 group by t.full_name order by count(*) desc limit 1) as professor
      ) prof
      cross join lateral (
        select (select monthly_price from public.student_pricing_plans sp
                 where sp.tenant_id = v_tenant and sp.active
                   and sp.classes_per_week = f.freq and sp.fidelity_months = 12 limit 1) as p12
      ) pl
     where p.tenant_id = v_tenant
       and p.role = 'STUDENT'
       and public.is_student_notifiable(p.id)
       -- Aluno mensal (sem data de fim) não recebe oferta. Regra do diretor.
       and p.asaas_subscription_end_date is not null
       and public.fim_do_servico(p.asaas_subscription_end_date) >= current_date
       and public.fim_do_servico(p.asaas_subscription_end_date) <= current_date + v_dias
       and exists (select 1 from public.class_logs cl
                    where cl.student_id = p.id and cl.class_date >= current_date - 60)
  ) x;

  return jsonb_build_object(
    'ok', true,
    'ativo', coalesce((select is_active from public.renewal_offer_settings where tenant_id = v_tenant), false),
    'dias_antes', v_dias,
    'itens', v_itens,
    'qtd', jsonb_array_length(v_itens)
  );
end;
$$;

alter function public.ofertas_de_renovacao(text, int) owner to postgres;
grant execute on function public.ofertas_de_renovacao(text, int) to authenticated;
