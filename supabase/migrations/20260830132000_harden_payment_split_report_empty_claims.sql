-- Internal database workers can run without PostgREST JWT claims. PostgreSQL
-- represents a reset custom GUC as an empty string, which is not valid JSON.
-- Keep the existing authorization semantics while making that trusted path
-- deterministic instead of raising before the monthly close is calculated.
create or replace function public.payment_split_breakdown(p_payment_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path to 'public'
as $function$
declare
  v_jwt_role text; v_caller_role text; v_caller_tenant text;
  v_pay record; v_tenant text; v_mes text; v_ini date; v_fim date;
  v_dizimo_pct numeric; v_investimento_pct numeric; v_ativo boolean;
  v_prof_dizimo_pct numeric; v_prof_investimento_pct numeric; v_prof_prolabore_pct numeric;
  v_custo numeric; v_aulas int; v_liquido numeric;
  v_professores jsonb; v_aluno text;
  v_na_base boolean; v_dizimo numeric; v_investimento numeric;
  v_pro_labore numeric; v_aulas_pl int; v_sobra numeric;
  v_escola_pct numeric; v_share numeric;
  v_base_pl numeric; v_base_prof numeric;
  v_dz_pl numeric; v_inv_pl numeric; v_esc_pl numeric; v_pl_pl numeric;
  v_dz_pr numeric; v_inv_pr numeric; v_pl_pr numeric; v_esc_pr numeric;
begin
  select coalesce(
           nullif(btrim(current_setting('request.jwt.claims', true)), '')::jsonb ->> 'role',
           ''
         )
    into v_jwt_role;

  select sp.id, sp.student_id, sp.value, sp.tenant_id, sp.description, sp.payment_type,
         coalesce(sp.paid_at, sp.payment_date, sp.due_date) as quando,
         sp.created_at
    into v_pay
    from student_payments sp where sp.id = p_payment_id;
  if not found then return jsonb_build_object('error','pagamento_nao_encontrado'); end if;

  v_tenant := coalesce(v_pay.tenant_id,
                       (select p.tenant_id from profiles p where p.id = v_pay.student_id));
  if v_tenant is null then return jsonb_build_object('error','escola_nao_identificada'); end if;

  if v_jwt_role in ('anon','authenticated') then
    select role, tenant_id into v_caller_role, v_caller_tenant
      from profiles where id = auth.uid();
    if v_caller_role is null or v_caller_role not in ('SCHOOL_ADMIN','SUPER_ADMIN') then
      return jsonb_build_object('error','sem_permissao');
    end if;
    if v_caller_role <> 'SUPER_ADMIN' and v_caller_tenant is distinct from v_tenant then
      return jsonb_build_object('error','sem_permissao');
    end if;
  end if;

  select s.dizimo_pct, s.investimento_pct, s.escola_pct, s.is_active,
         s.prof_dizimo_pct, s.prof_investimento_pct, s.prof_prolabore_pct
    into v_dizimo_pct, v_investimento_pct, v_escola_pct, v_ativo,
         v_prof_dizimo_pct, v_prof_investimento_pct, v_prof_prolabore_pct
    from payment_split_settings s where s.tenant_id = v_tenant;
  if not found then
    v_dizimo_pct := 10.00; v_investimento_pct := 10.00;
    v_escola_pct := 0.00; v_ativo := false;
    v_prof_dizimo_pct := 10.00; v_prof_investimento_pct := 70.00; v_prof_prolabore_pct := 20.00;
  end if;

  v_mes := to_char(coalesce(v_pay.quando, now()), 'YYYY-MM');
  v_ini := (v_mes || '-01')::date;
  v_fim := (date_trunc('month', v_ini) + interval '1 month - 1 day')::date;

  select btrim(p.full_name) into v_aluno from profiles p where p.id = v_pay.student_id;

  with aulas as (
    select b.teacher_id,
           d::date as dia,
           teacher_student_rate(b.teacher_id, b.student_id, d::date) as rate,
           exists (select 1 from payment_split_owner_teachers o
                    where o.tenant_id = v_tenant and o.teacher_id = b.teacher_id) as pro_labore
      from bookings b
      cross join generate_series(v_ini, v_fim, '1 day') d
     where b.student_id = v_pay.student_id
       and coalesce(b.status,'SCHEDULED') = 'SCHEDULED'
       and dow_name_to_int(b.day_of_week) = extract(dow from d)::int
       and (b.start_date is null or d >= b.start_date)
  )
  select coalesce(count(*),0)::int,
         coalesce(sum(a.rate) filter (where not a.pro_labore), 0),
         coalesce(count(*) filter (where a.pro_labore),0)::int
    into v_aulas, v_custo, v_aulas_pl
    from aulas a;

  select coalesce(jsonb_agg(jsonb_build_object(
           'teacher_id', z.teacher_id,
           'teacher_name', coalesce(btrim(t.full_name), 'Professor não identificado'),
           'aulas', z.n,
           'custo', case when z.pro_labore then null else round(z.custo,2) end,
           'descontado', not z.pro_labore) order by z.custo desc), '[]'::jsonb)
    into v_professores
    from (
      select b.teacher_id, count(*)::int as n,
             sum(teacher_student_rate(b.teacher_id, b.student_id, d::date)) as custo,
             exists (select 1 from payment_split_owner_teachers o
                      where o.tenant_id = v_tenant and o.teacher_id = b.teacher_id) as pro_labore
        from bookings b
        cross join generate_series(v_ini, v_fim, '1 day') d
       where b.student_id = v_pay.student_id
         and coalesce(b.status,'SCHEDULED') = 'SCHEDULED'
         and dow_name_to_int(b.day_of_week) = extract(dow from d)::int
         and (b.start_date is null or d >= b.start_date)
       group by b.teacher_id) z
    left join profiles t on t.id = z.teacher_id;

  v_liquido := greatest(coalesce(v_pay.value,0) - coalesce(v_custo,0), 0);
  v_na_base := (v_pay.student_id is not null);
  v_share := case when v_aulas > 0 then v_aulas_pl::numeric / v_aulas else 0 end;

  if not v_na_base then
    v_dizimo := 0; v_investimento := 0; v_pro_labore := 0; v_sobra := round(v_liquido, 2);
  else
    v_base_pl   := round(v_liquido * v_share, 2);
    v_base_prof := round(v_liquido - v_base_pl, 2);

    v_dz_pl  := round(v_base_pl * v_dizimo_pct / 100.0, 2);
    v_inv_pl := round(v_base_pl * v_investimento_pct / 100.0, 2);
    v_esc_pl := round(v_base_pl * coalesce(v_escola_pct,0) / 100.0, 2);
    v_pl_pl  := greatest(v_base_pl - v_dz_pl - v_inv_pl - v_esc_pl, 0);

    v_dz_pr  := round(v_base_prof * v_prof_dizimo_pct / 100.0, 2);
    v_inv_pr := round(v_base_prof * v_prof_investimento_pct / 100.0, 2);
    v_pl_pr  := round(v_base_prof * v_prof_prolabore_pct / 100.0, 2);
    v_esc_pr := greatest(v_base_prof - v_dz_pr - v_inv_pr - v_pl_pr, 0);

    v_dizimo       := v_dz_pl + v_dz_pr;
    v_investimento := v_inv_pl + v_inv_pr;
    v_pro_labore   := v_pl_pl + v_pl_pr;
    v_sobra := round(v_liquido - v_dizimo - v_investimento - v_pro_labore, 2);

    if v_sobra < 0 then
      v_pro_labore := round(v_pro_labore + v_sobra, 2);
      v_sobra := 0;
    end if;
  end if;

  return jsonb_build_object(
    'payment_id',   v_pay.id,
    'tenant_id',    v_tenant,
    'is_active',    coalesce(v_ativo,false),
    'month',        v_mes,
    'paid_at',      v_pay.quando,
    'ref_date',     coalesce(v_pay.created_at, now())::date,
    'student_id',   v_pay.student_id,
    'student_name', coalesce(v_aluno, 'sem aluno vinculado'),
    'sem_aluno',    (v_pay.student_id is null),
    'sem_agenda',   (v_aulas = 0),
    'na_base',      v_na_base,
    'description',  v_pay.description,
    'valor',        round(coalesce(v_pay.value,0),2),
    'aulas_previstas', v_aulas,
    'aulas_pro_labore', v_aulas_pl,
    'custo_professor', round(coalesce(v_custo,0),2),
    'pro_labore',   round(coalesce(v_pro_labore,0),2),
    'professores',  v_professores,
    'liquido',      round(v_liquido,2),
    'dizimo_pct',   case when v_liquido > 0 then round(v_dizimo * 100.0 / v_liquido, 2) else v_dizimo_pct end,
    'investimento_pct', case when v_liquido > 0 then round(v_investimento * 100.0 / v_liquido, 2) else v_investimento_pct end,
    'escola_pct',   v_escola_pct,
    'regra',        case when v_share >= 1 then 'direcao'
                         when v_share <= 0 then 'professor'
                         else 'misto' end,
    'dizimo',       v_dizimo,
    'investimento', v_investimento,
    'sobra',        v_sobra);
end;
$function$;

alter function public.payment_split_breakdown(uuid) owner to postgres;
comment on function public.payment_split_breakdown(uuid) is
  'Rateio de um pagamento sobre o líquido (valor − salário previsto do professor). Duas réguas preservadas; workers internos sem claims vazios são aceitos com segurança.';

revoke all on function public.payment_split_breakdown(uuid) from public;
grant execute on function public.payment_split_breakdown(uuid) to authenticated, service_role;

create or replace function public.payment_split_report(
  p_month text default null, p_tenant text default null)
returns jsonb
language plpgsql stable security definer
set search_path to 'public'
as $function$
declare
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text;
begin
  v_jwt_role := coalesce(
    nullif(btrim(current_setting('request.jwt.claims', true)), '')::jsonb ->> 'role',
    ''
  );
  select role, tenant_id into v_caller_role, v_tenant from profiles where id = auth.uid();
  if v_jwt_role in ('anon','authenticated') then
    if v_caller_role is null or v_caller_role not in ('SCHOOL_ADMIN','SUPER_ADMIN') then
      return jsonb_build_object('error','sem_permissao');
    end if;
    if v_caller_role = 'SUPER_ADMIN' then v_tenant := coalesce(p_tenant, v_tenant); end if;
  else
    v_tenant := coalesce(p_tenant, v_tenant);
  end if;
  if v_tenant is null then return jsonb_build_object('error','escola_nao_identificada'); end if;

  v_month := coalesce(p_month, to_char(current_date,'YYYY-MM'));
  if v_month !~ '^\d{4}-\d{2}$' then return jsonb_build_object('error','mes_invalido'); end if;

  return (
  with pagos as (
    select sp.id, coalesce(sp.paid_at, sp.payment_date, sp.due_date) as quando
      from student_payments sp
     where sp.tenant_id = v_tenant
       and sp.status in ('RECEIVED','RECEIVED_IN_CASH')
       and coalesce(sp.value,0) > 0
       and to_char(coalesce(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
  ), rateado as (
    select p.quando, payment_split_breakdown(p.id) as b from pagos p
  )
  select jsonb_build_object(
    'month', v_month,
    'pagamentos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'payment_id',      r.b->>'payment_id',
               'aluno',           r.b->>'student_name',
               'quando',          r.quando,
               'valor',           (r.b->>'valor')::numeric,
               'custo_professor', (r.b->>'custo_professor')::numeric,
               'pro_labore',      (r.b->>'pro_labore')::numeric,
               'professores',     r.b->'professores',
               'liquido',         (r.b->>'liquido')::numeric,
               'dizimo',          (r.b->>'dizimo')::numeric,
               'investimento',    (r.b->>'investimento')::numeric,
               'sobra',           (r.b->>'sobra')::numeric,
               'sem_aluno',       (r.b->>'sem_aluno')::boolean,
               'na_base',         (r.b->>'na_base')::boolean)
             order by r.quando desc)
        from rateado r), '[]'::jsonb),
    'totais', (select jsonb_build_object(
        'pagamentos',      count(*)::int,
        'recebido',        round(coalesce(sum((r.b->>'valor')::numeric),0),2),
        'custo_professor', round(coalesce(sum((r.b->>'custo_professor')::numeric),0),2),
        'pro_labore',      round(coalesce(sum((r.b->>'pro_labore')::numeric),0),2),
        'liquido',         round(coalesce(sum((r.b->>'liquido')::numeric)
                                   filter (where (r.b->>'na_base')::boolean),0),2),
        'dizimo',          round(coalesce(sum((r.b->>'dizimo')::numeric),0),2),
        'investimento',    round(coalesce(sum((r.b->>'investimento')::numeric),0),2),
        'sobra',           round(coalesce(sum((r.b->>'sobra')::numeric),0),2),
        'fora_da_base',    round(coalesce(sum((r.b->>'valor')::numeric)
                                   filter (where not (r.b->>'na_base')::boolean),0),2),
        'fora_da_base_n',  count(*) filter (where not (r.b->>'na_base')::boolean)::int
      ) from rateado r),
    'sem_aluno', (select count(*)::int from rateado r where (r.b->>'sem_aluno')::boolean)));
