-- Conciliação do caixa Asaas — uma resposta só para "quanto entrou".
--
-- O PROBLEMA (medido em 24/08/2026 contra a VPS):
-- Duas telas somavam receita de fontes diferentes e divergiam TODO mês.
-- Julho: painel de Fluxo de Caixa e DRE diziam R$ 6.840,69; Dashboard do
-- diretor e Relatório Financeiro diziam R$ 9.075,59. A soma do ano quase
-- fechava (−R$ 507,20) porque os erros se cancelavam — o que engana, porque
-- é o mês que se usa para decidir.
--
-- CAUSA RAIZ: `student_payments.paid_at` estava NULL em 186 de 186 pagamentos
-- pagos. O webhook grava `payment_date` e nunca `paid_at`, e o trigger do
-- caixa usava `occurred_at = coalesce(NEW.paid_at, now())` — ou seja, SEMPRE
-- `now()`, a data em que o webhook chegou. Batia por sorte (152 de 166
-- lançamentos no mesmo dia), mas 5 já tinham caído em mês diferente.
--
-- ⚠️ Esta migration NÃO depende de mudança em edge function. O preenchimento
-- de `paid_at` virou trigger de banco, então vale para QUALQUER escritor
-- (webhook, RPC, painel, carga manual) sem precisar editar código de fora.
--
-- ⚠️ Re-executável: o release aplica a lista inteira a cada deploy. Nada de
-- begin/commit aqui, e todo UPDATE de dado é idempotente por predicado ou
-- guardado por `schema_one_shots`.

-- ---------------------------------------------------------------------------
-- 1. `paid_at` deixa de depender de quem escreve
-- ---------------------------------------------------------------------------
create or replace function public.set_student_payment_paid_at()
returns trigger
language plpgsql
as $fn$
begin
  if new.paid_at is null
     and new.payment_date is not null
     and new.status in ('RECEIVED','RECEIVED_IN_CASH','CONFIRMED','PAGO',
                        'PAYMENT_RECEIVED','PAYMENT_CONFIRMED')
  then
    -- MEIO-DIA, não meia-noite. O banco roda em UTC (medido: `show timezone`
    -- = UTC) e a escola raciocina em BRT. Meia-noite UTC é 21:00 do dia
    -- anterior em Brasília: um pagamento do dia 1º cairia no mês anterior em
    -- qualquer `to_char` com fuso local. Meio-dia é inequívoco nos dois.
    new.paid_at := new.payment_date + interval '12 hours';
  end if;
  return new;
end;
$fn$;

alter function public.set_student_payment_paid_at() owner to postgres;

drop trigger if exists trg_student_payment_paid_at on public.student_payments;
create trigger trg_student_payment_paid_at
  before insert or update on public.student_payments
  for each row execute function public.set_student_payment_paid_at();

-- Backfill. Idempotente por predicado (`paid_at is null`) de propósito: não é
-- one-shot porque `student_payments.paid_at` não é editável por nenhuma tela —
-- conferido, o único `paid_at` escrito pelo app é o de `teacher_closings`
-- (components/FinancialReport.tsx). Repetir só conserta linha nova que
-- porventura escape.
--
-- Este UPDATE é seguro apesar dos 5 triggers da tabela: `notify_payment_split`
-- (que dispara WhatsApp), `confirm_vendor_commission_on_payment`,
-- `grant_referral_reward_on_payment` e `ledger_on_payment_received` são todos
-- guardados por `OLD.status IS DISTINCT FROM NEW.status`, e o status não muda
-- aqui. Só `audit_table_trigger` roda — que é o comportamento desejado.
update public.student_payments
   set paid_at = payment_date + interval '12 hours'
 where paid_at is null
   and payment_date is not null
   and status in ('RECEIVED','RECEIVED_IN_CASH','CONFIRMED','PAGO',
                  'PAYMENT_RECEIVED','PAYMENT_CONFIRMED');

