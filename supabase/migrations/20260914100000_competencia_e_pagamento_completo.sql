-- Financeiro por COMPETÊNCIA e pagamento completo (vários meses de uma vez).
--
-- O que estava errado (medido em 14/09/2026):
--   * A caixinha do professor (professores[].custo de payment_split_breakdown)
--     usava o calendário do mês do CAIXA — coalesce(paid_at, payment_date,
--     due_date). Cartão credita ~30 dias depois, e pagamento atrasado ou
--     antecipado caía no calendário do mês errado. Regressão real: fatura de
--     vencimento 05/08 paga no cartão e creditada em 08/09 saiu no aviso com a
--     agenda de SETEMBRO (18 aulas, R$ 144) quando a folha de agosto daquele
--     aluno foi 17 aulas, R$ 136.
--   * Taxa de matrícula e mensalidade no mesmo mês descontavam o mês inteiro
--     de custo DUAS vezes.
--   * Pagamento de vários meses descontava um mês só de custo e rateava o resto
--     na hora; os meses seguintes ficavam sem caixinha e a cobrança/fechamento
--     os tratava como pendentes.
--   * O painel Caixinha × Folha RECALCULAVA a caixinha com a agenda de hoje em
--     vez de ler o que foi avisado no grupo. Agosto/2026: folha R$ 2.732 ×
--     caixinha R$ 1.760.
--
-- Decisões da direção que esta migration implementa:
--   D1. Pagamento completo: o rateio (dízimo, investimento, pró-labore) sai MÊS A
--       MÊS, cada mês com 1/N do valor e com a caixinha pela agenda daquele mês
--       (modo MENSAL). O aviso continua deixando claro que o valor JÁ FOI
--       RECEBIDO por completo: recebido_total, parcela, reservado.
--       Pagamento completo antigo, já rateado no recebimento, ou recebido por
--       fora do Asaas entra como LEGADO: só cobre os meses, sem novo rateio.
--   D2. Fechamento da caixinha por professor: caixinha AVISADA × folha real,
--       quanto completar ou devolver e o motivo (caixinha_fechamento).
--   D3. Mês coberto por pagamento completo não é pendência: nem no fechamento
--       mensal, nem na cobrança, nem nos alertas de inadimplência.
--
-- ⚠️ Não mexe na régua de duas faixas (direção / professor contratado) nem no
-- centavo negativo que sai do pró-labore: o miolo do rateio foi movido para
-- private.payment_split_rateio SEM mudar a conta.
--
-- Re-executável: o release.sh aplica duas vezes numa transação antes de gravar.
-- Nada de begin/commit aqui.

-------------------------------------------------------------------------------
-- 1. Parcelas de pagamento completo
-------------------------------------------------------------------------------
create table if not exists public.student_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  -- Agrupa as N parcelas de UM pagamento completo. Pagamento Asaas: é o próprio
  -- payment_id. Recebido por fora: um uuid novo, devolvido pela RPC.
  grupo_id uuid not null,
  payment_id uuid references public.student_payments(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  competencia date not null,
  sequencia integer not null,
  meses integer not null,
  valor numeric(12, 2) not null,
  modo text not null,
  origem text not null,
  recebido_em date,
  observacao text,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  created_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  constraint student_payment_allocations_competencia_check
    check (extract(day from competencia) = 1),
  constraint student_payment_allocations_meses_check
    check (meses between 2 and 24),
  constraint student_payment_allocations_sequencia_check
    check (sequencia between 1 and meses),
  constraint student_payment_allocations_valor_check
    check (valor > 0),
  constraint student_payment_allocations_modo_check
    check (modo in ('MENSAL', 'LEGADO')),
  constraint student_payment_allocations_origem_check
    check (origem in ('ASAAS', 'EXTERNO')),
  constraint student_payment_allocations_origem_payment_check
    check ((origem = 'ASAAS') = (payment_id is not null)),
  constraint student_payment_allocations_status_check
    check (status in ('ACTIVE', 'CANCELLED')),
  constraint student_payment_allocations_payment_competencia_key
    unique (payment_id, competencia)
);

-- Um mês não pode ser coberto duas vezes (dois pagamentos completos, ou um
-- completo e um recebido por fora, sobre o mesmo mês).
create unique index if not exists uq_student_payment_allocations_student_month_active
  on public.student_payment_allocations (student_id, competencia)
  where status = 'ACTIVE';
create unique index if not exists uq_student_payment_allocations_group_sequence_active
  on public.student_payment_allocations (grupo_id, sequencia)
  where status = 'ACTIVE';
create index if not exists idx_student_payment_allocations_tenant_month_active
  on public.student_payment_allocations (tenant_id, competencia)
  where status = 'ACTIVE';

alter table public.student_payment_allocations owner to postgres;
alter table public.student_payment_allocations enable row level security;
alter table public.student_payment_allocations force row level security;
revoke all on table public.student_payment_allocations
  from public, anon, authenticated, service_role;
-- Escrita só pelas RPCs abaixo. Leitura: direção e coordenação da escola.
grant select on table public.student_payment_allocations to authenticated, service_role;

drop policy if exists student_payment_allocations_admin_read
  on public.student_payment_allocations;
create policy student_payment_allocations_admin_read
  on public.student_payment_allocations
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.profiles as actor
       where actor.id = (select auth.uid())
         and actor.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR')
         and lower(btrim(coalesce(actor.lifecycle_status, ''))) = 'active'
         and (actor.role = 'SUPER_ADMIN'
              or actor.tenant_id = student_payment_allocations.tenant_id)
    )
  );

comment on table public.student_payment_allocations is
  'Parcelas de pagamento completo (vários meses de uma vez). MENSAL: o rateio '
  'sai mês a mês, 1/N do valor com a caixinha pela agenda do mês da parcela. '
  'LEGADO: pagamento já rateado no recebimento ou recebido fora do Asaas; só '
  'cobre o mês. Escrita apenas por register_prepayment, '
  'register_external_prepayment e cancel_prepayment.';

-------------------------------------------------------------------------------
-- 2. Regras de apoio
-------------------------------------------------------------------------------

-- A competência de um pagamento é o mês do VENCIMENTO. Sem vencimento, cai para
-- o crédito (paid_at no fuso da escola), a data de pagamento e, por último, a
-- criação. O mês do CAIXA continua valendo para o caixa (get_cashflow, DRE e o
-- "recebido" do relatório); a competência vale para a agenda da caixinha e
-- para a cobertura do mês.
create or replace function private.payment_competencia_of(
  p_due_date date,
  p_paid_at timestamptz,
  p_payment_date date,
  p_created_at timestamptz
)
returns date
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.date_trunc(
           'month',
           coalesce(
             p_due_date,
             (p_paid_at at time zone 'America/Sao_Paulo')::date,
             p_payment_date,
             (p_created_at at time zone 'America/Sao_Paulo')::date
           )::timestamp
         )::date
$function$;

alter function private.payment_competencia_of(date, timestamptz, date, timestamptz)
  owner to postgres;
