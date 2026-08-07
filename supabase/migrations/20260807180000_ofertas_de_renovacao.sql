-- Oferta de renovação: leve, no fim do contrato, com as duas opções.
--
-- REGRAS DE NEGÓCIO (decididas pelo diretor em 07/08/2026, e cada uma tem um
-- porquê que o código não pode "otimizar" depois):
--
-- 1. ALUNO MENSAL NÃO RECEBE NADA. Quem escolheu mensal quer mensal. A escola
--    vai mantendo até o aluno dizer que quer parar — e perguntar todo mês se
--    ele quer continuar é criar um ponto de cancelamento que não existia.
--    Aqui isso é `asaas_subscription_end_date is not null`: sem data de fim,
--    não é contrato, é mensal, e some da lista.
--
-- 2. NÃO EMPURRAR 12 MESES. A oferta apresenta manter 6 meses E migrar para 12,
--    nessa ordem. Quem está bem no plano atual não deve sentir que precisa
--    justificar por que não quer o maior.
--
-- 3. SÓ QUANDO O CONTRATO ESTÁ REALMENTE ACABANDO. O painel enxerga 90 dias
--    para o diretor se organizar; a MENSAGEM é para os últimos dias.
--
-- 4. PREÇO NUNCA É INVENTADO. Todo valor sai de `student_pricing_plans`. Um
--    agente de IA que compõe o número livre é o mesmo erro que fez uma frase
--    fixa dizer a 8 alunas que não precisavam pagar matrícula. Aqui o texto já
--    sai pronto, com os valores calculados no banco.
--
-- ⚠️ Preços personalizados são INTENCIONAIS nesta escola. Aluno cuja
-- mensalidade não bate com a tabela não é erro e não vira alerta — a oferta só
-- compara com o catálogo para calcular a economia, e se não houver plano
-- correspondente ela omite o número em vez de inventar um.

-- ⚠️ SEM `begin;`/`commit;` e RE-EXECUTÁVEL.

---------------------------------------------------------------------------
-- Configuração por escola. NASCE DESLIGADA.
--
-- Mesma disciplina do `dre_report_settings`: nada é enviado a aluno nenhum
-- até o diretor ler o texto e ligar. Automação de cobrança/renovação que
-- nasce ligada manda mensagem para cliente real antes de alguém revisar.
---------------------------------------------------------------------------
create table if not exists public.renewal_offer_settings (
  tenant_id     text primary key,
  is_active     boolean not null default false,
  dias_antes    int not null default 15,
  assinatura    text,
  updated_by    uuid,
  updated_at    timestamptz not null default now(),
  constraint renewal_dias_antes_chk check (dias_antes between 1 and 90)
);

alter table public.renewal_offer_settings owner to postgres;
alter table public.renewal_offer_settings enable row level security;
grant select on public.renewal_offer_settings to authenticated;

drop policy if exists ros_select on public.renewal_offer_settings;
create policy ros_select on public.renewal_offer_settings
  for select to authenticated
  using (tenant_id = public._my_tenant_id() or public._my_role() = 'SUPER_ADMIN');

---------------------------------------------------------------------------
-- Frequência efetiva do aluno: o cadastro mente com frequência.
--
-- `class_frequency` está nulo em vários alunos ativos (a Ana Clara Sant'Ana,
-- com 3 horários fixos, tem o campo vazio). A agenda é a fonte confiável —
-- é ela que gera aula e, portanto, dinheiro.
---------------------------------------------------------------------------
---------------------------------------------------------------------------
-- Dinheiro em português. `to_char` segue o lc_numeric do banco, que aqui usa
-- ponto decimal — "R$ 261.00" numa mensagem para aluno brasileiro parece erro
-- de sistema e derruba a credibilidade da oferta antes de ela ser lida.
---------------------------------------------------------------------------
create or replace function public.brl_texto(v numeric)
returns text
language sql
immutable
set search_path to 'public'
as $$
  -- Troca ponto por vírgula e vírgula por ponto de uma vez (o '#' é o pivô).
  select replace(replace(replace(
           to_char(coalesce(v, 0), 'FM999G999G990D00'),
         '.', '#'), ',', '.'), '#', ',');
$$;

alter function public.brl_texto(numeric) owner to postgres;

create or replace function public.frequencia_efetiva(p_student uuid)
returns int
language sql
stable
set search_path to 'public'
as $$
  select coalesce(
    nullif((select count(distinct b.day_of_week || b.time_slot)
              from public.bookings b
             where b.student_id = p_student and b.status = 'SCHEDULED'), 0),
    nullif((regexp_replace(coalesce((select class_frequency from public.profiles where id = p_student), ''),
                           '\D', '', 'g'))::int, 0),
    0
  )::int;
$$;

alter function public.frequencia_efetiva(uuid) owner to postgres;