-- ---------------------------------------------------------------------------
-- 2. O lançamento no caixa passa a usar a data do PAGAMENTO
-- ---------------------------------------------------------------------------
create or replace function public.ledger_on_payment_received()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- Conjunto de status ALINHADO com get_cashflow e dre_gerencial.
  --
  -- ⚠️ CONFIRMED saiu. Na Asaas é pagamento reconhecido e ainda NÃO liquidado;
  -- o painel de caixa nunca o contou, e o ledger contava — era uma das quatro
  -- parcelas da divergência (2 pagamentos, R$ 525,00). Cartão confirmado vira
  -- RECEIVED na liquidação e o lançamento nasce ali: medido, 2 dos 4 cartões
  -- da base já fizeram essa transição. Os 2 lançamentos de CONFIRMED que já
  -- existem NÃO são apagados — quando os pagamentos virarem RECEIVED, a guarda
  -- de existência abaixo impede a duplicata.
  --
  -- ⚠️ Vale vigiar pagamento parado em CONFIRMED por muito tempo, que agora
  -- não entra no caixa até liquidar:
  --   select id, value, payment_date from student_payments
  --    where status = 'CONFIRMED' and payment_date < current_date - 45;
  if new.status in ('RECEIVED','RECEIVED_IN_CASH')
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and coalesce(new.value, 0) > 0
     -- Pagamento sem tenant não vira receita de ninguém em silêncio.
     and new.tenant_id is not null
  then
    if not exists (
      select 1 from financial_transactions where student_payment_id = new.id
    ) then
      insert into financial_transactions
        (tenant_id, type, category, amount, amount_cents, student_payment_id,
         reference_id, occurred_at, description, created_at)
      values
        (new.tenant_id, 'ENTRADA', 'MENSALIDADE', new.value,
         round(coalesce(new.value, 0) * 100), new.id, new.student_id,
         -- Era `coalesce(new.paid_at, now())` com paid_at sempre nulo.
         -- A cadeia abaixo é a MESMA de get_cashflow e dre_gerencial
         -- (`coalesce(paid_at, payment_date, due_date)`): sem isso, pagamento
         -- antigo sem payment_date — existem 5 — continuaria caindo no mês em
         -- que o webhook chegou. `now()` fica só como última rede.
         coalesce(new.paid_at,
                  new.payment_date + interval '12 hours',
                  new.due_date + interval '12 hours',
                  now()),
         'Mensalidade (conciliação automática)', now());
    end if;
  end if;
  return new;
end;
$fn$;

alter function public.ledger_on_payment_received() owner to postgres;

-- ---------------------------------------------------------------------------
-- 3. `amount` e `amount_cents` param de divergir
-- ---------------------------------------------------------------------------
-- 5 linhas tinham `amount_cents` nulo, e por isso a soma em reais e a soma em
-- centavos da categoria MENSALIDADE divergiam em R$ 1.139,90. As telas leem
-- `amount` com reserva em `amount_cents`, então acertavam — qualquer relatório
-- novo que lesse só centavos sub-reportaria.
--
-- O trigger é BEFORE: no Postgres a checagem de NOT NULL roda DEPOIS dos
-- triggers BEFORE, então ele também conserta quem insere só um dos dois lados.
-- É o caso do `reconcile-ledger`, que inseria `amount_cents` sem `amount` e
-- morria em `null value in column "amount" violates not-null constraint`.
create or replace function public.sync_financial_transaction_amounts()
returns trigger
language plpgsql
as $fn$
begin
  if new.amount_cents is null and new.amount is not null then
    new.amount_cents := round(new.amount * 100);
  elsif new.amount is null and new.amount_cents is not null then
    new.amount := new.amount_cents / 100.0;
  end if;
  return new;
end;
$fn$;

alter function public.sync_financial_transaction_amounts() owner to postgres;

drop trigger if exists trg_sync_financial_amounts on public.financial_transactions;
create trigger trg_sync_financial_amounts
  before insert or update on public.financial_transactions
  for each row execute function public.sync_financial_transaction_amounts();

update public.financial_transactions
   set amount_cents = round(amount * 100)
 where amount_cents is null
   and amount is not null;