revoke all on function private.payment_competencia_of(date, timestamptz, date, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function private.payment_competencia(p_payment_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $function$
  select private.payment_competencia_of(
           payment.due_date,
           payment.paid_at,
           payment.payment_date,
           payment.created_at
         )
    from public.student_payments as payment
   where payment.id = p_payment_id
$function$;

alter function private.payment_competencia(uuid) owner to postgres;
revoke all on function private.payment_competencia(uuid)
  from public, anon, authenticated, service_role;
comment on function private.payment_competencia(uuid) is
  'Mês de competência do pagamento: 1º dia do mês do due_date; sem vencimento, '
  'paid_at (fuso America/Sao_Paulo), payment_date e created_at, nessa ordem. '
  'Cartão creditado no mês seguinte e pagamento atrasado ou antecipado ficam '
  'na competência da fatura, não no mês em que o dinheiro caiu.';

-- Taxa de matrícula não é mensalidade: não paga aula e não gera caixinha.
-- ⚠️ Só "Taxa de matrícula"/"Matrícula" (sem sensibilidade a acento). "Taxa de
-- cancelamento" existe na base e NÃO é matrícula.
create or replace function private.payment_is_enrollment_fee(
  p_payment_type text,
  p_description text
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.upper(pg_catalog.btrim(coalesce(p_payment_type, ''))) = 'ENROLLMENT'
      or pg_catalog.lower(pg_catalog.translate(
           pg_catalog.btrim(coalesce(p_description, '')),
           'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇç',
           'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc'
         )) ~ '^(taxa[[:space:]]+(de[[:space:]]+)?)?matricula'
$function$;

alter function private.payment_is_enrollment_fee(text, text) owner to postgres;
revoke all on function private.payment_is_enrollment_fee(text, text)
  from public, anon, authenticated, service_role;

create or replace function private.student_month_covered(
  p_student uuid,
  p_month date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_student is not null
     and p_month is not null
     and exists (
       select 1
         from public.student_payment_allocations as allocation
        where allocation.student_id = p_student
          and allocation.competencia =
              pg_catalog.date_trunc('month', p_month::timestamp)::date
          and allocation.status = 'ACTIVE'
     )
$function$;

alter function private.student_month_covered(uuid, date) owner to postgres;
revoke all on function private.student_month_covered(uuid, date)
  from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 3. Miolo do rateio (sem autorização). Mesma conta de antes, parametrizada
--    pelo valor rateado e pelo mês da agenda.
-------------------------------------------------------------------------------
create or replace function private.payment_split_rateio(
  p_tenant text,
  p_student uuid,
  p_valor numeric,
  p_mes text,
  p_sem_custo boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
           'descontado', not z.pro_labore) order by z.custo desc), '[]'::jsonb)
    into v_aulas, v_custo, v_aulas_pl, v_professores
    from (
      select b.teacher_id,
             count(*)::int as n,
             sum(public.teacher_student_rate(b.teacher_id, b.student_id, d::date)) as custo,
             exists (
               select 1 from public.payment_split_owner_teachers as o
                where o.tenant_id = p_tenant and o.teacher_id = b.teacher_id
             ) as pro_labore
        from public.bookings as b
        cross join pg_catalog.generate_series(
          v_ini::timestamp, v_fim::timestamp, interval '1 day'
        ) as d
       where b.student_id = p_student
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
$function$;

alter function private.payment_split_rateio(text, uuid, numeric, text, boolean)
  owner to postgres;
revoke all on function private.payment_split_rateio(text, uuid, numeric, text, boolean)
  from public, anon, authenticated, service_role;

-------------------------------------------------------------------------------
-- 4. Rateio de um pagamento (v2)
-------------------------------------------------------------------------------
create or replace function private.payment_split_breakdown_unchecked(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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

  select a.id, a.competencia, a.sequencia, a.meses, a.valor, a.modo
    into v_alloc_id, v_alloc_comp, v_alloc_seq, v_alloc_meses, v_alloc_valor, v_alloc_modo
    from public.student_payment_allocations as a
   where a.payment_id = v_pay.id
     and a.status = 'ACTIVE'
   order by a.sequencia
   limit 1;

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

  return private.payment_split_rateio(
           v_tenant, v_pay.student_id, v_valor, v_mes, v_eh_matricula
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
           'origem',           case when v_alloc_id is not null then 'ASAAS' end,
           'recebido_total',   v_total,
           'recebido_em',      v_recebido_em,
           'parcela',          round(v_valor, 2),
           'reservado',        greatest(round(v_total - v_valor, 2), 0),
           'cobertura_inicio', pg_catalog.to_char(v_inicio, 'YYYY-MM'),
           'cobertura_fim',    pg_catalog.to_char(v_fim, 'YYYY-MM')
         );
end;
$function$;

alter function private.payment_split_breakdown_unchecked(uuid) owner to postgres;
revoke all on function private.payment_split_breakdown_unchecked(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.payment_split_breakdown(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public'
as $function$
declare
  v_jwt_role text; v_caller_role text; v_caller_tenant text;
  v_tenant text; v_student uuid;
begin
  select coalesce(
           nullif(btrim(current_setting('request.jwt.claims', true)), '')::jsonb ->> 'role',
           ''
         )
    into v_jwt_role;

  select sp.tenant_id, sp.student_id into v_tenant, v_student
    from student_payments sp where sp.id = p_payment_id;
  if not found then return jsonb_build_object('error', 'pagamento_nao_encontrado'); end if;

  v_tenant := coalesce(v_tenant, (select p.tenant_id from profiles p where p.id = v_student));
  if v_tenant is null then return jsonb_build_object('error', 'escola_nao_identificada'); end if;

  if v_jwt_role in ('anon', 'authenticated') then
    select role, tenant_id into v_caller_role, v_caller_tenant
      from profiles where id = auth.uid();
    if v_caller_role is null or v_caller_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
      return jsonb_build_object('error', 'sem_permissao');
    end if;
    if v_caller_role <> 'SUPER_ADMIN' and v_caller_tenant is distinct from v_tenant then
      return jsonb_build_object('error', 'sem_permissao');
    end if;
  end if;

  return private.payment_split_breakdown_unchecked(p_payment_id);
end;
$function$;

alter function public.payment_split_breakdown(uuid) owner to postgres;
comment on function public.payment_split_breakdown(uuid) is
  'Rateio de um pagamento, calculado pela agenda do mês de COMPETÊNCIA (mês do '
  'vencimento). Taxa de matrícula não gera caixinha. Pagamento completo MENSAL '
  'rateia a 1ª parcela e informa recebido_total, parcela e reservado.';
revoke all on function public.payment_split_breakdown(uuid) from public, anon;
grant execute on function public.payment_split_breakdown(uuid) to authenticated, service_role;

-------------------------------------------------------------------------------
-- 5. Rateio de uma parcela k de pagamento completo MENSAL
-------------------------------------------------------------------------------
create or replace function private.payment_split_installment_unchecked(p_allocation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
  if v_alloc.status <> 'ACTIVE' then
    return jsonb_build_object('error', 'parcela_cancelada', 'allocation_id', v_alloc.id);
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
   where g.grupo_id = v_alloc.grupo_id
     and g.status = 'ACTIVE';

  v_total := round(coalesce(v_pay_value, v_soma, 0), 2);
  v_recebido := coalesce(v_alloc.recebido_em, v_pay_recebido);

  select pg_catalog.btrim(p.full_name) into v_aluno
    from public.profiles as p where p.id = v_alloc.student_id;

  return private.payment_split_rateio(
           v_alloc.tenant_id,
           v_alloc.student_id,
           v_alloc.valor,
           pg_catalog.to_char(v_alloc.competencia, 'YYYY-MM'),
           false
         )
      || jsonb_build_object(
           'payment_id',       v_alloc.payment_id,
           'allocation_id',    v_alloc.id,
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
$function$;

alter function private.payment_split_installment_unchecked(uuid) owner to postgres;
revoke all on function private.payment_split_installment_unchecked(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.payment_split_installment(p_allocation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public'
as $function$
declare
  v_jwt_role text; v_caller_role text; v_caller_tenant text; v_tenant text;
begin
  select coalesce(
           nullif(btrim(current_setting('request.jwt.claims', true)), '')::jsonb ->> 'role',
           ''
         )
    into v_jwt_role;

  select a.tenant_id into v_tenant
    from student_payment_allocations a where a.id = p_allocation_id;
  if not found then return jsonb_build_object('error', 'parcela_nao_encontrada'); end if;

  if v_jwt_role in ('anon', 'authenticated') then
    select role, tenant_id into v_caller_role, v_caller_tenant
      from profiles where id = auth.uid();
    if v_caller_role is null or v_caller_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
      return jsonb_build_object('error', 'sem_permissao');
    end if;
    if v_caller_role <> 'SUPER_ADMIN' and v_caller_tenant is distinct from v_tenant then
      return jsonb_build_object('error', 'sem_permissao');
    end if;
  end if;

  return private.payment_split_installment_unchecked(p_allocation_id);
end;
$function$;

alter function public.payment_split_installment(uuid) owner to postgres;
comment on function public.payment_split_installment(uuid) is
  'Rateio da parcela k de um pagamento completo MENSAL, no mesmo formato de '
  'payment_split_breakdown, com a caixinha pela agenda do mês da parcela, '
  'recebido_total, recebido_em, sequencia/meses e o que segue reservado.';
revoke all on function public.payment_split_installment(uuid) from public, anon;
grant execute on function public.payment_split_installment(uuid) to authenticated, service_role;

-------------------------------------------------------------------------------
-- 6. Registro de pagamento completo
-------------------------------------------------------------------------------
create or replace function private.prepayment_caller_can_write(p_tenant text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_jwt_role text := coalesce(auth.jwt() ->> 'role', '');
begin
  if p_tenant is null then
    return false;
  end if;
  if v_jwt_role = 'service_role'
     or (v_jwt_role = '' and session_user in ('postgres', 'supabase_admin')) then
    return true;
  end if;
  -- Decisão financeira é da direção: a coordenação lê, não registra.
  if not private.can_execute_legacy_role_rpc(array['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]) then
    return false;
  end if;
  return public.is_super_admin() or public._my_tenant_id() is not distinct from p_tenant;
end;
$function$;

alter function private.prepayment_caller_can_write(text) owner to postgres;
revoke all on function private.prepayment_caller_can_write(text)
  from public, anon, authenticated, service_role;

-- Mesmo caminho de register_advance_payment: UPDATE simples no perfil, por um
-- dono privilegiado. A mensalidade só é tocada quando está zerada, e em um
-- UPDATE separado: as travas de ciclo de vida disparam por COLUNA citada.
create or replace function private.prepayment_apply_profile(
  p_student uuid,
  p_monthly numeric,
  p_meses integer,
  p_through date
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.profiles as profile
     set paid_through = greatest(coalesce(profile.paid_through, p_through), p_through),
         prepaid_months = p_meses
   where profile.id = p_student
     and profile.role = 'STUDENT'
     and (profile.paid_through is distinct from
            greatest(coalesce(profile.paid_through, p_through), p_through)
          or profile.prepaid_months is distinct from p_meses);

  update public.profiles as profile
     set monthly_fee = p_monthly
   where profile.id = p_student
     and profile.role = 'STUDENT'
     and coalesce(profile.monthly_fee, 0) = 0
     and coalesce(p_monthly, 0) > 0;
end;
$function$;

alter function private.prepayment_apply_profile(uuid, numeric, integer, date) owner to postgres;
revoke all on function private.prepayment_apply_profile(uuid, numeric, integer, date)
  from public, anon, authenticated, service_role;

-- Insere as N parcelas com centavos exatos: base = total/N truncado em
-- centavos, e o resto (em centavos) vai 1 centavo para cada uma das primeiras.
-- A soma bate com o total, sempre.
create or replace function private.prepayment_insert_parcelas(
  p_tenant text,
  p_grupo uuid,
  p_payment_id uuid,
  p_student uuid,
  p_first date,
  p_meses integer,
  p_total numeric,
  p_modo text,
  p_origem text,
  p_recebido_em date,
  p_observacao text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_total_cents bigint := round(p_total * 100)::bigint;
  v_base_cents bigint;
  v_resto integer;
begin
  v_base_cents := v_total_cents / p_meses;
  v_resto := (v_total_cents - v_base_cents * p_meses)::integer;

  insert into public.student_payment_allocations (
    tenant_id, grupo_id, payment_id, student_id, competencia, sequencia, meses,
    valor, modo, origem, recebido_em, observacao, status, created_by
  )
  select p_tenant,
         p_grupo,
         p_payment_id,
         p_student,
         (p_first + pg_catalog.make_interval(months => k - 1))::date,
         k,
         p_meses,
         ((v_base_cents + case when k <= v_resto then 1 else 0 end)::numeric / 100)::numeric(12, 2),
         p_modo,
         p_origem,
         p_recebido_em,
         p_observacao,
         'ACTIVE',
         auth.uid()
    from pg_catalog.generate_series(1, p_meses) as k
  -- Recadastro depois de cancelar: a linha (pagamento, mês) volta a valer.
  on conflict (payment_id, competencia) do update
     set grupo_id = excluded.grupo_id,
         sequencia = excluded.sequencia,
         meses = excluded.meses,
         valor = excluded.valor,
         modo = excluded.modo,
         origem = excluded.origem,
         recebido_em = excluded.recebido_em,
         observacao = excluded.observacao,
         status = 'ACTIVE',
         created_at = now(),
         created_by = excluded.created_by,
         cancelled_at = null,
         cancelled_by = null;
end;
$function$;

alter function private.prepayment_insert_parcelas(
  text, uuid, uuid, uuid, date, integer, numeric, text, text, date, text
) owner to postgres;
revoke all on function private.prepayment_insert_parcelas(
  text, uuid, uuid, uuid, date, integer, numeric, text, text, date, text
) from public, anon, authenticated, service_role;

create or replace function private.prepayment_group_json(p_grupo uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'allocation_id', a.id,
           'competencia', pg_catalog.to_char(a.competencia, 'YYYY-MM'),
           'sequencia', a.sequencia,
           'valor', a.valor
         ) order by a.sequencia), '[]'::jsonb)
    from public.student_payment_allocations as a
   where a.grupo_id = p_grupo
     and a.status = 'ACTIVE'
$function$;

alter function private.prepayment_group_json(uuid) owner to postgres;
revoke all on function private.prepayment_group_json(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.register_prepayment(
  p_payment_id uuid,
  p_first_competencia date,
  p_meses integer,
  p_modo text default 'MENSAL'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_modo text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_modo, 'MENSAL')));
  v_tenant text;
  v_student uuid;
  v_student_tenant text;
  v_value numeric;
  v_status text;
  v_payment_type text;
  v_description text;
  v_due date;
  v_paid_at timestamptz;
  v_payment_date date;
  v_created timestamptz;
  v_first date;
  v_last date;
  v_through date;
  v_existentes integer;
  v_iguais boolean;
  v_conflitos text[];
  v_outbox_status text;
begin
  if p_payment_id is null then
    return jsonb_build_object('ok', false, 'error', 'pagamento_obrigatorio');
  end if;
  if v_modo not in ('MENSAL', 'LEGADO') then
    return jsonb_build_object('ok', false, 'error', 'modo_invalido');
  end if;
  if p_meses is null or p_meses < 2 or p_meses > 24 then
    return jsonb_build_object('ok', false, 'error', 'meses_invalidos');
  end if;

  select sp.tenant_id, sp.student_id, sp.value,
         pg_catalog.upper(pg_catalog.btrim(coalesce(sp.status, ''))),
         sp.payment_type, sp.description, sp.due_date, sp.paid_at, sp.payment_date, sp.created_at
    into v_tenant, v_student, v_value, v_status,
         v_payment_type, v_description, v_due, v_paid_at, v_payment_date, v_created
    from public.student_payments as sp
   where sp.id = p_payment_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'pagamento_nao_encontrado');
  end if;
  if not private.prepayment_caller_can_write(v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  if v_status not in ('RECEIVED', 'RECEIVED_IN_CASH') then
    return jsonb_build_object('ok', false, 'error', 'pagamento_nao_recebido');
  end if;
  if v_student is null then
    return jsonb_build_object('ok', false, 'error', 'pagamento_sem_aluno');
  end if;
  if coalesce(v_value, 0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'valor_invalido');
  end if;
  if private.payment_is_enrollment_fee(v_payment_type, v_description) then
    return jsonb_build_object('ok', false, 'error', 'pagamento_de_matricula');
  end if;
  select p.tenant_id into v_student_tenant
    from public.profiles as p where p.id = v_student and p.role = 'STUDENT';
  if v_student_tenant is distinct from v_tenant then
    return jsonb_build_object('ok', false, 'error', 'aluno_de_outra_escola');
  end if;

  v_first := pg_catalog.date_trunc(
    'month',
    coalesce(
      p_first_competencia,
      private.payment_competencia_of(v_due, v_paid_at, v_payment_date, v_created)
    )::timestamp
  )::date;
  v_last := (v_first + pg_catalog.make_interval(months => p_meses - 1))::date;
  v_through := (v_last + interval '1 month - 1 day')::date;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('student-payment-allocation:' || v_student::text, 0)
  );

  -- Idempotência: a mesma chamada devolve o que já existe.
  select count(*)::integer,
         coalesce(bool_and(a.modo = v_modo and a.meses = p_meses), false)
           and min(a.competencia) = v_first
           and count(*) = p_meses
    into v_existentes, v_iguais
    from public.student_payment_allocations as a
   where a.payment_id = p_payment_id
     and a.status = 'ACTIVE';
  if v_existentes > 0 then
    if v_iguais then
      return jsonb_build_object(
        'ok', true,
        'already_registered', true,
        'payment_id', p_payment_id,
        'grupo_id', p_payment_id,
        'modo', v_modo,
        'meses', p_meses,
        'primeira_competencia', pg_catalog.to_char(v_first, 'YYYY-MM'),
        'ultima_competencia', pg_catalog.to_char(v_last, 'YYYY-MM'),
        'recebido_total', round(v_value, 2),
        'parcelas', private.prepayment_group_json(p_payment_id)
      );
    end if;
    return jsonb_build_object(
      'ok', false,
      'error', 'pagamento_ja_tem_parcelas',
      'hint', 'cancele com cancel_prepayment antes de registrar de outro jeito'
    );
  end if;

  -- MENSAL só enquanto o aviso do rateio não saiu. Se o grupo já leu o
  -- rateio do valor cheio, ratear de novo mês a mês dobraria o dízimo.
  select o.status into v_outbox_status
    from public.management_payment_notification_outbox as o
   where o.tenant_id = v_tenant
     and o.payment_id = p_payment_id
     and o.notification_kind = 'PAYMENT_SPLIT'
   for update;
  if v_modo = 'MENSAL'
     and v_outbox_status is not null
     and v_outbox_status not in ('PENDING', 'SUPPRESSED', 'FAILED') then
    return jsonb_build_object(
      'ok', false,
      'error', 'aviso_do_rateio_ja_saiu',
      'hint', 'o valor cheio já foi rateado no aviso; registre como LEGADO',
      'aviso_status', v_outbox_status
    );
  end if;

  select array_agg(pg_catalog.to_char(a.competencia, 'YYYY-MM') order by a.competencia)
    into v_conflitos
    from public.student_payment_allocations as a
   where a.student_id = v_student
     and a.status = 'ACTIVE'
     and a.competencia between v_first and v_last;
  if v_conflitos is not null then
    return jsonb_build_object(
      'ok', false,
      'error', 'mes_ja_coberto',
      'meses', to_jsonb(v_conflitos)
    );
  end if;

  perform private.prepayment_insert_parcelas(
    v_tenant, p_payment_id, p_payment_id, v_student, v_first, p_meses,
    round(v_value, 2), v_modo, 'ASAAS',
    coalesce((v_paid_at at time zone 'America/Sao_Paulo')::date, v_payment_date, v_due),
    null
  );
  perform private.prepayment_apply_profile(
    v_student, round(v_value / p_meses, 2), p_meses, v_through
  );

  return jsonb_build_object(
    'ok', true,
    'already_registered', false,
    'payment_id', p_payment_id,
    'grupo_id', p_payment_id,
    'modo', v_modo,
    'meses', p_meses,
    'primeira_competencia', pg_catalog.to_char(v_first, 'YYYY-MM'),
    'ultima_competencia', pg_catalog.to_char(v_last, 'YYYY-MM'),
    'recebido_total', round(v_value, 2),
    'paid_through', v_through,
    'aviso_status', v_outbox_status,
    'parcelas', private.prepayment_group_json(p_payment_id)
  );
end;
$function$;

alter function public.register_prepayment(uuid, date, integer, text) owner to postgres;
comment on function public.register_prepayment(uuid, date, integer, text) is
  'Registra um pagamento Asaas já recebido como pagamento completo de N meses '
  '(2..24). MENSAL: rateio mês a mês (1/N, centavos exatos); só enquanto o '
  'aviso do rateio não saiu. LEGADO: só cobre os meses. Idempotente.';
revoke all on function public.register_prepayment(uuid, date, integer, text) from public, anon;
grant execute on function public.register_prepayment(uuid, date, integer, text)
  to authenticated, service_role;

create or replace function public.register_external_prepayment(
  p_student uuid,
  p_total numeric,
  p_received_on date,
  p_first_competencia date,
  p_meses integer,
  p_modo text default 'LEGADO',
  p_observacao text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_modo text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_modo, 'LEGADO')));
  v_total numeric := round(p_total, 2);
  v_tenant text;
  v_first date;
  v_last date;
  v_through date;
  v_grupo uuid;
  v_conflitos text[];
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if p_student is null then
    return jsonb_build_object('ok', false, 'error', 'aluno_obrigatorio');
  end if;
  if v_modo not in ('MENSAL', 'LEGADO') then
    return jsonb_build_object('ok', false, 'error', 'modo_invalido');
  end if;
  if p_meses is null or p_meses < 2 or p_meses > 24 then
    return jsonb_build_object('ok', false, 'error', 'meses_invalidos');
  end if;
  if p_total is null or p_total <= 0 or v_total <> p_total then
    return jsonb_build_object('ok', false, 'error', 'valor_invalido');
  end if;
  if p_received_on is null or p_received_on > v_hoje then
    return jsonb_build_object('ok', false, 'error', 'data_de_recebimento_invalida');
  end if;

  select p.tenant_id into v_tenant
    from public.profiles as p
   where p.id = p_student and p.role = 'STUDENT';
  if not found or v_tenant is null then
    return jsonb_build_object('ok', false, 'error', 'aluno_nao_encontrado');
  end if;
  if not private.prepayment_caller_can_write(v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  v_first := pg_catalog.date_trunc(
    'month', coalesce(p_first_competencia, p_received_on)::timestamp
  )::date;
  v_last := (v_first + pg_catalog.make_interval(months => p_meses - 1))::date;
  v_through := (v_last + interval '1 month - 1 day')::date;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('student-payment-allocation:' || p_student::text, 0)
  );

  -- Idempotência: mesmo aluno, mesmo recebimento, mesmos meses e valor.
  select a.grupo_id into v_grupo
    from public.student_payment_allocations as a
   where a.student_id = p_student
     and a.status = 'ACTIVE'
     and a.origem = 'EXTERNO'
     and a.sequencia = 1
     and a.competencia = v_first
     and a.meses = p_meses
     and a.modo = v_modo
     and a.recebido_em = p_received_on
     and (select sum(g.valor) from public.student_payment_allocations as g
           where g.grupo_id = a.grupo_id and g.status = 'ACTIVE') = v_total
   limit 1;
  if v_grupo is not null then
    return jsonb_build_object(
      'ok', true,
      'already_registered', true,
      'grupo_id', v_grupo,
      'modo', v_modo,
      'meses', p_meses,
      'primeira_competencia', pg_catalog.to_char(v_first, 'YYYY-MM'),
      'ultima_competencia', pg_catalog.to_char(v_last, 'YYYY-MM'),
      'recebido_total', v_total,
      'parcelas', private.prepayment_group_json(v_grupo)
    );
  end if;

  select array_agg(pg_catalog.to_char(a.competencia, 'YYYY-MM') order by a.competencia)
    into v_conflitos
    from public.student_payment_allocations as a
   where a.student_id = p_student
     and a.status = 'ACTIVE'
     and a.competencia between v_first and v_last;
  if v_conflitos is not null then
    return jsonb_build_object(
      'ok', false,
      'error', 'mes_ja_coberto',
      'meses', to_jsonb(v_conflitos)
    );
  end if;

  v_grupo := gen_random_uuid();
  -- Recebido por fora: não lança caixa. O dinheiro não passou pelo Asaas e o
  -- caixa só registra o que a conciliação consegue provar.
  perform private.prepayment_insert_parcelas(
    v_tenant, v_grupo, null, p_student, v_first, p_meses, v_total, v_modo,
    'EXTERNO', p_received_on, nullif(btrim(coalesce(p_observacao, '')), '')
  );
  perform private.prepayment_apply_profile(
    p_student, round(v_total / p_meses, 2), p_meses, v_through
  );

  return jsonb_build_object(
    'ok', true,
    'already_registered', false,
    'grupo_id', v_grupo,
    'modo', v_modo,
    'meses', p_meses,
    'primeira_competencia', pg_catalog.to_char(v_first, 'YYYY-MM'),
    'ultima_competencia', pg_catalog.to_char(v_last, 'YYYY-MM'),
    'recebido_total', v_total,
    'paid_through', v_through,
    'parcelas', private.prepayment_group_json(v_grupo)
  );
end;
$function$;

alter function public.register_external_prepayment(uuid, numeric, date, date, integer, text, text)
  owner to postgres;
comment on function public.register_external_prepayment(uuid, numeric, date, date, integer, text, text) is
  'Pagamento completo recebido fora do Asaas: cria só as parcelas (origem '
  'EXTERNO, sem pagamento vinculado) e não lança caixa. Padrão LEGADO: cobre os '
  'meses sem novo rateio. Idempotente. Devolve grupo_id (usado para cancelar).';
revoke all on function public.register_external_prepayment(uuid, numeric, date, date, integer, text, text)
  from public, anon;
grant execute on function public.register_external_prepayment(uuid, numeric, date, date, integer, text, text)
  to authenticated, service_role;

create or replace function public.cancel_prepayment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant text;
  v_student uuid;
  v_through date;
  v_cancelados integer;
  v_restante date;
  v_restante_meses integer;
  v_outbox_status text;
begin
  if p_payment_id is null then
    return jsonb_build_object('ok', false, 'error', 'referencia_obrigatoria');
  end if;

  -- Aceita o id do pagamento Asaas ou o grupo_id de um recebimento por fora.
  select a.tenant_id, a.student_id,
         (max(a.competencia) + interval '1 month - 1 day')::date
    into v_tenant, v_student, v_through
    from public.student_payment_allocations as a
   where (a.payment_id = p_payment_id or a.grupo_id = p_payment_id)
     and a.status = 'ACTIVE'
   group by a.tenant_id, a.student_id;
  if v_student is null then
    if exists (
      select 1 from public.student_payment_allocations as a
       where a.payment_id = p_payment_id or a.grupo_id = p_payment_id
    ) then
      select a.tenant_id into v_tenant
        from public.student_payment_allocations as a
       where a.payment_id = p_payment_id or a.grupo_id = p_payment_id
       limit 1;
      if not private.prepayment_caller_can_write(v_tenant) then
        return jsonb_build_object('ok', false, 'error', 'sem_permissao');
      end if;
      return jsonb_build_object('ok', true, 'cancelled', 0, 'already_cancelled', true);
    end if;
    return jsonb_build_object('ok', false, 'error', 'nada_a_cancelar');
  end if;
  if not private.prepayment_caller_can_write(v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('student-payment-allocation:' || v_student::text, 0)
  );

  update public.student_payment_allocations as a
     set status = 'CANCELLED',
         cancelled_at = now(),
         cancelled_by = auth.uid()
   where (a.payment_id = p_payment_id or a.grupo_id = p_payment_id)
     and a.status = 'ACTIVE';
  get diagnostics v_cancelados = row_count;

  -- Desfaz no perfil só o que este pagamento completo tinha gravado.
  select max(a.competencia),
         (array_agg(a.meses order by a.competencia desc))[1]
    into v_restante, v_restante_meses
    from public.student_payment_allocations as a
   where a.student_id = v_student
     and a.status = 'ACTIVE';
  update public.profiles as profile
     set paid_through = case when v_restante is null then null
                             else (v_restante + interval '1 month - 1 day')::date end,
         prepaid_months = v_restante_meses
   where profile.id = v_student
     and profile.paid_through = v_through;

  select o.status into v_outbox_status
    from public.management_payment_notification_outbox as o
   where o.payment_id = p_payment_id
     and o.notification_kind = 'PAYMENT_SPLIT';

  return jsonb_build_object(
    'ok', true,
    'cancelled', v_cancelados,
    'already_cancelled', false,
    -- O aviso da 1ª parcela pode já ter saído: quem cancela precisa saber.
    'aviso_ja_enviado', coalesce(v_outbox_status in ('PREPARED', 'SUBMITTING', 'SENT', 'UNKNOWN'), false)
  );
end;
$function$;

alter function public.cancel_prepayment(uuid) owner to postgres;
comment on function public.cancel_prepayment(uuid) is
  'Cancela as parcelas ativas de um pagamento completo (id do pagamento Asaas '
  'ou grupo_id de recebimento por fora). Mantém o histórico (status CANCELLED).';
revoke all on function public.cancel_prepayment(uuid) from public, anon;
grant execute on function public.cancel_prepayment(uuid) to authenticated, service_role;

-------------------------------------------------------------------------------
-- 7. Relatório do mês: caixa pelo valor cheio, rateio pela parcela
-------------------------------------------------------------------------------
create or replace function public.payment_split_report(p_month text default null::text, p_tenant text default null::text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text; v_ini date;
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
  'Rateio do mês. "recebido" é caixa (valor cheio, inclusive pagamento '
  'completo); o rateio de pagamento completo MENSAL sai pela parcela do mês. '
  'Aceita workers internos sem claims.';
revoke all on function public.payment_split_report(text, text) from public, anon;
grant execute on function public.payment_split_report(text, text) to authenticated, service_role;

-------------------------------------------------------------------------------
-- 8. Fechamento da caixinha: caixinha AVISADA × folha, por competência
-------------------------------------------------------------------------------
create or replace function private.caixinha_fechamento_unchecked(p_month text, p_tenant text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_ini date;
  v_fim date;
  v_professores jsonb;
  v_totais jsonb;
begin
  v_ini := (p_month || '-01')::date;
  v_fim := (v_ini + interval '1 month - 1 day')::date;

  with
  donos as (
    select o.teacher_id
      from public.payment_split_owner_teachers as o
     where o.tenant_id = p_tenant
  ),
  -- o que foi DADO: fonte única de "esta aula paga"
  folha as (
    select v.teacher_id, v.student_id, count(*)::int as aulas,
           round(sum(v.rate_efetivo), 2) as valor
      from public.v_payable_class_logs as v
     where v.tenant_id = p_tenant
       and v.class_date between v_ini and v_fim
     group by 1, 2
  ),
  -- pagamentos da COMPETÊNCIA. Pagamento completo MENSAL entra pelas parcelas.
  pagos as (
    select sp.id, sp.student_id
      from public.student_payments as sp
     where sp.tenant_id = p_tenant
       and sp.status in ('RECEIVED', 'RECEIVED_IN_CASH')
       and coalesce(sp.value, 0) > 0
       and private.payment_competencia_of(sp.due_date, sp.paid_at, sp.payment_date, sp.created_at) = v_ini
       and not exists (
         select 1 from public.student_payment_allocations as a
          where a.payment_id = sp.id and a.status = 'ACTIVE' and a.modo = 'MENSAL'
       )
  ),
  parcelas as (
    select a.id, a.student_id, a.payment_id, a.sequencia
      from public.student_payment_allocations as a
     where a.tenant_id = p_tenant
       and a.status = 'ACTIVE'
       and a.modo = 'MENSAL'
       and a.competencia = v_ini
  ),
  -- Avisado = o que o grupo LEU: snapshot congelado no outbox. Sem aviso
  -- (suprimido, falhou, antes da ativação), recalcula e marca sem_aviso.
  fontes as (
    select 'PAGAMENTO'::text as tipo, p.id as fonte_id, p.student_id,
           (aviso.snap is null) as sem_aviso,
           -- Mês da agenda que o aviso usou. Avisos da regra antiga usavam o
           -- mês do CAIXA; quando difere da competência, a diferença tem nome.
           aviso.snap ->> 'month' as aviso_mes,
           coalesce(aviso.snap, private.payment_split_breakdown_unchecked(p.id)) as b
      from pagos as p
      left join lateral (
        select ob.source_snapshot as snap
          from public.management_payment_notification_outbox as ob
         where ob.tenant_id = p_tenant
           and ob.payment_id = p.id
           and ob.notification_kind = 'PAYMENT_SPLIT'
           and ob.status in ('PREPARED', 'SUBMITTING', 'SENT', 'UNKNOWN')
           and jsonb_typeof(ob.source_snapshot) = 'object'
         limit 1
      ) as aviso on true
    union all
    -- Parcela k: a 1ª de pagamento Asaas saiu no aviso do próprio pagamento;
    -- as outras são reserva, calculadas pela agenda do mês da parcela.
    select 'PARCELA'::text, pa.id, pa.student_id,
           (aviso.snap is null and pa.sequencia = 1 and pa.payment_id is not null),
           aviso.snap ->> 'month',
           coalesce(aviso.snap, private.payment_split_installment_unchecked(pa.id))
      from parcelas as pa
      left join lateral (
        select ob.source_snapshot as snap
          from public.management_payment_notification_outbox as ob
         where pa.sequencia = 1
           and pa.payment_id is not null
           and ob.tenant_id = p_tenant
           and ob.payment_id = pa.payment_id
           and ob.notification_kind = 'PAYMENT_SPLIT'
           and ob.status in ('PREPARED', 'SUBMITTING', 'SENT', 'UNKNOWN')
           and jsonb_typeof(ob.source_snapshot) = 'object'
         limit 1
      ) as aviso on true
  ),
  caixinha as (
    select (prof ->> 'teacher_id')::uuid as teacher_id,
           f.student_id,
           round(sum((prof ->> 'custo')::numeric), 2) as valor,
           round(coalesce(sum((prof ->> 'custo')::numeric) filter (where f.sem_aviso), 0), 2)
             as valor_sem_aviso,
           count(distinct f.fonte_id)::int as avisos,
           bool_or(f.sem_aviso) as sem_aviso,
           bool_or(f.aviso_mes is not null and f.aviso_mes <> p_month) as aviso_de_outro_mes
      from fontes as f
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(f.b -> 'professores') = 'array'
             then f.b -> 'professores' else '[]'::jsonb end
      ) as prof
     where prof ->> 'custo' is not null
       and prof ->> 'teacher_id' is not null
     group by 1, 2
  ),
  -- cobranças da competência, e se alguma ficou sem liquidar
  cobrancas as (
    select sp.student_id,
           count(*) filter (where sp.status in ('RECEIVED', 'RECEIVED_IN_CASH'))::int as pagas,
           bool_or(sp.status = 'CONFIRMED') as tem_confirmed
      from public.student_payments as sp
     where sp.tenant_id = p_tenant
       and sp.student_id is not null
       and private.payment_competencia_of(sp.due_date, sp.paid_at, sp.payment_date, sp.created_at) = v_ini
     group by 1
  ),
  cobertura as (
    select a.student_id,
           bool_or(a.modo = 'LEGADO') as legado,
           count(*)::int as parcelas
      from public.student_payment_allocations as a
     where a.tenant_id = p_tenant
       and a.status = 'ACTIVE'
       and a.competencia = v_ini
     group by 1
  ),
  previsto as (
    select b.teacher_id,
           count(*)::int as aulas,
           round(sum(public.teacher_student_rate(b.teacher_id, b.student_id, d::date)), 2) as valor
      from public.bookings as b
      cross join pg_catalog.generate_series(v_ini::timestamp, v_fim::timestamp, interval '1 day') as d
     where b.tenant_id = p_tenant
       and coalesce(b.status, 'SCHEDULED') = 'SCHEDULED'
       and b.student_id is not null
       and public.dow_name_to_int(b.day_of_week) = extract(dow from d)::int
       and (b.start_date is null or d::date >= b.start_date)
     group by 1
  ),
  sobras as (
    select co.teacher_id, count(*)::int as aulas, round(sum(co.amount), 2) as valor
      from public.closing_carryovers as co
      join public.class_logs as cl
        on cl.id = co.class_log_id
       and cl.tenant_id = p_tenant
     where co.absorbed_month = p_month
     group by 1
  ),
  ajustes as (
    select a.teacher_id, round(sum(a.amount), 2) as valor
      from public.closing_adjustments as a
     where a.tenant_id = p_tenant
       and a.month_year = p_month
     group by 1
  ),
  fechamento as (
    select c.teacher_id, c.total_lessons, c.total_amount, c.status
      from public.teacher_closings as c
     where c.tenant_id = p_tenant
       and c.month_year = p_month
  ),
  detalhe as (
    select coalesce(f.teacher_id, c.teacher_id) as teacher_id,
           coalesce(f.student_id, c.student_id) as student_id,
           coalesce(f.aulas, 0) as aulas,
           coalesce(f.valor, 0) as valor_folha,
           coalesce(c.valor, 0) as valor_caixinha,
           coalesce(c.valor_sem_aviso, 0) as valor_sem_aviso,
           coalesce(c.avisos, 0) as avisos,
           coalesce(c.sem_aviso, false) as sem_aviso,
           coalesce(c.aviso_de_outro_mes, false) as aviso_de_outro_mes,
           coalesce(cb.pagas, 0) + coalesce(cv.parcelas, 0) as cobrancas_pagas,
           coalesce(cb.tem_confirmed, false) as tem_confirmed,
           coalesce(cv.legado, false) as legado
      from folha as f
      full join caixinha as c
        on c.teacher_id = f.teacher_id
       and c.student_id is not distinct from f.student_id
      left join cobrancas as cb on cb.student_id = coalesce(f.student_id, c.student_id)
      left join cobertura as cv on cv.student_id = coalesce(f.student_id, c.student_id)
     where not exists (
       select 1 from donos as o where o.teacher_id = coalesce(f.teacher_id, c.teacher_id)
     )
  ),
  classificado as (
    select d.*,
           round(d.valor_folha - d.valor_caixinha, 2) as diferenca,
           case
             when d.student_id is null then 'AULA_SEM_ALUNO'
             -- Pagamento completo LEGADO já foi rateado no recebimento: não
             -- separou nada para este mês. A escola completa do próprio caixa.
             when d.legado and d.valor_caixinha = 0 and d.valor_folha > 0
               then 'PREPAGO_SEM_RESERVA'
             when d.valor_caixinha = 0 and d.cobrancas_pagas > 0 then 'PAGOU_SEM_AGENDA'
             when d.valor_caixinha = 0 and d.tem_confirmed then 'PAGAMENTO_NAO_LIQUIDADO'
             when d.valor_caixinha = 0 then 'ALUNO_SEM_PAGAMENTO'
             when d.valor_caixinha > d.valor_folha and d.avisos > 1 then 'PAGAMENTO_REPETIDO'
             -- O aviso separou a agenda de OUTRO mês (regra antiga, mês do
             -- caixa): cartão de agosto creditado em setembro avisou a agenda
             -- de setembro. Não é aula faltando nem agenda errada.
             when d.aviso_de_outro_mes and d.valor_caixinha <> d.valor_folha
               then 'AVISO_DE_OUTRO_MES'
             when d.valor_caixinha > d.valor_folha then 'AULA_NAO_LANCADA'
             when d.valor_folha > d.valor_caixinha then 'AGENDA_DESATUALIZADA'
             -- Bate, mas o grupo nunca recebeu o aviso: o valor é recalculado.
             when d.sem_aviso then 'SEM_AVISO'
             else 'OK'
           end as motivo
      from detalhe as d
  ),
  por_professor as (
    select cl.teacher_id,
           jsonb_agg(
             jsonb_build_object(
               'motivo', cl.motivo,
               'student_id', cl.student_id,
               'aluno', coalesce(pg_catalog.btrim(s.full_name), 'sem aluno vinculado'),
               'aulas', cl.aulas,
               'folha', cl.valor_folha,
               'caixinha', cl.valor_caixinha,
               'caixinha_sem_aviso', cl.valor_sem_aviso,
               'diferenca', cl.diferenca,
               'avisos', cl.avisos,
               'sem_aviso', cl.sem_aviso,
               'aviso_de_outro_mes', cl.aviso_de_outro_mes
             )
             order by abs(cl.diferenca) desc, cl.valor_folha desc
           ) filter (where cl.motivo <> 'OK') as itens,
           round(sum(cl.valor_folha), 2) as folha_aulas,
           round(sum(cl.valor_caixinha), 2) as caixinha,
           round(sum(cl.valor_sem_aviso), 2) as caixinha_sem_aviso
      from classificado as cl
      left join public.profiles as s on s.id = cl.student_id
     group by 1
  )
  select jsonb_agg(linha order by linha ->> 'teacher_name'),
         jsonb_build_object(
           'previsto', round(coalesce(sum((linha ->> 'previsto')::numeric), 0), 2),
           'folha', round(coalesce(sum((linha ->> 'folha')::numeric), 0), 2),
           'caixinha', round(coalesce(sum((linha ->> 'caixinha')::numeric), 0), 2),
           'caixinha_sem_aviso', round(coalesce(sum((linha ->> 'caixinha_sem_aviso')::numeric), 0), 2),
           'diferenca', round(coalesce(sum((linha ->> 'diferenca')::numeric), 0), 2),
           'professores', count(*)::int,
           'pro_labore_fora', count(*) filter (where (linha ->> 'pro_labore')::boolean)::int
         )
    into v_professores, v_totais
    from (
      select jsonb_build_object(
               'teacher_id', t.id,
               'teacher_name', pg_catalog.btrim(t.full_name),
               'previsto', coalesce(pv.valor, 0),
               'previsto_aulas', coalesce(pv.aulas, 0),
               'folha', coalesce(fc.total_amount, pp.folha_aulas, 0),
               'folha_aulas', coalesce(fc.total_lessons, 0),
               'status', coalesce(fc.status, 'SEM FECHAMENTO'),
               'pro_labore', (dn.teacher_id is not null),
               'caixinha', case when dn.teacher_id is null then coalesce(pp.caixinha, 0) end,
               'caixinha_sem_aviso', case when dn.teacher_id is null
                                          then coalesce(pp.caixinha_sem_aviso, 0) end,
               'diferenca', case when dn.teacher_id is null then round(
                 coalesce(fc.total_amount, pp.folha_aulas, 0) - coalesce(pp.caixinha, 0), 2) end,
               'acao', case
                 when dn.teacher_id is not null then 'PRO_LABORE'
                 when round(coalesce(fc.total_amount, pp.folha_aulas, 0) - coalesce(pp.caixinha, 0), 2) > 0
                   then 'COMPLETAR'
                 when round(coalesce(fc.total_amount, pp.folha_aulas, 0) - coalesce(pp.caixinha, 0), 2) < 0
                   then 'DEVOLVER'
                 else 'OK'
               end,
               'sobras', jsonb_build_object(
                 'aulas', coalesce(sb.aulas, 0), 'valor', coalesce(sb.valor, 0)),
               'ajustes', coalesce(aj.valor, 0),
               'turbo', jsonb_build_object(
                 'ativo', public.teacher_turbo_on(t.id, v_fim),
                 'alunos', (select count(*)::int from public.teacher_carteira(t.id)),
                 'detalhe', public.teacher_turbo_status_at(t.id, v_fim)),
               'itens', coalesce(pp.itens, '[]'::jsonb)
             ) as linha
        from public.profiles as t
        left join por_professor as pp on pp.teacher_id = t.id
        left join previsto as pv on pv.teacher_id = t.id
        left join sobras as sb on sb.teacher_id = t.id
        left join ajustes as aj on aj.teacher_id = t.id
        left join fechamento as fc on fc.teacher_id = t.id
        left join donos as dn on dn.teacher_id = t.id
       where t.tenant_id = p_tenant
         and t.role = 'TEACHER'
         and (pp.teacher_id is not null or fc.teacher_id is not null
              or pv.teacher_id is not null)
    ) as x;

  return jsonb_build_object(
    'month', p_month,
    'tenant', p_tenant,
    'regime', 'competencia',
    'totais', coalesce(v_totais, '{}'::jsonb),
    'professores', coalesce(v_professores, '[]'::jsonb)
  );
end;
$function$;

alter function private.caixinha_fechamento_unchecked(text, text) owner to postgres;
revoke all on function private.caixinha_fechamento_unchecked(text, text)
  from public, anon, authenticated, service_role;

-- O painel Caixinha × Folha passa a ler a MESMA conta do fechamento do dia 1º:
-- tela e mensagem não podem divergir. As chaves que o painel lê continuam.
create or replace function public.teacher_payroll_reconciliation(p_month text default null::text, p_tenant text default null::text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_month text;
  v_tenant text;
begin
  if not private.can_execute_legacy_role_rpc(
    array['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
  ) then
    return jsonb_build_object('error', 'sem_permissao');
  end if;

  -- O tenant vem SEMPRE do perfil de quem chamou. Só o SUPER_ADMIN escolhe,
  -- senão um diretor leria a folha de outra escola passando o slug no corpo.
  v_tenant := case
    when is_super_admin() and nullif(btrim(coalesce(p_tenant, '')), '') is not null
      then btrim(p_tenant)
    else _my_tenant_id()
  end;
  if v_tenant is null then
    return jsonb_build_object('error', 'sem_tenant');
  end if;

  v_month := coalesce(nullif(btrim(coalesce(p_month, '')), ''),
                      to_char(current_date, 'YYYY-MM'));
  if v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    return jsonb_build_object('error', 'mes_invalido');
  end if;

  return private.caixinha_fechamento_unchecked(v_month, v_tenant);
end;
$function$;

alter function public.teacher_payroll_reconciliation(text, text) owner to postgres;
revoke all on function public.teacher_payroll_reconciliation(text, text) from public, anon;
grant execute on function public.teacher_payroll_reconciliation(text, text)
  to authenticated, service_role;
comment on function public.teacher_payroll_reconciliation(text, text) is
  'Concilia a caixinha AVISADA no grupo da gestão (snapshot do outbox; sem '
  'aviso, recalculada e marcada) com a folha, por COMPETÊNCIA (mês do '
  'vencimento), decompondo a diferença por motivo. Mesma conta de '
  'caixinha_fechamento.';

create or replace function public.caixinha_fechamento(
  p_month text default null,
  p_tenant text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  v_trusted boolean;
  v_tenant text;
  v_month text;
  v_base jsonb;
begin
  if not private.can_execute_legacy_role_rpc(
    array['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
  ) then
    return jsonb_build_object('error', 'sem_permissao');
  end if;

  -- Escola do perfil de quem chamou. Só SUPER_ADMIN e o worker do dia 1º
  -- (service_role) escolhem a escola.
  v_trusted := v_jwt_role = 'service_role'
    or (v_jwt_role = '' and session_user in ('postgres', 'supabase_admin'));
  v_tenant := case
    when (v_trusted or public.is_super_admin())
         and nullif(pg_catalog.btrim(coalesce(p_tenant, '')), '') is not null
      then pg_catalog.btrim(p_tenant)
    else public._my_tenant_id()
  end;
  if v_tenant is null then
    return jsonb_build_object('error', 'sem_tenant');
  end if;

  -- Padrão: o mês que acabou de fechar (no fuso da escola).
  v_month := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_month, '')), ''),
    pg_catalog.to_char(
      pg_catalog.date_trunc('month', (now() at time zone 'America/Sao_Paulo')) - interval '1 month',
      'YYYY-MM'
    )
  );
  if v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    return jsonb_build_object('error', 'mes_invalido');
  end if;

  v_base := private.caixinha_fechamento_unchecked(v_month, v_tenant);

  return jsonb_build_object(
    'month', v_month,
    'tenant', v_tenant,
    'regime', 'competencia',
    'gerado_em', now(),
    -- Direção fica fora da caixinha: a régua dela é pró-labore.
    'direcao_fora', coalesce((
      select jsonb_agg(jsonb_build_object(
               'teacher_id', l -> 'teacher_id',
               'teacher_name', l -> 'teacher_name',
               'folha', l -> 'folha'
             ) order by l ->> 'teacher_name')
        from jsonb_array_elements(v_base -> 'professores') as l
       where (l ->> 'pro_labore')::boolean
    ), '[]'::jsonb),
    'professores', coalesce((
      select jsonb_agg(l order by l ->> 'teacher_name')
        from jsonb_array_elements(v_base -> 'professores') as l
       where not (l ->> 'pro_labore')::boolean
    ), '[]'::jsonb),
    'totais', (
      select jsonb_build_object(
               'professores', count(*)::int,
               'folha', round(coalesce(sum((l ->> 'folha')::numeric), 0), 2),
               'caixinha', round(coalesce(sum((l ->> 'caixinha')::numeric), 0), 2),
               'caixinha_sem_aviso', round(coalesce(sum((l ->> 'caixinha_sem_aviso')::numeric), 0), 2),
               'diferenca', round(coalesce(sum((l ->> 'diferenca')::numeric), 0), 2),
               'completar', round(coalesce(sum((l ->> 'diferenca')::numeric)
                                   filter (where (l ->> 'diferenca')::numeric > 0), 0), 2),
               'devolver', round(abs(coalesce(sum((l ->> 'diferenca')::numeric)
                                   filter (where (l ->> 'diferenca')::numeric < 0), 0)), 2)
             )
        from jsonb_array_elements(v_base -> 'professores') as l
       where not (l ->> 'pro_labore')::boolean
    )
  );
end;
$function$;

alter function public.caixinha_fechamento(text, text) owner to postgres;
comment on function public.caixinha_fechamento(text, text) is
  'Fechamento da caixinha por professor contratado na competência: folha '
  '(teacher_closings, senão aulas pagáveis) × caixinha avisada no grupo, quanto '
  'completar (>0) ou devolver (<0) e o motivo por aluno. Padrão: mês anterior.';
revoke all on function public.caixinha_fechamento(text, text) from public, anon;
grant execute on function public.caixinha_fechamento(text, text) to authenticated, service_role;

-------------------------------------------------------------------------------
-- 9. Mês coberto não é pendência (D3). Definições vivas copiadas; só o
--    necessário mudou, marcado com "cobertura:".
-------------------------------------------------------------------------------
create or replace function public.refresh_monthly_payment_closure(p_tenant_id text, p_period_start date)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  v_period_start date := pg_catalog.date_trunc('month', p_period_start)::date;
  v_period_end date := (pg_catalog.date_trunc('month', p_period_start) + interval '1 month')::date;
  business_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  closure_row public.monthly_payment_closures%rowtype;
  expected_count integer := 0;
  settled_count integer := 0;
  blocked_count integer := 0;
  missing_count integer := 0;
  open_count integer := 0;
  waiting_credit_count integer := 0;
  review_count integer := 0;
  unclassified_count integer := 0;
  reconciliation_count integer := 0;
  competence_billed numeric := 0;
  competence_settled numeric := 0;
  cash_report jsonb := '{}'::jsonb;
  cash_totals jsonb := '{}'::jsonb;
  rules_snapshot jsonb := '{}'::jsonb;
  blockers jsonb := '[]'::jsonb;
  obligation_states jsonb := '[]'::jsonb;
  next_snapshot jsonb;
  next_hash text;
  next_status text;
  destination text;
begin
  if normalized_tenant is null
     or p_period_start is null
     or v_period_start > pg_catalog.date_trunc(
       'month',
       pg_catalog.now() at time zone 'America/Sao_Paulo'
     )::date
     or v_period_start < date '2020-01-01'
     or not exists (
       select 1 from public.tenants as tenant
        where tenant.id = normalized_tenant
     )
  then
    raise exception using
      errcode = '22023',
      message = 'monthly_payment_closure_arguments_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'monthly-payment-closure:' || normalized_tenant || ':' || v_period_start::text,
      0
    )
  );

  insert into public.monthly_payment_closures (tenant_id, period_start)
  values (normalized_tenant, v_period_start)
  on conflict on constraint monthly_payment_closures_pkey do nothing;

  -- Freeze every student that was either billable when this month was first
  -- observed or already has a recurring invoice in the competence. Subsequent
  -- refreshes can add a newly enrolled student, but never remove a frozen row.
  insert into public.monthly_payment_obligations (
    tenant_id,
    period_start,
    student_id,
    roster_source,
    expected_amount
  )
  select
    normalized_tenant,
    v_period_start,
    candidate.student_id,
    case when candidate.active_roster then 'ACTIVE_ROSTER'
         else 'RECORDED_INVOICE' end,
    -- cobertura: aluno com mensalidade zerada coberto por pagamento completo
    -- espera o valor da parcela, não zero.
    greatest(
      case
        when candidate.prepaid_amount is not null
             and coalesce(profile.monthly_fee, 0) = 0
          then candidate.prepaid_amount
        else coalesce(profile.monthly_fee, candidate.invoice_amount, 0)
      end,
      0
    )
  from (
    select
      profile.id as student_id,
      true as active_roster,
      null::numeric as invoice_amount,
      null::numeric as prepaid_amount
    from public.profiles as profile
    join public.tenant_memberships as membership
      on membership.user_id = profile.id
     and membership.tenant_id = normalized_tenant
     and membership.role = 'STUDENT'
     and membership.status = 'ACTIVE'
   where profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
     and profile.status = 'Ativo'
     and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
     and coalesce(profile.monthly_fee, 0) > 0
     and coalesce(profile.is_test_account, false) is false
     and profile.test_fixture_key is null
     and profile.created_at < v_period_end
     and (profile.start_date is null or profile.start_date < v_period_end)

    union

    select
      payment.student_id,
      false,
      max(payment.value),
      null::numeric
    from public.student_payments as payment
    join public.profiles as profile on profile.id = payment.student_id
   where payment.tenant_id = normalized_tenant
     and payment.student_id is not null
     and payment.payment_type = 'SUBSCRIPTION'
     and pg_catalog.upper(pg_catalog.btrim(coalesce(
       payment.status,
       ''
     ))) not in ('CANCELLED', 'NAO_RECEITA')
     and payment.due_date >= v_period_start
     and payment.due_date < v_period_end
     and coalesce(payment.value, 0) > 0
     and coalesce(profile.is_test_account, false) is false
     and profile.test_fixture_key is null
   group by payment.student_id

    union

    -- cobertura: aluno ativo com o mês coberto por pagamento completo entra no
    -- rol mesmo com a mensalidade zerada — senão o mês coberto some da conta.
    select
      profile.id,
      true,
      null::numeric,
      max(allocation.valor)
    from public.profiles as profile
    join public.tenant_memberships as membership
      on membership.user_id = profile.id
     and membership.tenant_id = normalized_tenant
     and membership.role = 'STUDENT'
     and membership.status = 'ACTIVE'
    join public.student_payment_allocations as allocation
      on allocation.student_id = profile.id
     and allocation.tenant_id = normalized_tenant
     and allocation.competencia = v_period_start
     and allocation.status = 'ACTIVE'
   where profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
     and profile.status = 'Ativo'
     and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
     and coalesce(profile.is_test_account, false) is false
     and profile.test_fixture_key is null
     and profile.created_at < v_period_end
     and (profile.start_date is null or profile.start_date < v_period_end)
   group by profile.id
  ) as candidate
  join public.profiles as profile on profile.id = candidate.student_id
  on conflict on constraint monthly_payment_obligations_pkey do nothing;

  with invoice_stats as (
    select
      obligation.tenant_id,
      obligation.period_start,
      obligation.student_id,
      count(payment.id) filter (
        where payment.id is not null
          and upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
            'CANCELLED', 'NAO_RECEITA'
          )
      )::integer as live_count,
      count(payment.id) filter (
        where upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
          'RECEIVED', 'RECEIVED_IN_CASH'
        )
          and coalesce(payment.refunded_amount, 0) = 0
      )::integer as settled_count,
      count(payment.id) filter (
        where upper(pg_catalog.btrim(coalesce(payment.status, ''))) = 'CONFIRMED'
      )::integer as confirmed_count,
      count(payment.id) filter (
        where coalesce(payment.refunded_amount, 0) > 0
          or upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
            'REFUNDED', 'PARTIALLY_REFUNDED'
          )
      )::integer as refunded_count,
      round(coalesce(sum(payment.value) filter (
        where upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
          'CANCELLED', 'NAO_RECEITA'
        )
      ), 0), 2) as billed_amount,
      round(coalesce(sum(payment.value - coalesce(payment.refunded_amount, 0)) filter (
        where upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
          'RECEIVED', 'RECEIVED_IN_CASH'
        )
      ), 0), 2) as settled_amount,
      coalesce(array_agg(payment.id order by payment.id) filter (
        where payment.id is not null
          and upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
            'CANCELLED', 'NAO_RECEITA'
          )
      ), '{}'::uuid[]) as payment_ids,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'payment_id', payment.id,
            'status', payment.status,
            'provider_status', payment.provider_status,
            'value', payment.value,
            'billing_type', payment.billing_type,
            'refunded_amount', payment.refunded_amount
          ) order by payment.id
        ) filter (where payment.id is not null),
        '[]'::jsonb
      ) as invoices
    from public.monthly_payment_obligations as obligation
    left join public.student_payments as payment
      on payment.tenant_id = obligation.tenant_id
     and payment.student_id = obligation.student_id
     and payment.payment_type = 'SUBSCRIPTION'
     and payment.due_date >= obligation.period_start
     and payment.due_date < (
       pg_catalog.date_trunc('month', obligation.period_start) + interval '1 month'
     )::date
     -- cobertura: pagamento completo vale pelos meses das parcelas, não pelo
     -- mês do vencimento dele.
     and not exists (
       select 1
         from public.student_payment_allocations as allocation
        where allocation.payment_id = payment.id
          and allocation.status = 'ACTIVE'
     )
   where obligation.tenant_id = normalized_tenant
     and obligation.period_start = v_period_start
   group by obligation.tenant_id, obligation.period_start, obligation.student_id
  ),
  -- cobertura: parcelas ativas de pagamento completo na competência
  coverage as (
    select
      allocation.student_id,
      round(sum(allocation.valor), 2) as amount,
      array_agg(allocation.id order by allocation.id) as allocation_ids,
      coalesce(
        array_agg(distinct allocation.payment_id)
          filter (where allocation.payment_id is not null),
        '{}'::uuid[]
      ) as payment_ids,
      jsonb_agg(
        jsonb_build_object(
          'allocation_id', allocation.id,
          'payment_id', allocation.payment_id,
          'modo', allocation.modo,
          'origem', allocation.origem,
          'sequencia', allocation.sequencia,
          'meses', allocation.meses,
          'valor', allocation.valor
        ) order by allocation.id
      ) as items
    from public.student_payment_allocations as allocation
   where allocation.tenant_id = normalized_tenant
     and allocation.competencia = v_period_start
     and allocation.status = 'ACTIVE'
   group by allocation.student_id
  )
  update public.monthly_payment_obligations as obligation
     set billed_amount = invoice.billed_amount + coalesce(cov.amount, 0),
         settled_amount = invoice.settled_amount + coalesce(cov.amount, 0),
         payment_ids = case
           when cov.student_id is null then invoice.payment_ids
           else array(
             select distinct combined.payment_id
               from unnest(invoice.payment_ids || cov.payment_ids) as combined(payment_id)
              order by combined.payment_id
           )
         end,
         status = case
           when coalesce(
               obligation.details ->> 'excluded_reason',
               ''
             ) = 'LEGACY_POST_OFFBOARDING_NO_LIVE_INVOICE'
             and invoice.live_count = 0
             then 'EXCLUDED'
           when obligation.status = 'EXCLUDED'
             and coalesce(
               obligation.details ->> 'excluded_reason',
               ''
             ) <> 'LEGACY_POST_OFFBOARDING_NO_LIVE_INVOICE'
             then 'EXCLUDED'
           -- cobertura: mês pago pelo pagamento completo está quitado. Se além
           -- dele existe cobrança viva no mês, é cobrança em dobro: revisar.
           when cov.student_id is not null and invoice.live_count = 0 then 'SETTLED'
           when cov.student_id is not null then 'REVIEW'
           when invoice.live_count = 0 then 'MISSING_BILL'
           when invoice.refunded_count > 0 then 'REVIEW'
           when invoice.live_count > 1 then 'REVIEW'
           when invoice.settled_count = invoice.live_count then 'SETTLED'
           when invoice.confirmed_count > 0 then 'WAITING_CREDIT'
           else 'OPEN'
         end,
         details = (coalesce(
           obligation.details,
           '{}'::jsonb
         ) - 'prepaid_coverage') || jsonb_build_object(
           'invoice_count', invoice.live_count,
           'settled_count', invoice.settled_count,
           'confirmed_count', invoice.confirmed_count,
           'refunded_count', invoice.refunded_count,
           'invoices', invoice.invoices
         ) || case
           when cov.student_id is null then '{}'::jsonb
           else jsonb_build_object(
             'prepaid_coverage', jsonb_build_object(
               'reason', case when invoice.live_count = 0
                              then 'PREPAID_COVERAGE'
                              else 'PREPAID_COVERAGE_WITH_LIVE_INVOICE' end,
               'amount', cov.amount,
               'allocation_ids', to_jsonb(cov.allocation_ids),
               'payment_ids', to_jsonb(cov.payment_ids),
               'items', cov.items
             )
           )
         end,
         updated_at = pg_catalog.now()
    from invoice_stats as invoice
    left join coverage as cov on cov.student_id = invoice.student_id
   where obligation.tenant_id = invoice.tenant_id
     and obligation.period_start = invoice.period_start
     and obligation.student_id = invoice.student_id;

  select
    count(*)::integer,
    count(*) filter (where obligation.status in ('SETTLED', 'EXCLUDED'))::integer,
    count(*) filter (where obligation.status not in ('SETTLED', 'EXCLUDED'))::integer,
    count(*) filter (where obligation.status = 'MISSING_BILL')::integer,
    count(*) filter (where obligation.status = 'OPEN')::integer,
    count(*) filter (where obligation.status = 'WAITING_CREDIT')::integer,
    count(*) filter (where obligation.status = 'REVIEW')::integer,
    round(coalesce(sum(obligation.billed_amount), 0), 2),
    round(coalesce(sum(obligation.settled_amount), 0), 2),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'student_id', obligation.student_id,
          'student_name', profile.full_name,
          'status', obligation.status,
          'expected_amount', obligation.expected_amount,
          'billed_amount', obligation.billed_amount,
          'settled_amount', obligation.settled_amount
        ) order by profile.full_name
      ),
      '[]'::jsonb
    )
  into
    expected_count,
    settled_count,
    blocked_count,
    missing_count,
    open_count,
    waiting_credit_count,
    review_count,
    competence_billed,
    competence_settled,
    obligation_states
  from public.monthly_payment_obligations as obligation
  join public.profiles as profile on profile.id = obligation.student_id
  where obligation.tenant_id = normalized_tenant
    and obligation.period_start = v_period_start;

  select count(*)::integer
    into unclassified_count
    from public.student_payments as payment
   where payment.tenant_id = normalized_tenant
     and payment.student_id is null
     and payment.status in ('RECEIVED', 'RECEIVED_IN_CASH')
     and coalesce(payment.value, 0) > 0
     and payment.exclusion_reason is null
     and coalesce(
       payment.credited_at,
       payment.paid_at,
       payment.payment_date::timestamptz,
       payment.due_date::timestamptz
     ) >= v_period_start::timestamptz
     and coalesce(
       payment.credited_at,
       payment.paid_at,
       payment.payment_date::timestamptz,
       payment.due_date::timestamptz
     ) < v_period_end::timestamptz;

  select count(*)::integer
    into reconciliation_count
    from public.asaas_reconciliation_issues as issue
   where issue.tenant_id = normalized_tenant
     and issue.resolved_at is null
     and issue.severity in ('HIGH', 'CRITICAL')
     and (
       issue.local_entity_id in (
         select unnest(obligation.payment_ids)::text
           from public.monthly_payment_obligations as obligation
          where obligation.tenant_id = normalized_tenant
            and obligation.period_start = v_period_start
       )
       or issue.provider_entity_id in (
         select payment.asaas_payment_id
           from public.monthly_payment_obligations as obligation
           join public.student_payments as payment
             on payment.id = any(obligation.payment_ids)
          where obligation.tenant_id = normalized_tenant
            and obligation.period_start = v_period_start
       )
     );

  cash_report := public.payment_split_report(
    pg_catalog.to_char(v_period_start, 'YYYY-MM'),
    normalized_tenant
  );
  cash_totals := coalesce(cash_report -> 'totais', '{}'::jsonb);

  select jsonb_build_object(
           'direction', jsonb_build_object(
             'tithe_pct', setting.dizimo_pct,
             'investment_pct', setting.investimento_pct,
             'school_pct', setting.escola_pct
           ),
           'contracted_teacher', jsonb_build_object(
             'tithe_pct', setting.prof_dizimo_pct,
             'investment_pct', setting.prof_investimento_pct,
             'prolabore_pct', setting.prof_prolabore_pct
           ),
           'is_active', setting.is_active
         )
    into rules_snapshot
    from public.payment_split_settings as setting
   where setting.tenant_id = normalized_tenant;
  rules_snapshot := coalesce(rules_snapshot, '{}'::jsonb);

  select setting.destino
    into destination
    from public.dre_report_settings as setting
   where setting.tenant_id = normalized_tenant
     and setting.is_active;

  if business_today < v_period_end then
    blockers := blockers || jsonb_build_array('period_not_ended');
  end if;
  if expected_count = 0 then
    blockers := blockers || jsonb_build_array('no_expected_students');
  end if;
  if missing_count > 0 then
    blockers := blockers || jsonb_build_array('students_without_invoice');
  end if;
  if open_count > 0 then
    blockers := blockers || jsonb_build_array('open_invoices');
  end if;
  if waiting_credit_count > 0 then
    blockers := blockers || jsonb_build_array('card_confirmed_waiting_cash');
  end if;
  if review_count > 0 then
    blockers := blockers || jsonb_build_array('obligations_under_review');
  end if;
  if unclassified_count > 0 then
    blockers := blockers || jsonb_build_array('unclassified_cash');
  end if;
  if reconciliation_count > 0 then
    blockers := blockers || jsonb_build_array('open_reconciliation');
  end if;
  if destination is null then
    blockers := blockers || jsonb_build_array('management_group_inactive');
  end if;
  if coalesce((rules_snapshot ->> 'is_active')::boolean, false) is false then
    blockers := blockers || jsonb_build_array('payment_split_inactive');
  end if;

  next_status := case
    when jsonb_array_length(blockers) = 0 then 'READY'
    when business_today < v_period_end then 'OPEN'
    else 'BLOCKED'
  end;

  next_snapshot := jsonb_build_object(
    'tenant_id', normalized_tenant,
    'period_start', v_period_start,
    'period_end', v_period_end - 1,
    'timezone', 'America/Sao_Paulo',
    'status', next_status,
    'blockers', blockers,
    'roster', jsonb_build_object(
      'expected_students', expected_count,
      'settled_students', settled_count,
      'blocked_students', blocked_count,
      'missing_invoice_students', missing_count,
      'open_students', open_count,
      'waiting_credit_students', waiting_credit_count,
      'review_students', review_count,
      'items', obligation_states
    ),
    'competence', jsonb_build_object(
      'billed', competence_billed,
      'settled', competence_settled
    ),
    'cash', cash_totals,
    'rules', rules_snapshot,
    'unclassified_cash_count', unclassified_count,
    'open_reconciliation_count', reconciliation_count,
    'calculated_at', pg_catalog.now()
  );
  next_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to((next_snapshot - 'calculated_at')::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  select closure.*
    into closure_row
    from public.monthly_payment_closures as closure
   where closure.tenant_id = normalized_tenant
     and closure.period_start = v_period_start
   for update;

  if closure_row.sent_at is not null then
    if closure_row.snapshot_hash is distinct from next_hash then
      update public.monthly_payment_closures as target
         set status = 'REVIEW',
             review_reason = 'source_changed_after_monthly_close',
             updated_at = pg_catalog.now()
       where target.tenant_id = normalized_tenant
         and target.period_start = v_period_start;
    end if;
    return jsonb_build_object(
      'ok', true,
      'tenant_id', normalized_tenant,
      'period_start', v_period_start,
      'status', case when closure_row.snapshot_hash is distinct from next_hash
                     then 'REVIEW' else closure_row.status end,
      'already_sent', true,
      'snapshot', closure_row.snapshot
    );
  end if;

  -- A rejeição ou um timeout ambíguo do POST é terminal para esta competência:
  -- nunca tentamos um segundo envio irreversível. Preserve REVIEW nos sweeps
  -- seguintes até que um gestor faça a conciliação manual.
  if closure_row.status = 'REVIEW'
     and closure_row.review_reason in (
       'monthly_message_failed',
       'monthly_message_unknown',
       'monthly_message_suppressed'
     )
  then
    return jsonb_build_object(
      'ok', true,
      'tenant_id', normalized_tenant,
      'period_start', v_period_start,
      'status', 'REVIEW',
      'ready', false,
      'delivery_review', true,
      'review_reason', closure_row.review_reason,
      'snapshot', closure_row.snapshot
    );
  end if;

  update public.monthly_payment_closures as target
     set status = next_status,
         expected_students = expected_count,
         settled_students = settled_count,
         blocked_students = blocked_count,
         unclassified_cash_count = unclassified_count,
         open_reconciliation_count = reconciliation_count,
         snapshot = next_snapshot,
         snapshot_hash = next_hash,
         group_destination_snapshot = case
           when next_status = 'READY' then destination
           else null
         end,
         ready_at = case
           when next_status = 'READY' then coalesce(ready_at, pg_catalog.now())
           else null
         end,
         review_reason = null,
         updated_at = pg_catalog.now()
   where target.tenant_id = normalized_tenant
     and target.period_start = v_period_start;

  return jsonb_build_object(
    'ok', true,
    'tenant_id', normalized_tenant,
    'period_start', v_period_start,
    'status', next_status,
    'ready', next_status = 'READY',
    'snapshot_hash', next_hash,
    'snapshot', next_snapshot
  );
end;
$function$;

alter function public.refresh_monthly_payment_closure(text, date) owner to postgres;
revoke all on function public.refresh_monthly_payment_closure(text, date)
  from public, anon, authenticated;
grant execute on function public.refresh_monthly_payment_closure(text, date) to service_role;

create or replace function public.alunos_sem_assinatura(p_tenant text default null::text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE v_jwt text; v_role text; v_tenant text;
BEGIN
  -- Claim vazia ('' fica na sessão depois de um SET LOCAL) não pode derrubar
  -- a leitura com erro de JSON: vale como "sem claim".
  v_jwt := COALESCE(nullif(btrim(current_setting('request.jwt.claims', true)), '')::json->>'role', '');
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt IN ('anon','authenticated') THEN
    IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
    IF v_role = 'SUPER_ADMIN' THEN v_tenant := COALESCE(p_tenant, v_tenant); END IF;
  ELSE
    v_tenant := COALESCE(p_tenant, v_tenant);
  END IF;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('error','escola_nao_identificada'); END IF;

  RETURN (
    WITH candidatos AS (
      SELECT p.id, trim(p.full_name) AS nome, p.monthly_fee AS mensalidade,
             p.created_at::date AS matriculado,
             -- Só conta quem REALMENTE estuda: a base tem conta de teste, e
             -- alarmar por elas ensina o diretor a ignorar o alerta.
             (SELECT count(*) FROM v_payable_class_logs v
               WHERE v.student_id = p.id
                 AND v.class_date >= (current_date - 60))::int AS aulas_60d,
             (SELECT max(v.class_date) FROM v_payable_class_logs v WHERE v.student_id = p.id) AS ultima_aula,
             (SELECT count(*) FROM student_payments sp WHERE sp.student_id = p.id)::int AS cobrancas_na_vida
        FROM profiles p
       WHERE p.tenant_id = v_tenant AND p.role = 'STUDENT'
         AND COALESCE(p.monthly_fee,0) > 0
         AND COALESCE(p.subscription_id,'') = ''
         AND is_student_notifiable(p.id)
         -- cobertura: quem pagou este mês num pagamento completo não precisa
         -- de assinatura para estar em dia.
         AND NOT private.student_month_covered(
               p.id, (now() AT TIME ZONE 'America/Sao_Paulo')::date)
    ), reais AS (
      SELECT * FROM candidatos WHERE aulas_60d > 0
    )
    SELECT jsonb_build_object(
      'alunos', (SELECT count(*)::int FROM reais),
      'mensalidade_mensal_em_risco', (SELECT round(COALESCE(sum(mensalidade),0),2) FROM reais),
      'nunca_cobrados', (SELECT count(*)::int FROM reais WHERE cobrancas_na_vida = 0),
      'detalhe', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'aluno', nome, 'mensalidade', mensalidade, 'matriculado', matriculado,
          'aulas_ultimos_60d', aulas_60d, 'ultima_aula', ultima_aula,
          'cobrancas_na_vida', cobrancas_na_vida)
          ORDER BY cobrancas_na_vida, mensalidade DESC) FROM reais), '[]'::jsonb)
    )
  );
