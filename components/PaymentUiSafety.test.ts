import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('verdade e segurança da UI financeira', () => {
  it('não oferece baixa direta insegura em tabelas administrativas', () => {
    for (const path of ['components/AdminPaymentsList.tsx', 'components/FinancialReport.tsx']) {
      const source = read(path);
      expect(source).not.toContain("status: 'RECEIVED'");
      expect(source).not.toContain('Confirmar Pagamento Manual');
    }
  });

  it('mostra recebimento pela payment_date e por parser local', () => {
    const report = read('components/FinancialReport.tsx');
    expect(report).toContain('paymentDate: formatLocalDateBr(p.payment_date');
    expect(report).toContain('Recebido {receipt.paymentDate}');
    expect(report).toContain(".gte('occurred_at', startDateStr)");
  });

  it('não esconde pagamentos que ainda aguardam vínculo com um aluno', () => {
    for (const path of ['components/AdminPaymentsList.tsx', 'components/FinancialReport.tsx']) {
      const source = read(path);
      expect(source).not.toContain('profiles!inner');
      expect(source).toContain(".eq('tenant_id', tenantId)");
      expect(source).toContain('Sem aluno vinculado');
    }
  });

  it('expõe a fila atual de divergências do Asaas ao diretor', () => {
    const reconciliation = read('components/FinancialReconciliation.tsx');
    expect(reconciliation).toContain("supabase.rpc('asaas_reconciliation_attention')");
    expect(reconciliation).toContain('Asaas e plataforma precisam de conferência');

    const pendingCenter = read('components/DirectorPendingCenter.tsx');
    expect(pendingCenter).toContain("key: 'pagamentos_sem_aluno'");
    expect(pendingCenter).toContain("key: 'conciliacao_asaas'");
  });

  it('mantém controles e tabelas financeiras utilizáveis em telas estreitas', () => {
    const payments = read('components/AdminPaymentsList.tsx');
    expect(payments).toContain('flex w-full flex-col gap-2 sm:w-auto sm:flex-row');
    expect(payments).toContain('aria-label="Atualizar pagamentos"');

    const report = read('components/FinancialReport.tsx');
    expect(report).toContain('max-h-[400px] overflow-auto');
    expect(report).toContain('Movimentação sem classificação');
  });

  it('mantém o desligamento navegável e legível em 320px', () => {
    const students = read('components/StudentsList.tsx');
    expect(students).toContain("event.key === 'Escape'");
    expect(students).toContain("document.body.style.overflow = 'hidden'");
    expect(students).toContain('ref={offboardingDialogRef}');
    expect(students).toContain('grid grid-cols-1 sm:grid-cols-2 gap-3');
  });

  it('protege os cabeçalhos de matrícula pela safe area', () => {
    const css = read('components/PublicRegistration.css');
    expect(css).toContain('padding-top: env(safe-area-inset-top)');
    expect(css).toContain('padding: env(safe-area-inset-top) clamp(18px, 3vw, 28px) 0');
  });
});
