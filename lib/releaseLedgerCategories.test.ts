// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publisher = readFileSync(new URL('../deploy/vps/release.sh', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20260914205041_private_asaas_payment_adjudication.sql', import.meta.url), 'utf8');
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('release ledger category contract', () => {
  for (const [alias, writer, category, ordinary, contribution] of [
    ['ledger', 'v_category', 'RECEBIMENTO_NAO_CLASSIFICADO', 'MENSALIDADE', 'aporte_ou_movimentacao'],
    ['refund', 'v_refund_category', 'ESTORNO_RECEBIMENTO_NAO_CLASSIFICADO', 'ESTORNO_MENSALIDADE', 'estorno_aporte_ou_movimentacao'],
  ]) {
    it(`${alias}: keeps the exact unclassified provenance predicate used by the writer`, () => {
      const branch = migration.match(new RegExp(`\\$replacement\\$${writer} := case([\\s\\S]*?)\\$replacement\\$`))?.[1];
      expect(branch).toBeTruthy();
      const expectedBranch = normalize(branch!.replace(/\bnew\./g, 'payment.'));
      const actual = publisher.match(new RegExp(`${alias}\\.category is distinct from case([\\s\\S]*?)\\n        end`))?.[1];
      expect(actual).toBeTruthy();
      expect(normalize(actual!)).toBe(`${expectedBranch} when payment.status = 'NAO_RECEITA' then '${contribution}' else '${ordinary}'`);
      expect(expectedBranch).toContain("payment.payment_type = 'UNASSIGNED_RECEIPT'");
      expect(expectedBranch).toContain('payment.student_id is null');
      expect(expectedBranch).toContain("payment.raw_payload->>'source' = 'OPERATOR_ADJUDICATION'");
      expect(expectedBranch).toContain(`then '${category}'`);
    });
  }

  it('retains value, cent, receipt and refund safety checks', () => {
    for (const invariant of [
      "ledger.type <> 'ENTRADA'",
      'ledger.amount is distinct from round(payment.value, 2)',
      'ledger.amount_cents is distinct from round(payment.value * 100)::integer',
      "refund.type <> 'SAIDA'",
      'refund.amount <= 0',
      'refund.provider_event_id is null',
      'receipt.student_payment_id = payment.id',
      "raise exception 'cash_payment_ledger_cardinality_invalid'",
    ]) expect(normalize(publisher)).toContain(invariant);
  });
});