END;
$function$;

-- Era de supabase_admin (superusuário): SECURITY DEFINER roda com os poderes do dono.
alter function public.alunos_sem_assinatura(text) owner to postgres;
revoke all on function public.alunos_sem_assinatura(text) from public, anon;
grant execute on function public.alunos_sem_assinatura(text) to authenticated, service_role;

create or replace function public.financial_reconciliation(p_tenant text default null::text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
  -- Claim vazia vale como "sem claim" (mesma guarda de payment_split_report).
  v_jwt := coalesce(nullif(btrim(current_setting('request.jwt.claims', true)), '')::json->>'role', '');
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
  --
  -- cobertura: pagamento completo recebido FORA do Asaas conta como recebido,
  -- e aluno com o mês corrente coberto por pagamento completo não aparece.
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
          coalesce((select sum(greatest(round(coalesce(sp.value, 0) - coalesce(sp.refunded_amount, 0), 2), 0)) from public.student_payments sp
                     where sp.student_id = p.id
                       and sp.status in ('RECEIVED', 'RECEIVED_IN_CASH')), 0)
          + coalesce((select sum(a.valor) from public.student_payment_allocations a
                       where a.student_id = p.id
                         and a.status = 'ACTIVE'
                         and a.origem = 'EXTERNO'), 0) as recebido,
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
       and not private.student_month_covered(p.id, current_date)
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
$function$;

alter function public.financial_reconciliation(text) owner to postgres;
revoke all on function public.financial_reconciliation(text) from public, anon;
grant execute on function public.financial_reconciliation(text) to authenticated, service_role;

create or replace function public.gestao_financial_context(p_tenant text, p_month text default null::text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant, '')), '');
  normalized_month text := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_month, '')), ''),
    pg_catalog.to_char(
      pg_catalog.now() at time zone 'America/Sao_Paulo',
      'YYYY-MM'
    )
  );
  month_start date;
  month_end date;
  receivables numeric := 0;
  delinquency jsonb := '{}'::jsonb;
  monthly_closures jsonb := '{}'::jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if normalized_tenant is null
     or not exists (
       select 1 from public.tenants as tenant
        where tenant.id = normalized_tenant
     )
     or normalized_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_management_financial_context_scope';
  end if;

  month_start := pg_catalog.to_date(normalized_month || '-01', 'YYYY-MM-DD');
  month_end := (month_start + interval '1 month')::date;
  if pg_catalog.to_char(month_start, 'YYYY-MM') <> normalized_month then
    raise exception using
      errcode = '22023',
      message = 'invalid_management_financial_context_scope';
  end if;

  -- These predicates deliberately mirror get_cashflow_unchecked(text). The
  -- only difference is that the trusted tenant is explicit instead of inferred
  -- from auth.uid(), which is null for a service_role Edge Function.
  -- cobertura: cobrança de mês já pago por pagamento completo não é
  -- inadimplência nem conta a receber — é cobrança em dobro a cancelar.
  select pg_catalog.jsonb_build_object(
           'total', pg_catalog.round(coalesce(sum(payment.value), 0), 2),
           'd1_30', pg_catalog.round(coalesce(sum(payment.value) filter (
             where current_date - payment.due_date between 1 and 30
           ), 0), 2),
           'd31_60', pg_catalog.round(coalesce(sum(payment.value) filter (
             where current_date - payment.due_date between 31 and 60
           ), 0), 2),
           'd60plus', pg_catalog.round(coalesce(sum(payment.value) filter (
             where current_date - payment.due_date > 60
           ), 0), 2),
           'count', count(*)::integer
         )
    into delinquency
    from public.student_payments as payment
   where payment.tenant_id = normalized_tenant
     and payment.status in ('OVERDUE', 'DUNNING_REQUESTED')
     and not private.student_month_covered(payment.student_id, payment.due_date);

  select pg_catalog.round(coalesce(sum(payment.value), 0), 2)
    into receivables
    from public.student_payments as payment
   where payment.tenant_id = normalized_tenant
     and payment.status = 'PENDING'
     and payment.due_date >= month_start
     and payment.due_date < month_end
     and not private.student_month_covered(payment.student_id, payment.due_date);

  with requested_periods(label, period_start) as (
    values
      ('mes_consultado'::text, month_start),
      ('mes_anterior'::text, (month_start - interval '1 month')::date)
  )
  select coalesce(
           pg_catalog.jsonb_object_agg(
             period.label,
             case
               when closure.tenant_id is null then
                 pg_catalog.jsonb_build_object(
                   'mes', pg_catalog.to_char(period.period_start, 'YYYY-MM'),
                   'status', 'NOT_CALCULATED'
                 )
               else
                 pg_catalog.jsonb_build_object(
                   'mes', pg_catalog.to_char(period.period_start, 'YYYY-MM'),
                   'status', closure.status,
                   'atualizado_em', closure.updated_at,
                   'enviado_em', closure.sent_at,
                   'motivo_revisao', closure.review_reason,
                   'motivos_de_bloqueio', coalesce(
                     closure.snapshot -> 'blockers',
                     '[]'::jsonb
                   ),
                   'alunos', (
                     coalesce(closure.snapshot -> 'roster', '{}'::jsonb)
                       - 'items'
                   ) || pg_catalog.jsonb_build_object(
                     'pendentes', coalesce(
                       (
                         select pg_catalog.jsonb_agg(
                                  item.value order by item.value ->> 'student_name'
                                )
                           from pg_catalog.jsonb_array_elements(
                             coalesce(
                               closure.snapshot #> '{roster,items}',
                               '[]'::jsonb
                             )
                           ) as item(value)
                          where coalesce(item.value ->> 'status', '')
                                not in ('SETTLED', 'EXCLUDED')
                       ),
                       '[]'::jsonb
                     )
                   ),
                   'competencia', coalesce(
                     closure.snapshot -> 'competence',
                     '{}'::jsonb
                   ),
                   'caixa', coalesce(
                     closure.snapshot -> 'cash',
                     '{}'::jsonb
                   ),
                   'regras_rateio', coalesce(
                     closure.snapshot -> 'rules',
                     '{}'::jsonb
                   ),
                   'recebimentos_sem_aluno', coalesce(
                     (closure.snapshot ->> 'unclassified_cash_count')::integer,
                     0
                   ),
                   'conciliacoes_em_aberto', coalesce(
                     (closure.snapshot ->> 'open_reconciliation_count')::integer,
                     0
                   )
                 )
             end
           ),
           '{}'::jsonb
         )
    into monthly_closures
    from requested_periods as period
    left join public.monthly_payment_closures as closure
      on closure.tenant_id = normalized_tenant
     and closure.period_start = period.period_start;

  return pg_catalog.jsonb_build_object(
    'tenant_id', normalized_tenant,
    'mes', normalized_month,
    'inadimplencia', delinquency,
    'a_receber_no_mes', receivables,
    'fechamento_mensal', monthly_closures
  );
