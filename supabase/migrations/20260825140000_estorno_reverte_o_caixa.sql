-- Estorno tira o dinheiro do caixa. Antes, não tirava.
--
-- O DEFEITO (latente, medido em 25/08/2026): o webhook grava o status cru para
-- PAYMENT_REFUNDED, PAYMENT_DELETED, PAYMENT_CHARGEBACK_REQUESTED e
-- PAYMENT_RECEIVED_IN_CASH_UNDONE no branch genérico, e NÃO mexia no lançamento
-- de caixa já criado. O primeiro estorno da história viraria receita fantasma
-- permanente: o pagamento sai de `RECEIVED` (some do get_cashflow e do DRE) e a
-- ENTRADA continua no `financial_transactions`, que é o que o Dashboard e o
-- Relatório Financeiro somam.
--
-- Nunca aconteceu — não há nenhum pagamento estornado na base (status hoje:
-- RECEIVED 182, PENDING 55, CANCELLED 15, OVERDUE 7, NAO_RECEITA 7,
-- RECEIVED_IN_CASH 4, CONFIRMED 2, DUNNING_REQUESTED 1). Era sorte, não desenho.
--
-- ⚠️ A reversão vive no TRIGGER, não no webhook, pelo mesmo motivo do
-- `paid_at`: vale para QUALQUER escritor (webhook, tela do diretor, RPC, carga
-- manual). Pôr no webhook deixaria de fora todo mundo que muda status por outro
-- caminho — e o `CANCELLED` de hoje (15 pagamentos) prova que outros caminhos
-- existem.
--
-- ⚠️ Re-executável: `create or replace`, sem begin/commit, sem UPDATE de dado.

create or replace function public.ledger_on_payment_received()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_pago_antes boolean;
  v_pago_agora boolean;
  v_removidos int;
  v_valor numeric;
begin
  -- Conjunto ALINHADO com get_cashflow, dre_gerencial e o reconcile-ledger.
  -- CONFIRMED está fora de propósito: na Asaas é pagamento reconhecido e ainda
  -- não liquidado, e o painel de caixa nunca o contou. Cartão confirmado vira
  -- RECEIVED na liquidação e o lançamento nasce ali.
  v_pago_agora := new.status in ('RECEIVED','RECEIVED_IN_CASH');
  v_pago_antes := tg_op = 'UPDATE'
                  and old.status in ('RECEIVED','RECEIVED_IN_CASH');

  -- ------------------------------------------------------------------
  -- A) Virou pago → lança no caixa
  -- ------------------------------------------------------------------
  if v_pago_agora
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
         -- Mesma cadeia de competência de get_cashflow e dre_gerencial.
         coalesce(new.paid_at,
                  new.payment_date + interval '12 hours',
                  new.due_date + interval '12 hours',
                  now()),
         'Mensalidade (conciliação automática)', now());
    end if;

  -- ------------------------------------------------------------------
  -- B) DEIXOU de ser pago → tira do caixa e registra o motivo
  -- ------------------------------------------------------------------
  -- Cobre estorno, chargeback, exclusão da cobrança e "recebido em dinheiro"
  -- desfeito — sem listar evento nenhum: o gatilho é o dinheiro ter deixado de
  -- ser recebido, qualquer que tenha sido o caminho.
  elsif v_pago_antes and not v_pago_agora then
    select ft.amount into v_valor
      from financial_transactions ft
     where ft.student_payment_id = new.id
     limit 1;

    delete from financial_transactions where student_payment_id = new.id;
    get diagnostics v_removidos = row_count;

    if v_removidos > 0 then
      -- O lançamento é APAGADO, não estornado com contrapartida: o índice
      -- `uq_financial_transactions_student_payment` garante uma linha por
      -- pagamento, então se o dinheiro voltar (estorno revertido, pagamento
      -- reprocessado) o ramo (A) recria com a data certa. Manter uma SAIDA de
      -- compensação criaria par ENTRADA+SAIDA que o DRE teria de aprender a
      -- ignorar — e conta alimentada por competência não aceita lançamento do
      -- caixa (ledger_allowed = false).
      --
      -- O rastro fica em `reconciliation_issues`, que é onde o diretor já olha,
      -- e em `profile_audit_log`/auditoria do próprio pagamento.
      insert into reconciliation_issues (tenant_id, kind, student_payment_id, details)
      values (
        -- tenant_id é NOT NULL nesta tabela; pagamento sem escola vira item de
        -- triagem da plataforma.
        coalesce(new.tenant_id, 'master'),
        'PAYMENT_REVERSED',
        new.id,
        jsonb_build_object(
          'status_anterior', old.status,
          'status_novo', new.status,
          'valor_removido_do_caixa', v_valor,
          'removido_em', now()
        )
      );
    end if;
  end if;

  return new;
end;
$fn$;

alter function public.ledger_on_payment_received() owner to postgres;

comment on function public.ledger_on_payment_received() is
  'Mantém financial_transactions em sincronia com o status do pagamento: lança quando vira RECEIVED/RECEIVED_IN_CASH e REMOVE quando deixa de ser (estorno, chargeback, cobrança excluída). Vive no trigger, não no webhook, para valer para qualquer escritor.';