---------------------------------------------------------------------------
-- As ofertas prontas, com o texto já montado.
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

  -- Janela: o cron usa `dias_antes` da escola; a tela pode pedir 90 para o
  -- diretor enxergar longe. O padrão é a configuração.
  v_dias := coalesce(p_dias,
                     (select dias_antes from public.renewal_offer_settings where tenant_id = v_tenant),
                     15);

  select coalesce(jsonb_agg(x order by x.termina), '[]'::jsonb) into v_itens
  from (
    select trim(p.full_name) as aluno,
           p.id as student_id,
           split_part(btrim(p.full_name), ' ', 1) as primeiro_nome,
           p.asaas_subscription_end_date as termina,
           (p.asaas_subscription_end_date - current_date)::int as dias,
           coalesce(p.monthly_fee, 0)::numeric(10,2) as paga_hoje,
           f.freq,
           prof.professor,
           pl.p12,
           pl.p6,
           pl.avulso,
           -- Economia só existe se houver plano de 12m para essa frequência.
           case when pl.p12 is not null and pl.avulso is not null and pl.avulso > 0
                then round((pl.avulso - pl.p12) / pl.avulso * 100)::int end as economia_pct,
           -- Texto pronto, no formato pedido: sem enumerar dia a dia, citando o
           -- professor e a data, e com as DUAS opções (manter 6m primeiro).
           -- ⚠️ SEM artigo antes do nome do professor ("com Débora", não "com o
           -- teacher Débora"). O sistema não guarda o gênero de ninguém, e
           -- deduzir a partir do nome erra com pessoa real na frente — a
           -- primeira versão deste texto escreveu "o teacher Debora".
           'Oi ' || split_part(btrim(p.full_name), ' ', 1) || '! 🐺 '
             || 'Seus horários com '
             || coalesce(split_part(prof.professor, ' ', 1), 'seu professor')
             || ' vão até ' || to_char(p.asaas_subscription_end_date, 'DD/MM') || '.'
             || E'\n\n'
             || 'Quer seguir com a gente? Dá pra renovar por mais 6 meses mantendo tudo como está'
             || case when pl.p6 is not null then ' (R$ ' || public.brl_texto(pl.p6) || ')' else '' end
             || case when pl.p12 is not null
                     then ', ou por 12 meses e sua mensalidade cai para R$ '
                          || public.brl_texto(pl.p12)
                          || case when pl.avulso is not null and pl.avulso > 0
                                  then ' — ' || round((pl.avulso - pl.p12) / pl.avulso * 100)::int
                                       || '% abaixo do valor sem compromisso (R$ '
                                       || public.brl_texto(pl.avulso) || ')'
                                  else '' end
                          || '.'
                     else '.' end
             || E'\n\n'
             || 'Do jeito que for melhor pra você. Me avisa? 😊' as mensagem
      from public.profiles p
      cross join lateral (select public.frequencia_efetiva(p.id) as freq) f
      cross join lateral (
        select (select trim(t.full_name)
                  from public.class_logs cl
                  join public.profiles t on t.id = cl.teacher_id
                 where cl.student_id = p.id and cl.class_date >= current_date - 90
                 group by t.full_name
                 order by count(*) desc
                 limit 1) as professor
      ) prof
      cross join lateral (
        select
          (select monthly_price from public.student_pricing_plans sp
            where sp.tenant_id = v_tenant and sp.active
              and sp.classes_per_week = f.freq and sp.fidelity_months = 12 limit 1) as p12,
          (select monthly_price from public.student_pricing_plans sp
            where sp.tenant_id = v_tenant and sp.active
              and sp.classes_per_week = f.freq and sp.fidelity_months = 6 limit 1) as p6,
          (select monthly_price from public.student_pricing_plans sp
            where sp.tenant_id = v_tenant and sp.active
              and sp.classes_per_week = f.freq and sp.fidelity_months = 1 limit 1) as avulso
      ) pl
     where p.tenant_id = v_tenant
       and p.role = 'STUDENT'
       and public.is_student_notifiable(p.id)
       -- ⚠️ REGRA 1: sem data de fim = aluno MENSAL = não recebe oferta.
       and p.asaas_subscription_end_date is not null
       and p.asaas_subscription_end_date >= current_date
       and p.asaas_subscription_end_date <= current_date + v_dias
       -- Só quem está de fato estudando.
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

---------------------------------------------------------------------------
-- O diretor liga/desliga e ajusta a antecedência.
---------------------------------------------------------------------------
create or replace function public.save_renewal_offer_settings(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := (select auth.uid());
  v_tenant text := public._my_tenant_id();
  v_role text := public._my_role();
  v_dias int;
begin
  if v_uid is null or v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'Não autenticado');
  end if;
  if v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    return jsonb_build_object('ok', false, 'error', 'Sem permissão');
  end if;

  v_dias := coalesce((p_payload->>'dias_antes')::int, 15);
  if v_dias < 1 or v_dias > 90 then
    return jsonb_build_object('ok', false, 'error', 'Antecedência deve ficar entre 1 e 90 dias');
  end if;

  insert into public.renewal_offer_settings (tenant_id, is_active, dias_antes, assinatura, updated_by, updated_at)
  values (v_tenant,
          coalesce((p_payload->>'is_active')::boolean, false),
          v_dias,
          btrim(p_payload->>'assinatura'),
          v_uid, now())
  on conflict (tenant_id) do update set
    is_active  = excluded.is_active,
    dias_antes = excluded.dias_antes,
    assinatura = excluded.assinatura,
    updated_by = excluded.updated_by,
    updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

alter function public.save_renewal_offer_settings(jsonb) owner to postgres;
grant execute on function public.save_renewal_offer_settings(jsonb) to authenticated;
