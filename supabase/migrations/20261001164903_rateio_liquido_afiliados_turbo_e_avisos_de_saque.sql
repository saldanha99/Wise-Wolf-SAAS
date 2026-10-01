create or replace function private.affiliate_withdrawal_notice_text(p_name text,p_cents integer,p_count integer,p_date timestamptz)
returns text language sql stable set search_path = '' as $function$
  select format(E'💸 *Solicitação de saque de afiliado*\nAfiliado: *%s*\nValor: *R$ %s* · %s comissão(ões)\nPedido: %s\n\nAcesse Afiliados → ficha → Solicitações de saque. Confira o PIX na plataforma, aprove, faça o repasse e só depois marque pago. Aprovar não transfere dinheiro.',
    regexp_replace(coalesce(p_name,'Afiliado'),'[\n\r*]',' ','g'),
    replace(round(p_cents/100.0,2)::text,'.',','),p_count,
    to_char(p_date at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'));
$function$;
alter function private.affiliate_withdrawal_notice_text(text,integer,integer,timestamptz) owner to postgres;
revoke all on function private.affiliate_withdrawal_notice_text(text,integer,integer,timestamptz) from public,anon,authenticated,service_role;

-- Rateio operacional: comissão da matrícula descontada uma única vez, antes
-- dos percentuais; salário continua pela régua canônica, incluindo Turbo.
-- Não modifica comissões, folha, pagamentos nem avisos já enviados.

create or replace function private.payment_affiliate_cost(p_payment uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  with costs as (
    select c.id, c.amount_brl, v.full_name
      from public.student_payments target
      join public.vendor_commissions c
        on c.student_id=target.student_id and c.tenant_id=target.tenant_id
      join public.profiles v on v.id=c.vendor_id and v.tenant_id=c.tenant_id
      join public.offers o on o.id=c.offer_id and o.tenant_id=c.tenant_id
        and o.processing_by=c.student_id
        and (o.vendor_id=c.vendor_id or (
          o.vendor_id is null
          and o.metadata->>'affiliate_retroactive_vendor_id'=c.vendor_id::text
          and nullif(btrim(o.metadata->>'affiliate_retroactive_authorization'),'') is not null))
      cross join lateral (
        select p.id from public.student_payments p
         where p.student_id=c.student_id and p.tenant_id=c.tenant_id
           and not private.payment_is_enrollment_fee(p.payment_type,p.description)
           and p.status not in ('CANCELLED','DELETED','NAO_RECEITA')
           and (
             (nullif(coalesce(o.metadata->>'affiliate_first_monthly_payment_id',o.metadata->>'subscription_activation_payment_id',
               o.metadata->>'activation_payment_id'),'') is not null
              and p.asaas_payment_id=coalesce(o.metadata->>'affiliate_first_monthly_payment_id',o.metadata->>'subscription_activation_payment_id',
                o.metadata->>'activation_payment_id'))
             or (nullif(coalesce(o.metadata->>'affiliate_first_monthly_payment_id',o.metadata->>'subscription_activation_payment_id',
               o.metadata->>'activation_payment_id'),'') is null
               and p.created_at>=coalesce(o.processing_started_at,c.created_at)-interval '1 day'
               and (nullif(o.metadata->>'subscription_id','') is null or p.authoritative_subscription_id=o.metadata->>'subscription_id'))
           )
         order by p.due_date nulls last,p.created_at,p.id limit 1
      ) first_payment
     where target.id=p_payment and first_payment.id=target.id
       and c.status in ('CONFIRMED','PAID')
       and target.status in ('RECEIVED','RECEIVED_IN_CASH')
  ) select jsonb_build_object('custo_afiliado',round(coalesce(sum(amount_brl),0)/100.0,2),
     'afiliados',coalesce(jsonb_agg(jsonb_build_object('commission_id',id,
       'nome',full_name,'valor',round(amount_brl/100.0,2)) order by id),'[]'::jsonb)) from costs;
$function$;
alter function private.payment_affiliate_cost(uuid) owner to postgres;
revoke all on function private.payment_affiliate_cost(uuid) from public,anon,authenticated,service_role;

create or replace function private.payment_split_with_affiliate(
  p_payment uuid,p_tenant text,p_student uuid,p_valor numeric,p_mes text,p_sem_custo boolean
) returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare v_comm jsonb; v_cost numeric; v_split jsonb; v_result numeric;
begin
  v_comm:=private.payment_affiliate_cost(p_payment);
  v_cost:=coalesce((v_comm->>'custo_afiliado')::numeric,0);
  -- A régua existente aplica os percentuais APÓS salário e comissão.
  v_split:=private.payment_split_rateio(p_tenant,p_student,p_valor-v_cost,p_mes,p_sem_custo);
  v_result:=round(p_valor-v_cost-coalesce((v_split->>'custo_professor')::numeric,0),2);
  return v_split || v_comm || jsonb_build_object('valor',round(p_valor,2),
    'resultado_antes_rateio',v_result,'deficit',greatest(-v_result,0),
    'base_provisoria',true);
end;
$function$;
alter function private.payment_split_with_affiliate(uuid,text,uuid,numeric,text,boolean) owner to postgres;
revoke all on function private.payment_split_with_affiliate(uuid,text,uuid,numeric,text,boolean)
  from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION private.payment_split_rateio(p_tenant text, p_student uuid, p_valor numeric, p_mes text, p_sem_custo boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ini date;
  v_fim date;
  v_dizimo_pct numeric; v_investimento_pct numeric; v_ativo boolean;
  v_prof_dizimo_pct numeric; v_prof_investimento_pct numeric; v_prof_prolabore_pct numeric;
  v_escola_pct numeric;
  v_custo numeric; v_aulas int; v_aulas_pl int; v_liquido numeric;
  v_professores jsonb;
  v_na_base boolean; v_dizimo numeric; v_investimento numeric;
  v_pro_labore numeric; v_sobra numeric; v_share numeric;
  v_base_pl numeric; v_base_prof numeric;
  v_dz_pl numeric; v_inv_pl numeric; v_esc_pl numeric; v_pl_pl numeric;
  v_dz_pr numeric; v_inv_pr numeric; v_pl_pr numeric; v_esc_pr numeric;
  v_sem_custo boolean := coalesce(p_sem_custo, false);
begin
  select s.dizimo_pct, s.investimento_pct, s.escola_pct, s.is_active,
         s.prof_dizimo_pct, s.prof_investimento_pct, s.prof_prolabore_pct
    into v_dizimo_pct, v_investimento_pct, v_escola_pct, v_ativo,
         v_prof_dizimo_pct, v_prof_investimento_pct, v_prof_prolabore_pct
    from public.payment_split_settings as s
   where s.tenant_id = p_tenant;
  if not found then
    v_dizimo_pct := 10.00; v_investimento_pct := 10.00;
    v_escola_pct := 0.00; v_ativo := false;
    v_prof_dizimo_pct := 10.00; v_prof_investimento_pct := 70.00; v_prof_prolabore_pct := 20.00;
  end if;

  v_ini := (p_mes || '-01')::date;
  v_fim := (v_ini + interval '1 month - 1 day')::date;

  -- Agenda de hoje × cada dia do mês da competência × tarifa daquele dia.
  select coalesce(sum(z.n), 0)::int,
         coalesce(sum(z.custo) filter (where not z.pro_labore), 0),
         coalesce(sum(z.n) filter (where z.pro_labore), 0)::int,
         coalesce(jsonb_agg(jsonb_build_object(
           'teacher_id', z.teacher_id,
           'teacher_name', coalesce(pg_catalog.btrim(t.full_name), 'Professor não identificado'),
           'aulas', z.n,
           'custo', case when z.pro_labore then null else round(z.custo, 2) end,
           'descontado', not z.pro_labore,
           'turbo_ativo', coalesce((public.teacher_turbo_status_at(z.teacher_id,v_fim)->>'active')::boolean,false),
           'tarifa_min', z.tarifa_min, 'tarifa_max', z.tarifa_max,
           'acrescimo_sobre_base', case when z.pro_labore then 0 else round(z.acrescimo_sobre_base,2) end) order by z.custo desc), '[]'::jsonb)
    into v_aulas, v_custo, v_aulas_pl, v_professores
    from (
      select b.teacher_id,
             count(*)::int as n,
             sum(public.teacher_student_rate(b.teacher_id, b.student_id, d::date)) as custo,
             min(public.teacher_student_rate(b.teacher_id,b.student_id,d::date)) as tarifa_min,
             max(public.teacher_student_rate(b.teacher_id,b.student_id,d::date)) as tarifa_max,
             sum(greatest(public.teacher_student_rate(b.teacher_id,b.student_id,d::date)-
               coalesce((select tiers.rate from public.teacher_pay_tiers tiers
                 where tiers.tenant_id=p_tenant and tiers.min_students=1),0),0)) as acrescimo_sobre_base,
             exists (
               select 1 from public.payment_split_owner_teachers as o
                where o.tenant_id = p_tenant and o.teacher_id = b.teacher_id
             ) as pro_labore
        from public.bookings as b
        cross join pg_catalog.generate_series(
          v_ini::timestamp, v_fim::timestamp, interval '1 day'
        ) as d
       where b.student_id = p_student
         and b.tenant_id = p_tenant
         and coalesce(b.status, 'SCHEDULED') = 'SCHEDULED'
         and public.dow_name_to_int(b.day_of_week) = extract(dow from d)::int
         and (b.start_date is null or d::date >= b.start_date)
       group by b.teacher_id
    ) as z
    left join public.profiles as t on t.id = z.teacher_id;

  -- Taxa de matrícula: a régua continua a de quem dá aula ao aluno, mas nada
  -- vai para a caixinha — a aula do mês já é paga pela mensalidade.
  if v_sem_custo then
    v_custo := 0;
    v_professores := '[]'::jsonb;
  end if;

  v_liquido := greatest(coalesce(p_valor, 0) - coalesce(v_custo, 0), 0);
  v_na_base := (p_student is not null);
  v_share := case when v_aulas > 0 then v_aulas_pl::numeric / v_aulas else 0 end;

  if not v_na_base then
    v_dizimo := 0; v_investimento := 0; v_pro_labore := 0; v_sobra := round(v_liquido, 2);
  else
    v_base_pl   := round(v_liquido * v_share, 2);
    v_base_prof := round(v_liquido - v_base_pl, 2);

    v_dz_pl  := round(v_base_pl * v_dizimo_pct / 100.0, 2);
    v_inv_pl := round(v_base_pl * v_investimento_pct / 100.0, 2);
    v_esc_pl := round(v_base_pl * coalesce(v_escola_pct, 0) / 100.0, 2);
    v_pl_pl  := greatest(v_base_pl - v_dz_pl - v_inv_pl - v_esc_pl, 0);

    v_dz_pr  := round(v_base_prof * v_prof_dizimo_pct / 100.0, 2);
    v_inv_pr := round(v_base_prof * v_prof_investimento_pct / 100.0, 2);
    v_pl_pr  := round(v_base_prof * v_prof_prolabore_pct / 100.0, 2);
    v_esc_pr := greatest(v_base_prof - v_dz_pr - v_inv_pr - v_pl_pr, 0);

    v_dizimo       := v_dz_pl + v_dz_pr;
    v_investimento := v_inv_pl + v_inv_pr;
    v_pro_labore   := v_pl_pl + v_pl_pr;
    v_sobra := round(v_liquido - v_dizimo - v_investimento - v_pro_labore, 2);

    -- O centavo que estoura sai do pró-labore, nunca da escola.
    if v_sobra < 0 then
      v_pro_labore := round(v_pro_labore + v_sobra, 2);
      v_sobra := 0;
    end if;
  end if;

  return jsonb_build_object(
    'is_active',        coalesce(v_ativo, false),
    'month',            p_mes,
    'sem_agenda',       (v_aulas = 0 and not v_sem_custo),
    'na_base',          v_na_base,
    'valor',            round(coalesce(p_valor, 0), 2),
    'aulas_previstas',  case when v_sem_custo then 0 else v_aulas end,
    'aulas_pro_labore', case when v_sem_custo then 0 else v_aulas_pl end,
    'custo_professor',  round(coalesce(v_custo, 0), 2),
    'pro_labore',       round(coalesce(v_pro_labore, 0), 2),
    'professores',      v_professores,
    'liquido',          round(v_liquido, 2),
    'dizimo_pct',       case when v_liquido > 0 then round(v_dizimo * 100.0 / v_liquido, 2) else v_dizimo_pct end,
    'investimento_pct', case when v_liquido > 0 then round(v_investimento * 100.0 / v_liquido, 2) else v_investimento_pct end,
    'escola_pct',       v_escola_pct,
    'regra',            case when v_share >= 1 then 'direcao'
                             when v_share <= 0 then 'professor'
                             else 'misto' end,
    'dizimo',           v_dizimo,
    'investimento',     v_investimento,
    'sobra',            v_sobra
  );
end;
$function$
;
alter function private.payment_split_rateio(text,uuid,numeric,text,boolean) owner to postgres;
CREATE OR REPLACE FUNCTION private.payment_split_breakdown_unchecked(p_payment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_pay record;
  v_tenant text;
  v_aluno text;
  v_comp date;
  v_eh_matricula boolean;
  v_recebido_em date;
  v_mes text;
  v_valor numeric;
  v_total numeric;
  -- primeira parcela ativa do pagamento (se houver pagamento completo)
  v_alloc_id uuid;
  v_alloc_comp date;
  v_alloc_seq int;
  v_alloc_meses int;
  v_alloc_valor numeric;
  v_alloc_modo text;
  v_alloc_registration uuid;
  v_inicio date;
  v_fim date;
begin
  select sp.id, sp.student_id, sp.value, sp.tenant_id, sp.description, sp.payment_type,
         sp.due_date, sp.paid_at, sp.payment_date,
         coalesce(sp.paid_at, sp.payment_date, sp.due_date) as quando,
         sp.created_at
    into v_pay
    from public.student_payments as sp
   where sp.id = p_payment_id;
  if not found then
    return jsonb_build_object('error', 'pagamento_nao_encontrado');
  end if;

  v_tenant := coalesce(
    v_pay.tenant_id,
    (select p.tenant_id from public.profiles as p where p.id = v_pay.student_id)
  );
  if v_tenant is null then
    return jsonb_build_object('error', 'escola_nao_identificada');
  end if;

  select pg_catalog.btrim(p.full_name) into v_aluno
    from public.profiles as p where p.id = v_pay.student_id;

  v_comp := coalesce(
    private.payment_competencia_of(v_pay.due_date, v_pay.paid_at, v_pay.payment_date, v_pay.created_at),
    pg_catalog.date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date
  );
  v_eh_matricula := private.payment_is_enrollment_fee(v_pay.payment_type, v_pay.description);
  v_recebido_em := coalesce(
    (v_pay.paid_at at time zone 'America/Sao_Paulo')::date,
    v_pay.payment_date,
    v_pay.due_date
  );
  v_total := round(coalesce(v_pay.value, 0), 2);

  if exists (select 1 from public.student_payment_allocations a
    where a.payment_id = v_pay.id and (a.status = 'REVIEW'
      or (a.status = 'ACTIVE' and not private.prepayment_allocation_is_valid(a.id)))) then
    return jsonb_build_object('error','pagamento_completo_em_revisao','payment_id',v_pay.id,
      'tenant_id',v_tenant,'recebido_total',v_total,'review_required',true);
  end if;

  select a.id, a.competencia, a.sequencia, a.meses, a.valor, a.modo,a.registration_id
    into v_alloc_id, v_alloc_comp, v_alloc_seq, v_alloc_meses, v_alloc_valor, v_alloc_modo,v_alloc_registration
    from public.student_payment_allocations as a
   where a.payment_id = v_pay.id
     and a.status = 'ACTIVE'
     and private.prepayment_allocation_is_valid(a.id)
   order by a.sequencia
   limit 1;

  if v_alloc_id is null and exists (select 1 from public.student_payment_allocations a
      where a.payment_id = v_pay.id and a.modo = 'MENSAL') then
    return jsonb_build_object('error','pagamento_completo_cancelado','payment_id',v_pay.id,
      'tenant_id',v_tenant,'recebido_total',v_total,'review_required',true);
  end if;

  if v_alloc_id is not null then
    select min(g.competencia), max(g.competencia)
      into v_inicio, v_fim
      from public.student_payment_allocations as g
     where g.payment_id = v_pay.id
       and g.status = 'ACTIVE';
  end if;

  if v_alloc_modo = 'MENSAL' then
    -- D1: o aviso do recebimento rateia a 1ª parcela, com a agenda do mês dela.
    -- O resto fica reservado e sai mês a mês (payment_split_installment).
    v_mes := pg_catalog.to_char(v_alloc_comp, 'YYYY-MM');
    v_valor := v_alloc_valor;
  else
    -- Pagamento comum ou LEGADO: rateio do valor cheio no recebimento, com a
    -- agenda do mês da COMPETÊNCIA (não do caixa).
    v_mes := pg_catalog.to_char(v_comp, 'YYYY-MM');
    v_valor := v_total;
  end if;

  return private.payment_split_with_affiliate(
           v_pay.id, v_tenant, v_pay.student_id, v_valor, v_mes, v_eh_matricula
         )
      || jsonb_build_object(
           'payment_id',       v_pay.id,
           'tenant_id',        v_tenant,
           'paid_at',          v_pay.quando,
           'ref_date',         coalesce(v_pay.created_at, now())::date,
           'student_id',       v_pay.student_id,
           'student_name',     coalesce(v_aluno, 'sem aluno vinculado'),
           'sem_aluno',        (v_pay.student_id is null),
           'description',      v_pay.description,
           'competencia',      v_mes,
           'vencimento',       v_pay.due_date,
           'eh_matricula',     v_eh_matricula,
           'meses',            coalesce(v_alloc_meses, 1),
           'modo',             v_alloc_modo,
           'sequencia',        case when v_alloc_modo = 'MENSAL' then v_alloc_seq end,
           'allocation_id',    case when v_alloc_modo = 'MENSAL' then v_alloc_id end,
           'registration_id',  v_alloc_registration,
           'origem',           case when v_alloc_id is not null then 'ASAAS' end,
           'recebido_total',   v_total,
           'recebido_em',      v_recebido_em,
           'parcela',          round(v_valor, 2),
           'reservado',        greatest(round(v_total - v_valor, 2), 0),
           'cobertura_inicio', pg_catalog.to_char(v_inicio, 'YYYY-MM'),
           'cobertura_fim',    pg_catalog.to_char(v_fim, 'YYYY-MM')
         );
end;
$function$
;
CREATE OR REPLACE FUNCTION private.payment_split_installment_unchecked(p_allocation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_alloc public.student_payment_allocations%rowtype;
  v_pay_value numeric;
  v_description text;
  v_due date;
  v_pay_recebido date;
  v_soma numeric;
  v_acumulado numeric;
  v_inicio date;
  v_fim date;
  v_total numeric;
  v_recebido date;
  v_aluno text;
begin
  select a.* into v_alloc
    from public.student_payment_allocations as a
   where a.id = p_allocation_id;
  if not found then
    return jsonb_build_object('error', 'parcela_nao_encontrada');
  end if;
  if v_alloc.status = 'CANCELLED' then
    return jsonb_build_object('error', 'parcela_cancelada', 'allocation_id', v_alloc.id);
  end if;
  if not private.prepayment_allocation_is_valid(v_alloc.id) then
    return jsonb_build_object('error','parcela_em_revisao','allocation_id',v_alloc.id,'review_required',true);
  end if;
  -- LEGADO já foi rateado no recebimento: repetir aqui dobraria o dízimo.
  if v_alloc.modo <> 'MENSAL' then
    return jsonb_build_object('error', 'parcela_legado_sem_rateio', 'allocation_id', v_alloc.id);
  end if;

  select sp.value, sp.description, sp.due_date,
         coalesce((sp.paid_at at time zone 'America/Sao_Paulo')::date, sp.payment_date, sp.due_date)
    into v_pay_value, v_description, v_due, v_pay_recebido
    from public.student_payments as sp
   where sp.id = v_alloc.payment_id;

  select round(sum(g.valor), 2),
         round(coalesce(sum(g.valor) filter (where g.sequencia <= v_alloc.sequencia), 0), 2),
         min(g.competencia),
         max(g.competencia)
    into v_soma, v_acumulado, v_inicio, v_fim
    from public.student_payment_allocations as g
   where g.registration_id = v_alloc.registration_id
     and g.status = 'ACTIVE';

  v_total := round(coalesce(v_pay_value, v_soma, 0), 2);
  v_recebido := coalesce(v_alloc.recebido_em, v_pay_recebido);

  select pg_catalog.btrim(p.full_name) into v_aluno
    from public.profiles as p where p.id = v_alloc.student_id;

  return private.payment_split_with_affiliate(
           case when v_alloc.sequencia=1 then v_alloc.payment_id else null end,
           v_alloc.tenant_id,
           v_alloc.student_id,
           v_alloc.valor,
           pg_catalog.to_char(v_alloc.competencia, 'YYYY-MM'),
           false
         )
      || jsonb_build_object(
           'payment_id',       v_alloc.payment_id,
           'allocation_id',    v_alloc.id,
           'registration_id',  v_alloc.registration_id,
           'tenant_id',        v_alloc.tenant_id,
           'paid_at',          v_recebido,
           'ref_date',         v_alloc.competencia,
           'student_id',       v_alloc.student_id,
           'student_name',     coalesce(v_aluno, 'sem aluno vinculado'),
           'sem_aluno',        false,
           'description',      v_description,
           'competencia',      pg_catalog.to_char(v_alloc.competencia, 'YYYY-MM'),
           'vencimento',       v_due,
           'eh_matricula',     false,
           'meses',            v_alloc.meses,
           'sequencia',        v_alloc.sequencia,
           'modo',             v_alloc.modo,
           'origem',           v_alloc.origem,
           'recebido_total',   v_total,
           'recebido_em',      v_recebido,
           'parcela',          v_alloc.valor,
           'reservado',        greatest(round(v_total - v_acumulado, 2), 0),
           'cobertura_inicio', pg_catalog.to_char(v_inicio, 'YYYY-MM'),
           'cobertura_fim',    pg_catalog.to_char(v_fim, 'YYYY-MM')
         );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.payment_split_report(p_month text DEFAULT NULL::text, p_tenant text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant text; v_month text; v_ini date;
begin
  v_tenant := coalesce(nullif(btrim(p_tenant),''),private.active_tenant_id(auth.uid()));
  if not private.prepayment_caller_can_read(v_tenant) then
    return jsonb_build_object('error','sem_permissao');
  end if;
  if v_tenant is null then return jsonb_build_object('error','escola_nao_identificada'); end if;

  v_month := coalesce(p_month, to_char(current_date,'YYYY-MM'));
  if v_month !~ '^\d{4}-\d{2}$' then return jsonb_build_object('error','mes_invalido'); end if;
  v_ini := (v_month || '-01')::date;

  return (
  with pagos as (
    -- O dinheiro que ENTROU no mês (regime de caixa).
    select sp.id, coalesce(sp.paid_at, sp.payment_date, sp.due_date) as quando
      from student_payments sp
     where sp.tenant_id = v_tenant
       and sp.status in ('RECEIVED','RECEIVED_IN_CASH')
       and coalesce(sp.value,0) > 0
       and to_char(coalesce(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
  ), parcelas as (
    -- Parcela de pagamento completo MENSAL cujo rateio cai neste mês e cujo
    -- dinheiro entrou antes. A 1ª parcela de um pagamento Asaas já sai no
    -- próprio pagamento; recebido por fora não tem pagamento, entra toda aqui.
    select a.id, a.competencia::timestamptz as quando
      from student_payment_allocations a
     where a.tenant_id = v_tenant
       and a.status = 'ACTIVE'
       and private.prepayment_allocation_is_valid(a.id)
       and a.modo = 'MENSAL'
       and a.competencia = v_ini
       and (a.payment_id is null or a.sequencia > 1)
  ), rateado as (
    select 'PAGAMENTO'::text as tipo, p.quando,
           private.payment_split_breakdown_unchecked(p.id) as b
      from pagos p
    union all
    select 'PARCELA'::text, pa.quando,
           private.payment_split_installment_unchecked(pa.id)
      from parcelas pa
  )
  select jsonb_build_object(
    'month', v_month,
    'pagamentos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tipo',            r.tipo,
               'payment_id',      r.b->>'payment_id',
               'allocation_id',   r.b->>'allocation_id',
               'aluno',           r.b->>'student_name',
               'quando',          r.quando,
               'competencia',     r.b->>'competencia',
               'valor',           (r.b->>'valor')::numeric,
               'recebido_total',  (r.b->>'recebido_total')::numeric,
               'recebido_no_mes', case when r.tipo = 'PAGAMENTO'
                                       then (r.b->>'recebido_total')::numeric else 0 end,
               'parcela',         (r.b->>'parcela')::numeric,
               'reservado',       (r.b->>'reservado')::numeric,
               'meses',           (r.b->>'meses')::int,
               'sequencia',       (r.b->>'sequencia')::int,
               'modo',            r.b->>'modo',
               'eh_matricula',    coalesce((r.b->>'eh_matricula')::boolean, false),
               'custo_professor', (r.b->>'custo_professor')::numeric,
               'custo_afiliado', (r.b->>'custo_afiliado')::numeric,
               'resultado_antes_rateio', (r.b->>'resultado_antes_rateio')::numeric,
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
        'pagamentos',      count(*) filter (where r.tipo = 'PAGAMENTO')::int,
        'parcelas',        count(*) filter (where r.tipo = 'PARCELA')::int,
        -- Caixa: o valor CHEIO que entrou, inclusive de pagamento completo.
        'recebido',        round(coalesce(sum((r.b->>'recebido_total')::numeric)
                                   filter (where r.tipo = 'PAGAMENTO'),0),2),
        -- Do que entrou no mês, quanto fica guardado para os meses seguintes.
        'reservado',       round(coalesce(sum((r.b->>'reservado')::numeric)
                                   filter (where r.tipo = 'PAGAMENTO'),0),2),
        -- Parcelas de pagamentos anteriores rateadas neste mês.
        'liberado_de_reserva', round(coalesce(sum((r.b->>'valor')::numeric)
                                   filter (where r.tipo = 'PARCELA'),0),2),
        'custo_professor', round(coalesce(sum((r.b->>'custo_professor')::numeric),0),2),
        'custo_afiliado', round(coalesce(sum((r.b->>'custo_afiliado')::numeric),0),2),
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
$function$
;
-- Pedido de saque passa pela fila oficial; não envia PIX nem altera aprovação.
create or replace function public.get_affiliate_withdrawal_notice_snapshot(p_notification_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare q public.notification_queue%rowtype; r public.vendor_withdrawal_requests%rowtype;
  v public.profiles%rowtype; destination text; message text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    return jsonb_build_object('ok',false,'reason','forbidden');
  end if;
  select * into q from public.notification_queue where id=p_notification_id;
  if q.notification_kind is distinct from 'AFFILIATE_WITHDRAWAL_REQUESTED'
     or q.source_type is distinct from 'AFFILIATE_WITHDRAWAL' then
    return jsonb_build_object('ok',false,'reason','withdrawal_notice_invalid');
  end if;
  select * into r from public.vendor_withdrawal_requests
    where id=q.source_id and tenant_id=q.tenant_id and status in ('PENDING','APPROVED');
  if not found then return jsonb_build_object('ok',false,'reason','withdrawal_no_longer_pending'); end if;
  select * into v from public.profiles where id=r.vendor_id and tenant_id=r.tenant_id and role='SALESPERSON';
  if not found or coalesce(v.is_test_account,false)
     or exists(select 1 from auth.users u where u.id=v.id
       and (u.raw_user_meta_data @> '{"test_fixture":true}' or u.raw_user_meta_data @> '{"testMode":true}')) then
    return jsonb_build_object('ok',false,'reason','withdrawal_fixture_or_identity_invalid');
  end if;
  destination:=private.tenant_notice_destination(r.tenant_id,'financeiro');
  if destination is null or destination is distinct from q.student_phone then
    return jsonb_build_object('ok',false,'reason','withdrawal_destination_changed');
  end if;
  message:=private.affiliate_withdrawal_notice_text(v.full_name,r.amount_brl,r.commission_count,r.requested_at);
  return jsonb_build_object('ok',true,'destination',destination,'message',message);
end;
$function$;
alter function public.get_affiliate_withdrawal_notice_snapshot(uuid) owner to postgres;
revoke all on function public.get_affiliate_withdrawal_notice_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.get_affiliate_withdrawal_notice_snapshot(uuid) to service_role;

create or replace function private.queue_affiliate_withdrawal_notice()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare destination text; notification uuid;
begin
  if exists(select 1 from public.profiles p join auth.users u on u.id=p.id
    where p.id=new.vendor_id and (coalesce(p.is_test_account,false)
      or u.raw_user_meta_data @> '{"test_fixture":true}' or u.raw_user_meta_data @> '{"testMode":true}')) then
    return new;
  end if;
  destination:=private.tenant_notice_destination(new.tenant_id,'financeiro');
  if destination is null then return new; end if;
  insert into public.notification_queue(tenant_id,student_name,student_phone,message_body,
    scheduled_for,status,source_type,source_id,notification_kind,idempotency_key)
  values(new.tenant_id,'Financeiro',destination,'Solicitação de saque',now(),'pending',
    'AFFILIATE_WITHDRAWAL',new.id,'AFFILIATE_WITHDRAWAL_REQUESTED','affiliate-withdrawal:'||new.id)
  on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing
  returning id into notification;
  if notification is not null then
    -- O trigger é chamado pela sessão autenticada do afiliado. A montagem
    -- usa os mesmos campos do snapshot, sem impersonar service_role.
    update public.notification_queue set message_body=private.affiliate_withdrawal_notice_text(
      (select full_name from public.profiles where id=new.vendor_id),
      new.amount_brl,new.commission_count,new.requested_at) where id=notification;
  end if;
  return new;
end;
$function$;
alter function private.queue_affiliate_withdrawal_notice() owner to postgres;
revoke all on function private.queue_affiliate_withdrawal_notice() from public,anon,authenticated,service_role;
drop trigger if exists queue_affiliate_withdrawal_notice on public.vendor_withdrawal_requests;
create trigger queue_affiliate_withdrawal_notice after insert on public.vendor_withdrawal_requests
  for each row execute function private.queue_affiliate_withdrawal_notice();

CREATE OR REPLACE FUNCTION public.begin_notification_delivery_submission(p_notification_id uuid, p_claim_token uuid, p_provider_instance_name text, p_expected_destination text, p_provider_destination text, p_expected_message_body text, p_integration_id uuid, p_integration_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_runtime_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_notification public.notification_queue%rowtype;
  v_kind text;
  v_snapshot jsonb;
  v_current_destination text;
  v_current_teacher_id uuid;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'forbidden'
    );
  end if;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id;
  v_kind := pg_catalog.upper(pg_catalog.btrim(coalesce(
    v_notification.notification_kind,
    ''
  )));

  if v_kind = 'AFFILIATE_WITHDRAWAL_REQUESTED' then
    begin
      perform id from public.vendor_withdrawal_requests
        where id=v_notification.source_id and tenant_id=v_notification.tenant_id for share nowait;
    exception when lock_not_available then
      return jsonb_build_object('ok',false,'action','RETRY','reason','withdrawal_source_busy');
    end;
    v_snapshot:=public.get_affiliate_withdrawal_notice_snapshot(p_notification_id);
    if coalesce((v_snapshot->>'ok')::boolean,false) is false
       or v_snapshot->>'destination' is distinct from p_expected_destination
       or v_snapshot->>'message' is distinct from p_expected_message_body then
      return jsonb_build_object('ok',false,'action','REVIEW_REQUIRED',
        'reason',coalesce(v_snapshot->>'reason','withdrawal_snapshot_changed'));
    end if;
  end if;

  if v_kind not in (
    'TRIAL_TEACHER_REQUESTED',
    'TRIAL_MANAGEMENT_ACCEPTED'
  ) then
    return public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(
      p_notification_id,
      p_claim_token,
      p_provider_instance_name,
      p_expected_destination,
      p_provider_destination,
      p_expected_message_body,
      p_integration_id,
      p_integration_version
    );
  end if;

  if v_notification.id is null
     or v_notification.source_id is null
     or pg_catalog.upper(pg_catalog.btrim(coalesce(
       v_notification.source_type,
       ''
     ))) <> 'TRIAL_OPPORTUNITY'
     or v_notification.tenant_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'invalid_trial_notification_identity'
    );
  end if;

  begin
    perform opportunity.id
    from public.opportunities as opportunity
    where opportunity.id = v_notification.source_id
      and opportunity.tenant_id = v_notification.tenant_id
    for share nowait;
    if not found then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'trial_notification_source_unavailable'
      );
    end if;

    perform link.id
    from public.enrollment_links as link
    where link.opportunity_id = v_notification.source_id
    order by link.id
    for share nowait;

    perform request.id
    from private.vendor_trial_teacher_requests as request
    where request.opportunity_id = v_notification.source_id
    order by request.id
    for share nowait;
  exception when lock_not_available then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'trial_notification_revalidation_busy'
    );
  end;

  v_snapshot := public.get_trial_notification_delivery_snapshot(
    v_notification.tenant_id,
    v_notification.source_id,
    v_kind
  );
  if coalesce((v_snapshot ->> 'ok')::boolean, false) is not true then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', case
        when coalesce((v_snapshot ->> 'retryable')::boolean, false)
          then 'RETRY'
        else 'REVIEW_REQUIRED'
      end,
      'reason', coalesce(
        v_snapshot ->> 'reason',
        'trial_notification_revalidation_failed'
      )
    );
  end if;

  v_current_destination := private.normalize_notification_destination(
    v_snapshot ->> 'destination'
  );
  begin
    v_current_teacher_id := nullif(v_snapshot ->> 'teacherId', '')::uuid;
  exception when invalid_text_representation then
    v_current_teacher_id := null;
  end;
  if v_current_destination is null
     or v_current_destination is distinct from
       private.normalize_notification_destination(p_expected_destination)
     or (
       v_current_destination like '%@g.us'
       and private.normalize_notification_destination(p_provider_destination)
         is distinct from v_current_destination
     )
     or (
       v_current_destination not like '%@g.us'
       and not private.notification_phones_same_recipient(
         v_current_destination,
         private.normalize_notification_destination(p_provider_destination)
       )
     )
     or (
       v_kind = 'TRIAL_TEACHER_REQUESTED'
       and v_notification.teacher_id is distinct from v_current_teacher_id
     )
     or (
       v_kind = 'TRIAL_MANAGEMENT_ACCEPTED'
       and v_notification.teacher_id is not null
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'trial_notification_authorized_snapshot_changed'
    );
  end if;

  return public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(
    p_notification_id,
    p_claim_token,
    p_provider_instance_name,
    p_expected_destination,
    p_provider_destination,
    p_expected_message_body,
    p_integration_id,
    p_integration_version
  );
end;
$function$

;
create or replace function public.gestao_affiliate_turbo_context(p_tenant text)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    return jsonb_build_object('error','sem_permissao');
  end if;
  return jsonb_build_object(
    'data',today,
    'regra_base','Pagamento menos custo previsto do professor (incluindo tarifa Turbo) e comissão da matrícula. Só sobra positiva recebe os percentuais. É prévia operacional, não lucro final do DRE.',
    'rateio_mes_corrente',(public.payment_split_report(to_char(today,'YYYY-MM'),p_tenant)->'totais') || jsonb_build_object('mes',to_char(today,'YYYY-MM')),
    'rateio_mes_anterior',(public.payment_split_report(to_char(today-interval '1 month','YYYY-MM'),p_tenant)->'totais') || jsonb_build_object('mes',to_char(today-interval '1 month','YYYY-MM')),
    'saques', (select jsonb_build_object(
      'pendentes',count(*) filter(where r.status='PENDING'),
      'valor_pendente',round(coalesce(sum(r.amount_brl) filter(where r.status='PENDING'),0)/100.0,2),
      'aprovados',count(*) filter(where r.status='APPROVED'),
      'valor_aprovado',round(coalesce(sum(r.amount_brl) filter(where r.status='APPROVED'),0)/100.0,2),
      'como_pagar','Afiliados → ficha → Solicitações de saque. Aprovar não transfere dinheiro: conferir PIX, efetuar repasse e depois marcar pago.',
      'avisos','Novo pedido vai ao canal Financeiro; sem ele, Direção/Gestão. A fila revalida o pedido antes de enviar.')
      from public.vendor_withdrawal_requests r where r.tenant_id=p_tenant),
    'turbo_professores',coalesce((select jsonb_agg(jsonb_build_object(
      'nome',p.full_name,'situacao',public.teacher_turbo_status_at(p.id,today),
      'faixas',(select jsonb_agg(jsonb_build_object('posicao_inicial',t.min_students,'tarifa',t.rate)
        order by t.min_students) from public.teacher_pay_tiers t where t.tenant_id=p_tenant)) order by p.full_name)
      from public.profiles p where p.tenant_id=p_tenant and p.role='TEACHER'
        and lower(coalesce(p.lifecycle_status,'active'))='active'),'[]'::jsonb),
    'regra_turbo','A tarifa é por aluno e data da aula. Turbo ativo não muda toda a carteira para a faixa superior. Na ofensiva rolling_30_days são 30 dias sem falta confirmada do professor, carteira mínima e sem contestação aberta; falta do aluno não reinicia a ofensiva. Tarifas e requisitos vêm dos dados, não são percentuais fixos.');
end;
$function$;
alter function public.gestao_affiliate_turbo_context(text) owner to postgres;
revoke all on function public.gestao_affiliate_turbo_context(text) from public,anon,authenticated;
grant execute on function public.gestao_affiliate_turbo_context(text) to service_role;