end;
$function$;

alter function public.gestao_financial_context(text, text) owner to postgres;
revoke all on function public.gestao_financial_context(text, text) from public, anon, authenticated;
grant execute on function public.gestao_financial_context(text, text) to service_role;

-- Cobrança (notify-payment-due) e suspensão diária: cobrança de mês coberto
-- por pagamento completo não é atraso. Cópia de 20260914020000 + um ramo.
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
           -- cobertura: o mês desta cobrança já foi pago num pagamento completo.
           when private.student_month_covered(payment.student_id, payment.due_date)
             then 'mes_coberto_por_pagamento_completo'
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

-- Fluxo de Caixa (painel do diretor): inadimplência e "a receber". O
-- gestao_financial_context espelha estes predicados de propósito; se só um dos
-- dois soubesse da cobertura, o painel e o assistente da gestão dariam números
-- diferentes para a mesma inadimplência. Cópia da definição viva + a cobertura.
create or replace function public.get_cashflow_unchecked(p_month text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_tenant text;
  v_month text;
  v_month_start date;
  v_month_end date;
  v_in numeric;
  v_teacher numeric;
  v_vendor numeric;
  v_referral numeric;
  v_expense numeric;
begin
  select p.tenant_id
    into v_tenant
    from public.profiles p
   where p.id = auth.uid();

  v_month := coalesce(p_month, to_char(current_date, 'YYYY-MM'));
  if v_month !~ '^\d{4}-\d{2}$' then
    raise exception 'Mes invalido (use YYYY-MM)';
  end if;
  v_month_start := to_date(v_month || '-01', 'YYYY-MM-DD');
  if to_char(v_month_start, 'YYYY-MM') <> v_month then
    raise exception 'Mes invalido (use YYYY-MM)';
  end if;
  v_month_end := (v_month_start + interval '1 month')::date;

  select coalesce(sum(ft.amount), 0)
    into v_in
    from public.financial_transactions ft
   where ft.tenant_id = v_tenant
     and ft.type = 'ENTRADA'
     and ft.category is distinct from 'aporte_ou_movimentacao'
     and ft.occurred_at >= v_month_start
     and ft.occurred_at < v_month_end;

  select coalesce(sum(tc.total_amount), 0)
    into v_teacher
    from public.teacher_closings tc
   where tc.tenant_id = v_tenant
     and tc.status = 'PAGO'
     and coalesce(tc.paid_at, (tc.month_year || '-01')::date) >= v_month_start
     and coalesce(tc.paid_at, (tc.month_year || '-01')::date) < v_month_end;

  select coalesce(sum(vc.amount_brl), 0)
    into v_vendor
    from public.vendor_commissions vc
   where vc.tenant_id = v_tenant
     and vc.status = 'PAID'
     and vc.paid_at >= v_month_start
     and vc.paid_at < v_month_end;

  select coalesce(sum(rr.amount_brl), 0)
    into v_referral
    from public.referral_rewards rr
   where rr.tenant_id = v_tenant
     and rr.status = 'PAID'
     and rr.paid_at >= v_month_start
     and rr.paid_at < v_month_end;

  select coalesce(sum(ft.amount), 0)
    into v_expense
    from public.financial_transactions ft
   where ft.tenant_id = v_tenant
     and ft.type = 'SAIDA'
     and ft.category is distinct from 'teacher_payout'
     and ft.category is distinct from 'estorno_aporte_ou_movimentacao'
     and ft.account_code is distinct from '5.1.01'
     and ft.occurred_at >= v_month_start
     and ft.occurred_at < v_month_end;

  return jsonb_build_object(
    'month', v_month,
    'entradas', v_in,
    'saidas', jsonb_build_object(
      'professores', v_teacher,
      'vendedores', v_vendor,
      'indicacoes', v_referral,
      'despesas', v_expense,
      'total', v_teacher + v_vendor + v_referral + v_expense
    ),
    'saldo', v_in - (v_teacher + v_vendor + v_referral + v_expense),
    -- Valores ainda devidos permanecem brutos: estorno de dinheiro ja
    -- realizado nao reduz o principal de outra fatura em aberto.
    'inadimplencia', (
      select jsonb_build_object(
        'total', coalesce(sum(sp.value), 0),
        'd1_30', coalesce(sum(sp.value) filter (
          where current_date - sp.due_date between 1 and 30
        ), 0),
        'd31_60', coalesce(sum(sp.value) filter (
          where current_date - sp.due_date between 31 and 60
        ), 0),
        'd60plus', coalesce(sum(sp.value) filter (
          where current_date - sp.due_date > 60
        ), 0),
        'count', count(*)
      )
      from public.student_payments sp
      where sp.tenant_id = v_tenant
        and sp.status in ('OVERDUE', 'DUNNING_REQUESTED')
        -- cobertura: cobrança de mês já pago num pagamento completo é
        -- cobrança em dobro a cancelar, não inadimplência.
        and not private.student_month_covered(sp.student_id, sp.due_date)
    ),
    'a_receber', (
      select coalesce(sum(sp.value), 0)
        from public.student_payments sp
       where sp.tenant_id = v_tenant
         and sp.status = 'PENDING'
         and sp.due_date >= v_month_start
         and sp.due_date < v_month_end
         -- cobertura: mês coberto não é dinheiro a receber.
         and not private.student_month_covered(sp.student_id, sp.due_date)
    ),
    'serie', (
      select jsonb_agg(
        jsonb_build_object('mes', series.month_year, 'entradas', series.amount)
        order by series.month_year
      )
      from (
        select
          to_char(months.month_start, 'YYYY-MM') as month_year,
          coalesce((
            select sum(ft.amount)
              from public.financial_transactions ft
             where ft.tenant_id = v_tenant
               and ft.type = 'ENTRADA'
               and ft.category is distinct from 'aporte_ou_movimentacao'
               and ft.occurred_at >= months.month_start
               and ft.occurred_at < months.month_start + interval '1 month'
          ), 0) as amount
        from generate_series(
          date_trunc('month', current_date) - interval '5 months',
          date_trunc('month', current_date),
          interval '1 month'
        ) as months(month_start)
      ) series
    )
  );
end;
$function$;

alter function public.get_cashflow_unchecked(text) owner to postgres;
revoke all on function public.get_cashflow_unchecked(text)
  from public, anon, authenticated, service_role;

-- Resumo semanal do diretor (WhatsApp de segunda): mesma regra para "vencidas".
-- Cópia da definição viva + a cobertura.
create or replace function public.weekly_digest_rows()
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tenant_id', t.id, 'school', t.name,
    'director_phone', (SELECT phone FROM profiles WHERE tenant_id=t.id AND role='SCHOOL_ADMIN' AND phone IS NOT NULL AND phone<>'' LIMIT 1),
    'active_students', (SELECT count(DISTINCT student_id) FROM bookings WHERE tenant_id=t.id),
    'classes_week', (SELECT count(*) FROM class_logs WHERE tenant_id=t.id AND class_date >= current_date-7),
    -- cobertura: boleto de mês já pago num pagamento completo não é "vencida".
    'overdue_count', (SELECT count(*) FROM student_payments sp
                       WHERE sp.tenant_id=t.id AND sp.status='OVERDUE'
                         AND NOT private.student_month_covered(sp.student_id, sp.due_date)),
    'overdue_amount', (SELECT COALESCE(sum(sp.value),0) FROM student_payments sp
                        WHERE sp.tenant_id=t.id AND sp.status='OVERDUE'
                          AND NOT private.student_month_covered(sp.student_id, sp.due_date)),
    'received_week', (SELECT COALESCE(sum(value),0) FROM student_payments WHERE tenant_id=t.id AND status IN ('RECEIVED','RECEIVED_IN_CASH') AND COALESCE(paid_at,payment_date,due_date) >= current_date-7)
  )), '[]'::jsonb)
  FROM tenants t WHERE t.id <> 'master';
