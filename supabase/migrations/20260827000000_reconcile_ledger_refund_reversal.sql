-- Reforça o comportamento do trigger de caixa para refletir o contrato de
-- reconciliação:
-- 1) lança ENTRADA quando o pagamento entra como RECEIVED/RECEIVED_IN_CASH
-- 2) remove ENTRADA quando o pagamento sai desses status (estorno, chargeback, etc.)
-- 3) registra rastreabilidade em reconciliation_issues
--
-- Motivo: a migration de 25/08 já estava aplicada no ambiente e o banco da VPS
-- mostrou drift no corpo da função. Como essa função está marcada por versão em
-- release checksums, precisamos de uma nova migration para forçar a reescrita.
--
-- Reexecutável: create or replace function, sem DML de estado persistente.
begin;

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
  v_pago_agora := new.status in ('RECEIVED', 'RECEIVED_IN_CASH');
  v_pago_antes := tg_op = 'UPDATE'
                  and old.status in ('RECEIVED', 'RECEIVED_IN_CASH');

  -- B) Virou pago → lança no caixa (padrão da reconciliação financeira atual)
  if v_pago_agora
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and coalesce(new.value, 0) > 0
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
         coalesce(new.paid_at,
                  new.payment_date + interval '12 hours',
                  new.due_date + interval '12 hours',
                  now()),
         'Mensalidade (conciliação automática)', now());
    end if;

  -- C) Deixou de ser pago → retira o caixa e deixa trilha de auditoria
  elsif v_pago_antes and not v_pago_agora then
    select ft.amount into v_valor
      from financial_transactions ft
     where ft.student_payment_id = new.id
     limit 1;

    delete from financial_transactions where student_payment_id = new.id;
    get diagnostics v_removidos = row_count;

    if v_removidos > 0 then
      insert into reconciliation_issues (tenant_id, kind, student_payment_id, details)
      values (
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

drop trigger if exists trg_ledger_on_payment on public.student_payments;
create trigger trg_ledger_on_payment
after insert or update on public.student_payments
for each row execute function public.ledger_on_payment_received();

commit;