alter table public.financial_transactions
  alter column amount_cents set not null;

-- ---------------------------------------------------------------------------
-- 4. Reparo dos lançamentos que caíram no mês errado — ONE-SHOT
-- ---------------------------------------------------------------------------
-- Aqui o UPDATE reescreve histórico, então NÃO pode ser repetível: se alguém
-- corrigir uma data na mão, o próximo release desfaria a correção e ninguém
-- ligaria uma coisa à outra. Mesmo padrão do `rateio_por_origem_20260813`.
--
-- Roda depois do backfill do item 1 de propósito — sem `paid_at` preenchido
-- não haveria com o que comparar.
do $one_shot$
begin
  if not exists (
    select 1 from public.schema_one_shots
     where key = 'caixa_occurred_at_20260824'
  ) then
    update public.financial_transactions ft
       set occurred_at = coalesce(sp.paid_at,
                                  sp.payment_date + interval '12 hours',
                                  sp.due_date + interval '12 hours')
      from public.student_payments sp
     where sp.id = ft.student_payment_id
       and ft.type = 'ENTRADA'
       and coalesce(sp.paid_at,
                    sp.payment_date + interval '12 hours',
                    sp.due_date + interval '12 hours') is not null
       and date_trunc('month', ft.occurred_at)
           is distinct from date_trunc('month',
                                       coalesce(sp.paid_at,
                                                sp.payment_date + interval '12 hours',
                                                sp.due_date + interval '12 hours'));

    insert into public.schema_one_shots (key, nota)
    values ('caixa_occurred_at_20260824',
            'lançamentos cujo occurred_at caiu em mês diferente do pagamento — o trigger usava now()');
  end if;
end
$one_shot$;

-- ---------------------------------------------------------------------------
-- 5. A guarda de permissão que não disparava
-- ---------------------------------------------------------------------------
-- Em SQL, `NULL NOT IN ('A','B')` não é verdadeiro nem falso: é NULL. E
-- `IF NULL THEN` não executa. Quem não tem perfil ATRAVESSA a guarda em vez de
-- ser barrado. Provado chamando sem login nenhum: `director_pending_counts()`,
-- `get_referral_settings()` e `list_vendors_overview()` executaram para o anon
-- e devolveram o objeto do painel em vez de `sem_permissao`.
--
-- Hoje não vaza dado, porque tudo lá dentro é escopado por `_my_tenant_id()`,
-- que é nulo para o anônimo — as respostas voltam zeradas. O risco é a próxima
-- função escrita nesse molde sem o escopo por tenant.
--
-- São 94 funções com o idioma; 21 estavam alcançáveis pelo anon. Reescrever as
-- 94 automaticamente numa migration que roda a cada release seria a espécie de
-- esperteza que quebra produção — o corte aqui é a exposição, mais o conserto
-- à mão das duas que mexem em dinheiro (item 6).
--
-- ⚠️ Revoga de `public` também, não só de `anon`: várias tinham EXECUTE para
-- PUBLIC (`=X/postgres` no ACL), e nesse caso revogar só do anon não faz nada,
-- porque ele herda de PUBLIC.
-- As assinaturas saem do catálogo, não de texto escrito à mão: a migration roda
-- a cada release e não pode quebrar porque alguém renomeou um parâmetro ou
-- criou uma sobrecarga. Só os NOMES ficam na lista, para a revisão ser legível.
do $revoga$
declare
  r record;
  alvos text[] := array[
    'apply_credit_next_pending',
    'assign_class_coverage',
    'create_absence_with_coverage',
    'delete_collection',
    'director_pending_counts',
    'get_referral_settings',
    'get_student_credit_balance',
    'get_vendor_overview',
    'list_pending_trial_sessions',
    'list_referrals_overview',
    'list_vendors_overview',
    'open_reallocation_for_teacher',
    'reassign_student_teacher',
    'save_referral_settings',
    'set_class_log_rate_override',
    'set_material_collection',
    'set_referral_reward_status',
    'set_vendor_commission_status',
    'settle_trial_session',
    'update_material',
    'wolfie_insights'
  ];