$function$;

alter function public.weekly_digest_rows() owner to postgres;
revoke all on function public.weekly_digest_rows() from public, anon, authenticated;
grant execute on function public.weekly_digest_rows() to service_role;

-------------------------------------------------------------------------------
-- 10. Conferência das permissões
-------------------------------------------------------------------------------
do $postcheck$
begin
  if pg_catalog.has_table_privilege('authenticated', 'public.student_payment_allocations', 'INSERT')
     or pg_catalog.has_table_privilege('authenticated', 'public.student_payment_allocations', 'UPDATE')
     or pg_catalog.has_table_privilege('authenticated', 'public.student_payment_allocations', 'DELETE')
     or pg_catalog.has_table_privilege('anon', 'public.student_payment_allocations', 'SELECT')
     or not pg_catalog.has_table_privilege('authenticated', 'public.student_payment_allocations', 'SELECT')
     or pg_catalog.has_function_privilege('authenticated', 'private.payment_split_breakdown_unchecked(uuid)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'private.caixinha_fechamento_unchecked(text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.register_prepayment(uuid,date,integer,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.caixinha_fechamento(text,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.register_prepayment(uuid,date,integer,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.payment_split_installment(uuid)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.caixinha_fechamento(text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.refresh_monthly_payment_closure(text,date)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.get_cashflow_unchecked(text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.weekly_digest_rows()', 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.weekly_digest_rows()', 'EXECUTE')
  then
    raise exception 'financeiro por competência não foi instalado com as permissões certas';
  end if;
end;
$postcheck$;