end;
$function$;

alter function public.payment_split_report(text, text) owner to postgres;
comment on function public.payment_split_report(text, text) is
  'Rateio de todos os pagamentos do mês com os totais de dízimo e investimento. Aceita workers internos sem claims e usa payment_split_breakdown como regra única.';

revoke all on function public.payment_split_report(text, text) from public;
grant execute on function public.payment_split_report(text, text) to authenticated, service_role;

create or replace function public.dre_gerencial(
  p_month text default null, p_tenant text default null)
returns jsonb
language plpgsql stable security definer
set search_path to 'public'
as $function$
declare
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text;
  v_receita numeric; v_deducoes numeric;
  v_custo_aulas numeric; v_custo_ajustes numeric; v_custo_outros numeric;
  v_desp_vendedor numeric; v_desp_indicacao numeric; v_desp_ledger numeric;
  v_barrado numeric;
  v_aulas int; v_alunos int;
  v_receita_liq numeric; v_custo numeric; v_lucro_bruto numeric;
  v_despesas numeric; v_resultado numeric;
  v_linhas jsonb; v_linhas_ledger jsonb; v_alertas jsonb := '[]'::jsonb;
begin
  v_jwt_role := coalesce(
    nullif(btrim(current_setting('request.jwt.claims', true)), '')::jsonb ->> 'role',
    ''
  );
  select role, tenant_id into v_caller_role, v_tenant from profiles where id = auth.uid();
  if v_jwt_role in ('anon','authenticated') then
    if v_caller_role is null or v_caller_role not in ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') then
      raise exception 'Apenas a direção pode ver o resultado da escola';
    end if;
    if v_caller_role = 'SUPER_ADMIN' then v_tenant := coalesce(p_tenant, v_tenant); end if;
  else
    v_tenant := coalesce(p_tenant, v_tenant);
  end if;
  if v_tenant is null then raise exception 'Escola não identificada'; end if;

  v_month := coalesce(p_month, to_char(current_date,'YYYY-MM'));
  if v_month !~ '^\d{4}-\d{2}$' then raise exception 'Mês inválido (use YYYY-MM)'; end if;

  select coalesce(sum(value),0) into v_receita
  from student_payments
  where tenant_id = v_tenant and status in ('RECEIVED','RECEIVED_IN_CASH')
    and to_char(coalesce(paid_at, payment_date, due_date),'YYYY-MM') = v_month;

  select coalesce(sum(custo_aulas),0), coalesce(sum(aulas),0)
    into v_custo_aulas, v_aulas
  from v_teacher_cost_competencia
  where tenant_id = v_tenant and month_year = v_month;

  select coalesce(sum(amount),0) into v_custo_ajustes
  from closing_adjustments
  where tenant_id = v_tenant and month_year = v_month;

  select count(distinct v.student_id) into v_alunos
  from v_payable_class_logs v join profiles t on t.id = v.teacher_id
  where t.tenant_id = v_tenant and to_char(v.class_date,'YYYY-MM') = v_month
    and v.student_id is not null;

  select coalesce(sum(amount_brl),0) into v_desp_vendedor
  from vendor_commissions
  where tenant_id = v_tenant and status='PAID' and to_char(paid_at,'YYYY-MM') = v_month;

  select coalesce(sum(amount_brl),0) into v_desp_indicacao
  from referral_rewards
  where tenant_id = v_tenant and status='PAID' and to_char(paid_at,'YYYY-MM') = v_month;

  select
    coalesce(sum(t.valor) filter (where not t.barrado and t.kind = 'DEDUCAO'), 0),
    coalesce(sum(t.valor) filter (where not t.barrado and t.kind = 'CUSTO'),   0),
    coalesce(sum(t.valor) filter (where not t.barrado and t.kind = 'DESPESA'), 0),
    coalesce(sum(t.valor) filter (where t.barrado), 0),
    coalesce(jsonb_agg(jsonb_build_object(
        'code', t.code, 'label', t.label, 'kind', t.kind,
        'valor', round(t.valor,2), 'fonte','caixa (saídas classificadas)',
        'sort', t.sort_order) order by t.sort_order)
      filter (where not t.barrado), '[]'::jsonb)
    into v_deducoes, v_custo_outros, v_desp_ledger, v_barrado, v_linhas_ledger
  from (
    select
      coalesce(a.code,       '6.9.99') as code,
      coalesce(a.label,      'Outras despesas') as label,
      coalesce(a.kind,       'DESPESA') as kind,
      coalesce(a.sort_order, 990) as sort_order,
      not coalesce(a.ledger_allowed, true) as barrado,
      sum(ft.amount) as valor
    from financial_transactions ft
    left join dre_category_map m on m.tenant_id = ft.tenant_id and m.category = ft.category
    left join dre_accounts a on a.code = coalesce(ft.account_code, m.account_code)
    where ft.tenant_id = v_tenant and ft.type = 'SAIDA'
      and to_char(coalesce(ft.occurred_at, ft.created_at),'YYYY-MM') = v_month
    group by 1,2,3,4,5
  ) t;

  v_receita_liq := v_receita - v_deducoes;
  v_custo       := v_custo_aulas + v_custo_ajustes + v_custo_outros;
  v_lucro_bruto := v_receita_liq - v_custo;
  v_despesas    := v_desp_vendedor + v_desp_indicacao + v_desp_ledger;
  v_resultado   := v_lucro_bruto - v_despesas;

  with fixas as (
    select unnest(array[
      jsonb_build_object('code','3.1.01','label','Mensalidades',           'kind','RECEITA','valor',round(v_receita,2),        'fonte','student_payments recebidos',        'sort',110),
      jsonb_build_object('code','5.1.01','label','Repasse a professores',  'kind','CUSTO',  'valor',round(v_custo_aulas,2),    'fonte','v_payable_class_logs (competência)','sort',310),
      jsonb_build_object('code','5.1.02','label','Ajustes de fechamento',  'kind','CUSTO',  'valor',round(v_custo_ajustes,2),  'fonte','closing_adjustments',               'sort',320),
      jsonb_build_object('code','6.1.01','label','Comissões de vendedores','kind','DESPESA','valor',round(v_desp_vendedor,2),  'fonte','vendor_commissions pagas',          'sort',410),
      jsonb_build_object('code','6.1.02','label','Programa de indicações', 'kind','DESPESA','valor',round(v_desp_indicacao,2), 'fonte','referral_rewards pagas',            'sort',420)
    ]) as l
  ), ledger as (
    select e.value as l from jsonb_array_elements(v_linhas_ledger) e
  )
  select coalesce(jsonb_agg((t.l - 'sort') order by (t.l->>'sort')::int), '[]'::jsonb)
    into v_linhas
  from (select l from fixas union all select l from ledger) t;

  if v_desp_ledger = 0 and v_deducoes = 0 and v_custo_outros = 0 then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','critico',
      'texto','Nenhuma despesa operacional lançada no mês (ferramentas, internet, impostos, aluguel). O resultado abaixo está SUPERESTIMADO — ele desconta só o custo com professor.');
  end if;
  if v_barrado > 0 then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','atencao',
      'texto','R$ ' || translate(to_char(v_barrado,'FM999,999,990.00'), ',.', '.,') || ' em saídas do caixa foram lançadas em contas que já vêm por competência (repasse, ajustes, comissões, indicações). O valor foi IGNORADO no resultado para não contar duas vezes — reclassifique a categoria.');
  end if;
  if v_custo_aulas = 0 and v_receita > 0 then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','atencao',
      'texto','Houve receita mas nenhuma aula pagável lançada no mês. Verifique lançamentos pendentes de professor.');
  end if;
  if exists (select 1 from teacher_closings tc
              where tc.tenant_id = v_tenant and tc.month_year = v_month
                and tc.status <> 'PAGO') then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','info',
      'texto','O fechamento deste mês ainda não foi pago. O custo já está reconhecido aqui por competência, mas ainda não saiu do caixa.');
  end if;

  return jsonb_build_object(
    'month', v_month,
    'regime','competencia',
    'receita_bruta',   round(v_receita,2),
    'deducoes',        round(v_deducoes,2),
    'receita_liquida', round(v_receita_liq,2),
    'custo_servicos',  round(v_custo,2),
    'lucro_bruto',     round(v_lucro_bruto,2),
    'margem_bruta_pct', round(100 * v_lucro_bruto / nullif(v_receita_liq,0), 1),
    'despesas_operacionais', round(v_despesas,2),
    'resultado',       round(v_resultado,2),
    'margem_liquida_pct', round(100 * v_resultado / nullif(v_receita_liq,0), 1),
    'indicadores', jsonb_build_object(
      'aulas', v_aulas,
      'alunos_atendidos', v_alunos,
      'receita_por_aluno', round(v_receita / nullif(v_alunos,0), 2),
      'custo_por_aula', round((v_custo_aulas + v_custo_ajustes) / nullif(v_aulas,0), 2)
    ),
    'linhas', v_linhas,
    'alertas', v_alertas
  );
end;
$function$;

comment on function public.dre_gerencial(text, text) is
  'Resultado gerencial mensal por competência. Aceita workers internos sem claims e preserva a fonte única financeira do DRE.';

revoke all on function public.dre_gerencial(text, text) from public;
grant execute on function public.dre_gerencial(text, text) to authenticated, service_role;