begin
  for r in
    select p.oid::regprocedure as assinatura
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(alvos)
  loop
    execute format('revoke execute on function %s from public, anon', r.assinatura);
    execute format('grant execute on function %s to authenticated, service_role', r.assinatura);
  end loop;
end
$revoga$;

-- ---------------------------------------------------------------------------
-- 6. As duas funções de dinheiro que não conheciam tenant
-- ---------------------------------------------------------------------------
-- Eram as duas únicas, entre as 21 expostas, cujo corpo inteiro não continha a
-- palavra `tenant`. Ambas marcam pagamento como PAID por id. Impacto hoje é
-- zero por acaso — `vendor_commissions` e `referral_rewards` estão as duas com
-- 0 linhas. É arma carregada esperando os programas de indicação e de
-- vendedores serem ligados.
--
-- O escopo segue o padrão de `link_payment_to_student` e
-- `set_payment_not_revenue`: tenant do chamador no WHERE, com SUPER_ADMIN
-- passando por cima. ⚠️ Manter o ramo do SUPER_ADMIN é deliberado — ele mora no
-- tenant 'master' e sem isso o suporte da plataforma perderia, em silêncio, a
-- capacidade de corrigir dado de escola cliente.
create or replace function public.set_vendor_commission_status(
  p_commission_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_role text;
  v_tenant text;
  v_afetadas int;
begin
  select role, tenant_id into v_role, v_tenant from profiles where id = auth.uid();
  if coalesce(v_role, '') not in ('SCHOOL_ADMIN','SUPER_ADMIN') then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  if p_status not in ('PENDING','CONFIRMED','PAID','CANCELLED') then
    return jsonb_build_object('ok', false, 'error', 'status_invalido');
  end if;

  update vendor_commissions
     set status = p_status,
         confirmed_at = case when p_status in ('CONFIRMED','PAID')
                             then coalesce(confirmed_at, now()) else confirmed_at end,
         paid_at = case when p_status = 'PAID'
                        then coalesce(paid_at, now()) else paid_at end
   where id = p_commission_id
     and (v_role = 'SUPER_ADMIN' or tenant_id = v_tenant);

  get diagnostics v_afetadas = row_count;
  if v_afetadas = 0 then
    -- Mesma resposta para "não existe" e "não é sua": responder coisas
    -- diferentes contaria a um diretor quais ids existem na outra escola.
    return jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  end if;
  return jsonb_build_object('ok', true);
end;
$fn$;

alter function public.set_vendor_commission_status(uuid, text) owner to postgres;

create or replace function public.set_referral_reward_status(
  p_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_role text;
  v_tenant text;
  v_afetadas int;
begin
  select role, tenant_id into v_role, v_tenant from profiles where id = auth.uid();
  if coalesce(v_role, '') not in ('SCHOOL_ADMIN','SUPER_ADMIN') then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  if p_status not in ('PENDING','PAID','CANCELLED','CREDITED') then
    return jsonb_build_object('ok', false, 'error', 'status_invalido');
  end if;

  update referral_rewards
     set status = p_status,
         paid_at = case when p_status = 'PAID'
                        then coalesce(paid_at, now()) else paid_at end
   where id = p_id
     and (v_role = 'SUPER_ADMIN' or tenant_id = v_tenant);

  get diagnostics v_afetadas = row_count;
  if v_afetadas = 0 then
    return jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  end if;
  return jsonb_build_object('ok', true);
end;
$fn$;

alter function public.set_referral_reward_status(uuid, text) owner to postgres;

comment on function public.set_student_payment_paid_at() is
  'Preenche student_payments.paid_at a partir de payment_date (meio-dia, para não trocar de mês entre UTC e BRT). Existe para que a data do caixa não dependa de qual escritor gravou o pagamento.';
comment on function public.sync_financial_transaction_amounts() is
  'Mantém financial_transactions.amount e amount_cents em sincronia; roda BEFORE, então também salva quem insere só um dos dois lados.';
