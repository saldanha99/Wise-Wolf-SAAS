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
