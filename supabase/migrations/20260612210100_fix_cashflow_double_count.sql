-- Caixa contava mensalidade EM DOBRO.
-- Dois triggers inseriam ENTRADA/MENSALIDADE em financial_transactions para o MESMO
-- pagamento: trg_ledger_on_payment (chave student_payment_id) e trg_sync_financial /
-- handle_financial_sync (chave aluno+valor+mes). Evidencia: 111 pagamentos recebidos
-- -> 121 entradas; as 20 entradas do ledger tinham todas um par duplicado do sync.
-- O ledger vira a fonte UNICA: cobre INSERT (ex.: pagamento em dinheiro ja criado
-- RECEIVED_IN_CASH) + todos os status pagos que o sync cobria.

-- 1) Ledger canonico (idempotente por student_payment_id)
CREATE OR REPLACE FUNCTION public.ledger_on_payment_received()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('RECEIVED','RECEIVED_IN_CASH','CONFIRMED','PAGO','PAYMENT_RECEIVED','PAYMENT_CONFIRMED')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
     AND COALESCE(NEW.value, 0) > 0 THEN
    IF NOT EXISTS (SELECT 1 FROM financial_transactions WHERE student_payment_id = NEW.id) THEN
      INSERT INTO financial_transactions
        (tenant_id, type, category, amount, amount_cents, student_payment_id, reference_id, occurred_at, description, created_at)
      VALUES
        (NEW.tenant_id, 'ENTRADA', 'MENSALIDADE', NEW.value, round(COALESCE(NEW.value,0)*100),
         NEW.id, NEW.student_id, COALESCE(NEW.paid_at, now()), 'Mensalidade (conciliacao automatica)', now());
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_ledger_on_payment ON student_payments;
CREATE TRIGGER trg_ledger_on_payment
AFTER INSERT OR UPDATE ON public.student_payments
FOR EACH ROW EXECUTE FUNCTION ledger_on_payment_received();

-- 2) Remove o caminho legado (unica funcao dele era inserir ENTRADA/MENSALIDADE)
DROP TRIGGER IF EXISTS trg_sync_financial ON student_payments;
DROP FUNCTION IF EXISTS public.handle_financial_sync();

-- 3) Limpa as duplicatas historicas (linhas do sync, sem student_payment_id, com par no ledger)
DELETE FROM financial_transactions b
WHERE b.student_payment_id IS NULL
  AND b.category = 'MENSALIDADE' AND b.type = 'ENTRADA'
  AND EXISTS (
    SELECT 1 FROM financial_transactions a
    JOIN student_payments sp ON sp.id = a.student_payment_id
    WHERE a.category = 'MENSALIDADE' AND a.type = 'ENTRADA'
      AND sp.student_id = b.reference_id
      AND a.amount = b.amount
      AND date_trunc('month', a.created_at) = date_trunc('month', b.created_at)
  );
